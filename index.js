import path from 'node:path'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
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
    deliveryHash,
    markerName,
    formatMarker,
    isDelivered,
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
        eml_hash    TEXT,
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

// ---------- send-once ledger -----------------------------------------
//
// Durable on-disk delivery markers, so a rebuild never re-sends an email
// already delivered. The queue table can't gate this: mikser wipes its
// cache on a config change, and the queue rows cascade off
// mikser_entities — both drop sent state, and every submission then
// re-renders and re-fires. So the marker lives OUTSIDE the cache, in a
// dedicated folder (default `emails/` under the working folder,
// overridable via `sentFolder`). Mirrors the assets plugin's `.md5`
// sidecars. Keep this folder out of source control and out of the
// deploy's delete set.
const DEFAULT_SENT_FOLDER = 'emails'

function sentFolder(config) {
    const folder = config.sentFolder ?? DEFAULT_SENT_FOLDER
    return path.isAbsolute(folder)
        ? folder
        : path.join(runtime.options.workingFolder, folder)
}

function markerFile(config, id) {
    return path.join(sentFolder(config), markerName(id))
}

// Has this exact content (at/above the current revision) already been
// delivered for this id? Disk is the source of truth — it survives the
// cache-wipe that the DB does not.
async function alreadySent(config, id, hash) {
    const file = markerFile(config, id)
    if (!existsSync(file)) return false
    try {
        return isDelivered(await readFile(file, 'utf8'), config.revision ?? 1, hash)
    } catch {
        return false
    }
}

async function recordSent(config, id, hash) {
    const file = markerFile(config, id)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, formatMarker(config.revision ?? 1, hash))
}

// Record the marker AFTER the mail is already out, where a failure must
// never look like a delivery failure: the message has been handed to the
// transport and cannot be unsent. Losing the marker only risks a future
// duplicate (and only after a cache-wipe); treating it as a send failure
// would guarantee one — the queue path would keep the row due and
// re-deliver every drain, and the inline path would report a render
// failure for mail that was actually delivered. So: warn, don't throw.
async function recordSentSafely(config, id, hash, logger) {
    try {
        await recordSent(config, id, hash)
    } catch (err) {
        logger.warn(
            'postEmail: %s delivered but its send-once marker could not be written in %s — %s. ' +
            'A later rebuild may re-send it; check the folder exists and is writable.',
            id, sentFolder(config), err.message || err)
    }
}

// ---------- queue ops ------------------------------------------------

function upsertQueueRow({ id, emlPath, emlHash, sendAt }) {
    useDatabase().handle.prepare(`
        INSERT INTO mikser_post_email_queue (id, eml_path, eml_hash, send_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            send_at    = excluded.send_at,
            eml_path   = excluded.eml_path,
            eml_hash   = excluded.eml_hash,
            sent_at    = NULL,
            expired_at = NULL,
            attempts   = 0,
            last_error = NULL
    `).run(id, emlPath, emlHash, sendAt)
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
        SELECT id, eml_path, eml_hash, send_at FROM mikser_post_email_queue
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

        // Durable send-once guard: an on-disk marker means this exact
        // content was already delivered (survives the cache-wipe that
        // reset the row's sent_at). Mark sent and skip re-delivery.
        if (row.eml_hash && await alreadySent(config, row.id, row.eml_hash)) {
            markSent(row.id)
            logger.info('postEmail: %s already delivered, skipping', row.id)
            continue
        }

        // Rows queued by < 1.1.0 predate eml_hash, so they carry no
        // delivery identity and cannot be marked. They still send, but
        // say so: this one row may re-send once after the upgrade.
        if (!row.eml_hash) {
            logger.warn(
                'postEmail: %s was queued before send-once tracking existed — delivering without a marker, ' +
                'so a rebuild may re-send it once.', row.id)
        }

        try {
            const emlAbs = path.isAbsolute(row.eml_path)
                ? row.eml_path
                : path.join(runtime.options.outputFolder, row.eml_path)
            const raw = await readFile(emlAbs)
            if (config.dryRun) {
                logger.info('postEmail: [dryRun] would deliver %s', row.id)
                markSent(row.id)
            } else {
                await transport.sendMail({ raw })
                // Order matters: the mail is out, so retire the row FIRST.
                // If the marker write were inside this try and threw, the
                // catch below would markFailed() and leave the row due —
                // re-delivering the same message every drain (~every 60s
                // in watch mode) until it expires.
                markSent(row.id)
                if (row.eml_hash) await recordSentSafely(config, row.id, row.eml_hash, logger)
            }
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

    // Send-once identity for this delivery (semantic fields, not the .eml
    // bytes — those carry a fresh Message-ID/Date every compose).
    // sendAt is part of it, so a rescheduled occurrence of a recurring
    // email is a NEW delivery rather than a suppressed duplicate.
    const hash = deliveryHash({
        from, to, cc, bcc, subject, html,
        sendAt: entity.meta?.sendAt,
        deliveryKey: entity.meta?.deliveryKey,
    })

    // Already delivered this exact content? Skip delivery — whatever the
    // timing. The .eml audit file above is still refreshed; only the send
    // is suppressed. This is what stops a rebuild (e.g. after a
    // config-change cache-wipe) from re-firing the whole submission backlog.
    if (await alreadySent(config, entity.id, hash)) {
        logger.info('postEmail: %s already delivered, skipping', entity.id)
        return { success: true, result: entity.destination }
    }

    const maxDelayMs = parseDuration(entity.meta?.maxDelay ?? config.maxDelay, DEFAULT_MAX_DELAY_MS)
    const timing = decideTiming({ meta: entity.meta ?? {}, maxDelayMs })

    if (timing.mode === 'queue') {
        upsertQueueRow({ id: entity.id, emlPath: entity.destination, emlHash: hash, sendAt: timing.sendAt })
        logger.info('postEmail: queued %s for %s', entity.id, new Date(timing.sendAt).toISOString())
    } else if (timing.mode === 'expired') {
        const reason = `overdue by ${humanizeMs(timing.overdueMs)}, past maxDelay ${humanizeMs(maxDelayMs)}`
        recordExpiredInBand({ id: entity.id, emlPath: entity.destination, sendAt: timing.sendAt, reason })
        logger.warn('postEmail: %s expired in-band — %s', entity.id, reason)
    } else {
        // mode === 'now' — deliver synchronously, once.
        try {
            if (config.dryRun) {
                logger.info('postEmail: [dryRun] would deliver %s', entity.id)
            } else {
                await transport.sendMail({ from, to, cc, bcc, subject, html })
                // Outside the throw path on purpose — see recordSentSafely.
                await recordSentSafely(config, entity.id, hash, logger)
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

        // Migrate pre-1.1 installs: the queue table predates eml_hash, and
        // CREATE TABLE IF NOT EXISTS won't add a column to an existing one.
        //
        // Only "already there" is expected and silent. Anything else — a
        // locked or read-only database — must be said out loud: swallowing
        // it leaves the table without the column, and the failure resurfaces
        // later as an opaque "no column named eml_hash" from an INSERT
        // inside postprocess, far from its cause.
        try {
            const db = useDatabase()
            if (db?.isOpen) db.handle.exec(`ALTER TABLE mikser_post_email_queue ADD COLUMN eml_hash TEXT`)
        } catch (err) {
            if (!/duplicate column/i.test(err.message || '')) {
                logger.error('postEmail: could not add the eml_hash column — %s', err.message || err)
            }
        }

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

    // No `teardown` in the descriptor — deliberately. The engine calls
    // a postprocessor's teardown in a `finally` at the END OF EVERY
    // postprocess phase (once per cycle), which is right for plugins
    // that acquire per-cycle resources in a matching setup() (post-pdf's
    // Puppeteer browser). This plugin's `transport` + `drainTimer` are
    // PROCESS-LIFETIME — created once at onLoaded, no setup() to
    // recreate them — so a per-cycle teardown would null the transport
    // after the first cycle and every subsequent send would crash on a
    // null handle. Both resources die cleanly at process exit
    // (drainTimer is unref'd; the socket closes with the process).
    return {
        name: config.name ?? 'email',
        output,
        options: config,
        postprocess,
    }
}
