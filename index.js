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
    sendWithTimeout,
    backoffDelay,
} from './lib/pure.js'

// Re-export pure helpers so callers (and tests) can import them
// from the package root if they want.
export {
    parseDuration,
    humanizeMs,
    resolveAddresses,
    decideTiming,
    sendWithTimeout,
    backoffDelay,
} from './lib/pure.js'

// Postprocessor name — used in chain syntax (`welcome.html-mjml-email.hbs`)
// and as the `post-email` plugin identifier the dispatcher resolves.
export const output = 'eml'

// Table prefix follows the cross-repo plugin-table convention:
// strip `mikser-io-` from the package name, replace `-` with `_`,
// prepend `mikser_`. `mikser-io-post-email` → `mikser_post_email_*`.
registerSchema('post_email', `
    CREATE TABLE IF NOT EXISTS mikser_post_email_queue (
        id              TEXT PRIMARY KEY REFERENCES mikser_entities(id) ON DELETE CASCADE,
        eml_path        TEXT NOT NULL,
        eml_hash        TEXT,
        -- The message as fields (JSON), which is how it is DELIVERED.
        --
        -- Not the .eml on disk: that is an audit artifact, and re-reading it
        -- to send a raw message made delivery depend both on the output tree
        -- still holding the file (a --clear, or a deploy rsync with --delete,
        -- removes it) and on the transport honouring nodemailer's raw field
        -- at all. Mailgun's does not: nodemailer-mailgun-transport applies a
        -- key whitelist with no raw in it, so the field is dropped and what
        -- reaches the API has no sender, no recipient and no body.
        --
        -- Cleared on delivery; a sent row does not need to keep the body.
        payload         TEXT,
        -- When delivery was ASKED for. maxDelay is measured from it, so it is
        -- never moved once written.
        send_at         INTEGER NOT NULL,
        -- When the next attempt may run. Set by a failed attempt's backoff;
        -- separate from send_at precisely so backing off cannot make a row
        -- that keeps failing look permanently on-time and never expire.
        next_attempt_at INTEGER,
        sent_at         INTEGER,
        expired_at      INTEGER,
        attempts        INTEGER NOT NULL DEFAULT 0,
        last_error      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_mikser_post_email_queue_due
        ON mikser_post_email_queue (send_at)
        WHERE sent_at IS NULL AND expired_at IS NULL;
`)

const DEFAULT_MAX_DELAY_MS    = 60 * 60 * 1000              // 1h
const DEFAULT_RETENTION_MS    = 90 * 24 * 60 * 60 * 1000    // 90d
const DEFAULT_SEND_TIMEOUT_MS = 30 * 1000                   // per message
const DRAIN_INTERVAL_MS       = 60 * 1000                   // while resident
const BACKOFF_BASE_MS         = 60 * 1000                   // 1st retry
const BACKOFF_MAX_MS          = 15 * 60 * 1000              // ceiling

// Per-config closures populate this on onLoaded. Module-level so the
// postprocess() call (which is per-entity, may run on workers in
// theory but in practice INLINE for this plugin) and the drain timer
// share the same transport handle.
let transport = null
let drainTimer = null

// The drain is SINGLE-FLIGHT, and has to be: a pass delivers sequentially and
// only marks a row sent once the transport has answered, so a second pass
// starting while the first is still in flight selects the same unmarked rows
// and delivers them a second time. There are two callers (the timer, and
// onFinalized for one-shot builds) and a backlog can easily outlast the 60s
// interval — 1515 queued messages did, on gpoint.bg.
let draining = false

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

function upsertQueueRow({ id, emlPath, emlHash, sendAt, payload }) {
    useDatabase().handle.prepare(`
        INSERT INTO mikser_post_email_queue (id, eml_path, eml_hash, payload, send_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            send_at         = excluded.send_at,
            eml_path        = excluded.eml_path,
            eml_hash        = excluded.eml_hash,
            payload         = excluded.payload,
            sent_at         = NULL,
            expired_at      = NULL,
            next_attempt_at = NULL,
            attempts        = 0,
            last_error      = NULL
    `).run(id, emlPath, emlHash, payload == null ? null : JSON.stringify(payload), sendAt)
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

// `payload` is released here: the row stays for its retention window as a
// record that this id was delivered, and a delivered message body has no
// further use — keeping every rendered email in the cache DB for 90 days does.
function markSent(id)        { useDatabase().handle.prepare(`UPDATE mikser_post_email_queue SET sent_at = ?, payload = NULL WHERE id = ?`).run(Date.now(), id) }
// payload released for the same reason as in markSent — an expired row is
// never delivered, so holding its body for the retention window is pure cost.
function markExpired(id, r)  { useDatabase().handle.prepare(`UPDATE mikser_post_email_queue SET expired_at = ?, last_error = ?, payload = NULL WHERE id = ?`).run(Date.now(), r, id) }
// A failed attempt stays queued, but not due again immediately. Retrying a
// flapping provider every 60s only multiplies the load on it, and for an
// attempt that TIMED OUT rather than been refused it multiplies the
// duplicates — the message may well have gone out. So back off exponentially
// in `next_attempt_at` and leave `send_at` untouched: `send_at` is the
// delivery intent and maxDelay is measured from it, so moving it would make a
// row that keeps failing look permanently on-time and never expire.
//
// Returns the delay it set, for the caller to log.
function markFailed(id, err) {
    const row = useDatabase().handle
        .prepare(`SELECT attempts FROM mikser_post_email_queue WHERE id = ?`).get(id)
    const delay = backoffDelay({ attempts: row?.attempts, baseMs: BACKOFF_BASE_MS, maxMs: BACKOFF_MAX_MS })
    useDatabase().handle.prepare(`
        UPDATE mikser_post_email_queue
        SET attempts = attempts + 1, last_error = ?, next_attempt_at = ?
        WHERE id = ?
    `).run(err.message || String(err), Date.now() + delay, id)
    return delay
}

// Hand one message to the transport under a per-message timeout — see
// sendWithTimeout in lib/pure.js for why an unbounded send is not an option.
// `sendTimeout: 0` opts out.
function sendMailWithTimeout({ config, payload }) {
    return sendWithTimeout({
        send: message => transport.sendMail(message),
        payload,
        timeoutMs: parseDuration(config.sendTimeout, DEFAULT_SEND_TIMEOUT_MS),
    })
}

// What to hand the transport for a queued row: the stored fields, or — for a
// row queued by a version that did not store them — the composed .eml re-read
// from disk. That fallback is best-effort by nature: it survives only while
// the file is still in the output tree, and only reaches the provider intact
// on a transport that honours `raw`, which SMTP does and Mailgun's does not.
async function deliveryPayload({ row, logger }) {
    if (row.payload) return JSON.parse(row.payload)

    logger.warn(
        'postEmail: %s was queued before the message payload was stored — falling back to its .eml. ' +
        'A transport that ignores `raw` (Mailgun) will reject it; re-render the entity to requeue it properly.',
        row.id)

    const emlAbs = path.isAbsolute(row.eml_path)
        ? row.eml_path
        : path.join(runtime.options.outputFolder, row.eml_path)
    return { raw: await readFile(emlAbs) }
}

// Drain the queue: deliver due rows that are still within maxDelay,
// expire the overdue ones. Failed deliveries stay queued for retry.
//
// Serialised — see `draining`. Overlapping passes double-send.
async function drain({ config, logger }) {
    if (draining) {
        logger.debug('postEmail: a drain is already in flight, skipping this pass')
        return
    }
    draining = true
    try {
        await drainQueue({ config, logger })
    } finally {
        draining = false
    }
}

async function drainQueue({ config, logger }) {
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
        SELECT id, eml_path, eml_hash, payload, send_at FROM mikser_post_email_queue
        WHERE sent_at IS NULL AND expired_at IS NULL AND send_at <= ?
          AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        ORDER BY send_at
    `).all(now, now)

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
            const payload = await deliveryPayload({ row, logger })
            if (config.dryRun) {
                logger.info('postEmail: [dryRun] would deliver %s', row.id)
                markSent(row.id)
            } else {
                await sendMailWithTimeout({ config, payload })
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
            const delay = markFailed(row.id, err)
            logger.error('postEmail: delivery failed for %s, retrying in %s — %s',
                row.id, humanizeMs(delay), err.message || err)
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

    if (timing.mode === 'expired') {
        const reason = `overdue by ${humanizeMs(timing.overdueMs)}, past maxDelay ${humanizeMs(maxDelayMs)}`
        recordExpiredInBand({ id: entity.id, emlPath: entity.destination, sendAt: timing.sendAt, reason })
        logger.warn('postEmail: %s expired in-band — %s', entity.id, reason)
        return { success: true, result: entity.destination }
    }

    // Both 'now' and 'queue' go through the queue. NOTHING is delivered from
    // here any more.
    //
    // `postprocess` runs INSIDE the render pipeline. 'now' used to await
    // transport.sendMail() right here, which made two things true that should
    // never have been:
    //
    //   1. Every cycle waited on a third-party service. A build could not
    //      finish until the provider had answered for every message in it —
    //      1515 sequential Mailgun round-trips, in one case, inside the
    //      pipeline, while the site's own requests queued behind it.
    //   2. The provider could FAIL THE BUILD. A rejection — a 429, an
    //      outage, a socket that never answered — threw out of postprocess
    //      and failed the entity, so a provider having a bad minute became a
    //      broken render, with no retry: the marker was never written, so the
    //      next cycle simply tried again with no backoff.
    //
    // A row costs one sqlite insert and buys what the inline path never had:
    // delivery that survives a crash mid-cycle, retries with backoff, a
    // bounded per-message timeout, and a render that never waits on mail.
    //
    // Delivery promptness is preserved at both ends. A one-shot build drains
    // at onFinalized, so `mikser` still sends before it exits. A resident
    // instance drains on the timer, off the cycle, within DRAIN_INTERVAL_MS.
    upsertQueueRow({
        id: entity.id,
        emlPath: entity.destination,
        emlHash: hash,
        payload: { from, to, cc, bcc, subject, html },
        sendAt: timing.sendAt,
    })
    if (timing.mode === 'now') {
        logger.info('postEmail: queued %s for immediate delivery', entity.id)
    } else {
        logger.info('postEmail: queued %s for %s', entity.id, new Date(timing.sendAt).toISOString())
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

        // Bring an older queue table up to date. CREATE TABLE IF NOT EXISTS
        // will not add a column to a table that already exists, so each one
        // added since needs its own ALTER.
        //
        // Only "already there" is expected and silent. Anything else — a
        // locked or read-only database — must be said out loud: swallowing it
        // leaves the table without the column, and the failure resurfaces
        // later as an opaque "no column named …" from an INSERT inside
        // postprocess, far from its cause.
        for (const column of ['eml_hash TEXT', 'payload TEXT', 'next_attempt_at INTEGER']) {
            try {
                const db = useDatabase()
                if (db?.isOpen) db.handle.exec(`ALTER TABLE mikser_post_email_queue ADD COLUMN ${column}`)
            } catch (err) {
                if (!/duplicate column/i.test(err.message || '')) {
                    logger.error('postEmail: could not add the %s column — %s', column, err.message || err)
                }
            }
        }

        // The timer is what makes delivery out-of-band, so it has to run
        // whenever this process stays up — `--server` as much as `--watch`.
        // Gated on `watch` alone it was missing from the configuration that
        // needs it most: a production `--server` instance (no watcher, which
        // is how gpoint-cms runs) had no timer at all, so a queued message
        // waited for the end of the next cycle and, after the last cycle,
        // waited indefinitely.
        //
        // Matches how core decides the same thing — see the residency check
        // in mikser-io's src/instance.js.
        const resident = runtime.options.watch || runtime.options.server
        if (resident && !drainTimer) {
            drainTimer = setInterval(() => {
                drain({ config, logger }).catch(err => {
                    logger.error('postEmail: drain failed (timer) — %s', err.message || err)
                })
            }, DRAIN_INTERVAL_MS)
            drainTimer.unref?.()
        }

        onFinalized(async () => {
            // A one-shot build has no timer and exits after finalize, so the
            // queue MUST be drained here or its mail is never sent.
            //
            // When a timer owns delivery, this must NOT drain: onFinalized is
            // awaited inside the cycle, so draining here would put the
            // third-party transport straight back on the critical path — the
            // coupling the queue exists to break.
            //
            // Keyed on the timer actually existing rather than on residency,
            // so the two conditions cannot disagree and strand the queue with
            // neither draining it.
            if (drainTimer) return
            try {
                await drain({ config, logger })
            } catch (err) {
                logger.error('postEmail: drain failed (onFinalized) — %s', err.message || err)
            }
        })

        // One drain at startup, to catch whatever came due while mikser was
        // off. Awaited only when nothing else will drain: a resident instance
        // gets this fired and forgotten, because awaiting it here is how a
        // restart with a backlog spent its boot inside the transport —
        // 1515 messages, one at a time, before the first cycle ran.
        if (drainTimer) {
            drain({ config, logger }).catch(err => {
                logger.error('postEmail: startup drain failed — %s', err.message || err)
            })
        } else {
            try {
                await drain({ config, logger })
            } catch (err) {
                logger.error('postEmail: startup drain failed — %s', err.message || err)
            }
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
        postprocess, module: import.meta.url,
    }
}
