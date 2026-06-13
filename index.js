import path from 'node:path'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import nodemailer from 'nodemailer'
import {
    runtime,
    registerSchema,
    useDatabase,
    useLogger,
    onLoaded,
    onFinalized,
} from 'mikser-io'
import {
    parseDuration,
    humanizeMs,
    resolveAddresses,
    decideTiming,
} from './lib/pure.js'

// Re-export pure helpers so callers (and tests) can import them
// from the package root if they want.
export {
    parseDuration,
    humanizeMs,
    resolveAddresses,
    decideTiming,
} from './lib/pure.js'

// Postprocessor name — used in chain syntax (`welcome.html-mjml-email.hbs`)
// and as the `post-email` plugin identifier the dispatcher resolves.
export const output = 'eml'

// Table prefix follows the cross-repo plugin-table convention:
// strip `mikser-io-` from the package name, replace `-` with `_`,
// prepend `mikser_`. `mikser-io-post-email` → `mikser_post_email_*`.
registerSchema('post_email', `
    CREATE TABLE IF NOT EXISTS mikser_post_email_queue (
        id          TEXT PRIMARY KEY REFERENCES mikser_entities(id) ON DELETE CASCADE,
        eml_path    TEXT NOT NULL,
        send_at     INTEGER NOT NULL,
        sent_at     INTEGER,
        expired_at  INTEGER,
        attempts    INTEGER NOT NULL DEFAULT 0,
        last_error  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_mikser_post_email_queue_due
        ON mikser_post_email_queue (send_at)
        WHERE sent_at IS NULL AND expired_at IS NULL;
`)

const DEFAULT_MAX_DELAY_MS = 60 * 60 * 1000                 // 1h
const DEFAULT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000       // 90d
const DRAIN_INTERVAL_MS    = 60 * 1000                      // 60s in watch mode

// Per-config closures populate this on onLoaded. Module-level so the
// postprocess() call (which is per-entity, may run on workers in
// theory but in practice INLINE for this plugin) and the drain timer
// share the same transport handle.
let transport = null
let drainTimer = null

// ---------- EML composition + delivery -------------------------------

// Build the .eml bytes nodemailer would have handed SMTP. Used both
// for the on-disk audit file and (re-read) for queued deliveries.
async function composeEml({ from, to, cc, bcc, subject, html }) {
    const json = nodemailer.createTransport({ jsonTransport: true })
    const built = await json.sendMail({ from, to, cc, bcc, subject, html })
    return built.message
}

// ---------- queue ops ------------------------------------------------

function upsertQueueRow({ id, emlPath, sendAt }) {
    useDatabase().handle.prepare(`
        INSERT INTO mikser_post_email_queue (id, eml_path, send_at)
        VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            send_at    = excluded.send_at,
            eml_path   = excluded.eml_path,
            sent_at    = NULL,
            expired_at = NULL,
            attempts   = 0,
            last_error = NULL
    `).run(id, emlPath, sendAt)
}

function recordExpiredInBand({ id, emlPath, sendAt, reason }) {
    // Expired during the in-band path → no future delivery, but record
    // for observability. INSERT-or-UPDATE in case the entity was
    // already queued and reschedule arrived too late.
    useDatabase().handle.prepare(`
        INSERT INTO mikser_post_email_queue (id, eml_path, send_at, expired_at, last_error)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            send_at    = excluded.send_at,
            expired_at = excluded.expired_at,
            last_error = excluded.last_error
    `).run(id, emlPath, sendAt, Date.now(), reason)
}

function markSent(id)        { useDatabase().handle.prepare(`UPDATE mikser_post_email_queue SET sent_at = ? WHERE id = ?`).run(Date.now(), id) }
function markExpired(id, r)  { useDatabase().handle.prepare(`UPDATE mikser_post_email_queue SET expired_at = ?, last_error = ? WHERE id = ?`).run(Date.now(), r, id) }
function markFailed(id, err) { useDatabase().handle.prepare(`UPDATE mikser_post_email_queue SET attempts = attempts + 1, last_error = ? WHERE id = ?`).run(err.message || String(err), id) }

// Drain the queue: deliver due rows that are still within maxDelay,
// expire the overdue ones. Failed deliveries stay queued for retry.
async function drain({ config, logger }) {
    const db = useDatabase()
    if (!db?.isOpen) return

    const maxDelayMs  = parseDuration(config.maxDelay,  DEFAULT_MAX_DELAY_MS)
    const retentionMs = parseDuration(config.retention, DEFAULT_RETENTION_MS)
    const now = Date.now()

    // Retention prune (best-effort, runs every drain).
    db.handle.prepare(`
        DELETE FROM mikser_post_email_queue
        WHERE (sent_at    IS NOT NULL AND sent_at    < ?)
           OR (expired_at IS NOT NULL AND expired_at < ?)
    `).run(now - retentionMs, now - retentionMs)

    const due = db.handle.prepare(`
        SELECT id, eml_path, send_at FROM mikser_post_email_queue
        WHERE sent_at IS NULL AND expired_at IS NULL AND send_at <= ?
        ORDER BY send_at
    `).all(now)

    for (const row of due) {
        // Cascade-race guard: catalog delete may have fired between
        // SELECT and now. Re-check before sending.
        const stillThere = db.handle.prepare(`SELECT 1 FROM mikser_post_email_queue WHERE id = ?`).get(row.id)
        if (!stillThere) continue

        const overdueMs = now - row.send_at
        if (overdueMs > maxDelayMs) {
            const reason = `overdue by ${humanizeMs(overdueMs)}, past maxDelay ${humanizeMs(maxDelayMs)}`
            markExpired(row.id, reason)
            logger.warn('postEmail: %s expired — %s', row.id, reason)
            continue
        }

        try {
            const emlAbs = path.isAbsolute(row.eml_path)
                ? row.eml_path
                : path.join(runtime.options.outputFolder, row.eml_path)
            const raw = await readFile(emlAbs)
            if (config.dryRun) {
                logger.info('postEmail: [dryRun] would deliver %s', row.id)
            } else {
                await transport.sendMail({ raw })
            }
            markSent(row.id)
            logger.info('postEmail: delivered %s', row.id)
        } catch (err) {
            markFailed(row.id, err)
            logger.error('postEmail: delivery failed for %s — %s', row.id, err.message || err)
        }
    }
}

// ---------- postprocess entrypoint -----------------------------------

// `options` here is the ENGINE options bag (outputFolder, watch, etc).
// `config`  here is the PLUGIN options the factory was called with
// (lists, from, transport, maxDelay, dryRun, ...).
export async function postprocess({ entity, options, config, logger }) {
    const sourcePath = path.join(options.outputFolder, entity.origin)
    const outputPath = path.join(options.outputFolder, entity.destination)
    const html = await readFile(sourcePath, 'utf8')

    if (!entity.meta?.to) {
        throw new Error(`postEmail: ${entity.id} has no "to" — set entity frontmatter`)
    }

    const ctx = { entity, runtime, config, lists: config.lists ?? {}, logger }
    const { from, to, cc, bcc, subject } = await resolveAddresses({ entity, config, ctx })

    await mkdir(path.dirname(outputPath), { recursive: true })

    if (!to.length) {
        // Empty resolved list — write a marker EML and skip delivery.
        // Valid case: language-filtered list returns no subscribers.
        logger.debug('postEmail: %s resolved to no recipients, skipping delivery', entity.id)
        await writeFile(outputPath, '')
        return { success: true, result: entity.destination }
    }

    const eml = await composeEml({ from, to, cc, bcc, subject, html })
    await writeFile(outputPath, eml)

    const maxDelayMs = parseDuration(entity.meta?.maxDelay ?? config.maxDelay, DEFAULT_MAX_DELAY_MS)
    const timing = decideTiming({ meta: entity.meta ?? {}, maxDelayMs })

    if (timing.mode === 'queue') {
        upsertQueueRow({ id: entity.id, emlPath: entity.destination, sendAt: timing.sendAt })
        logger.info('postEmail: queued %s for %s', entity.id, new Date(timing.sendAt).toISOString())
    } else if (timing.mode === 'expired') {
        const reason = `overdue by ${humanizeMs(timing.overdueMs)}, past maxDelay ${humanizeMs(maxDelayMs)}`
        recordExpiredInBand({ id: entity.id, emlPath: entity.destination, sendAt: timing.sendAt, reason })
        logger.warn('postEmail: %s expired in-band — %s', entity.id, reason)
    } else {
        // mode === 'now' — deliver synchronously.
        try {
            if (config.dryRun) {
                logger.info('postEmail: [dryRun] would deliver %s', entity.id)
            } else {
                await transport.sendMail({ from, to, cc, bcc, subject, html })
            }
            logger.info('postEmail: delivered %s', entity.id)
        } catch (err) {
            logger.error('postEmail: delivery failed for %s — %s', entity.id, err.message || err)
            throw err
        }
    }

    return { success: true, result: entity.destination }
}

// ---------- v9 factory + lifecycle wiring -----------------------------

export function postEmail(config = {}) {
    // Lifecycle wiring is a side-effect of the factory call. The
    // returned descriptor is the postprocessor itself.
    onLoaded(async () => {
        const logger = useLogger()
        transport = nodemailer.createTransport(config.transport ?? { jsonTransport: true })

        onFinalized(async () => {
            try {
                await drain({ config, logger })
            } catch (err) {
                logger.error('postEmail: drain failed (onFinalized) — %s', err.message || err)
            }
        })

        if (runtime.options.watch && !drainTimer) {
            drainTimer = setInterval(() => {
                drain({ config, logger }).catch(err => {
                    logger.error('postEmail: drain failed (timer) — %s', err.message || err)
                })
            }, DRAIN_INTERVAL_MS)
            drainTimer.unref?.()
        }

        // Run one drain at startup to catch anything that came due
        // while mikser was off. Wrapped so a startup-time delivery
        // failure doesn't crash the boot.
        try {
            await drain({ config, logger })
        } catch (err) {
            logger.error('postEmail: startup drain failed — %s', err.message || err)
        }
    })

    return {
        name: config.name ?? 'email',
        output,
        options: config,
        postprocess,
        teardown,
    }
}

export async function teardown() {
    if (drainTimer) {
        clearInterval(drainTimer)
        drainTimer = null
    }
    if (transport?.close) {
        try { transport.close() } catch { /* not all transports expose close */ }
    }
    transport = null
}
