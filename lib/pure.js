// Pure helpers — no mikser-io, no nodemailer, no sqlite imports.
// Kept separate so unit tests don't have to load the engine.
// (node:crypto is a built-in and deterministic, so it stays "pure".)
import { createHash } from 'node:crypto'

export function parseDuration(value, fallback) {
    if (value == null) return fallback
    if (typeof value === 'number') return value
    const m = /^\s*(\d+)\s*(ms|s|m|h|d)\s*$/i.exec(String(value))
    if (!m) throw new Error(`Invalid duration: ${value} (expected e.g. "1h", "30m", "90d")`)
    const n = Number(m[1])
    const u = m[2].toLowerCase()
    return n * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[u])
}

export function humanizeMs(ms) {
    if (ms < 0) ms = -ms
    if (ms < 1000) return `${ms}ms`
    const s = Math.round(ms / 1000)
    if (s < 60) return `${s}s`
    const m = Math.round(s / 60)
    if (m < 60) return `${m}m`
    const h = Math.round(m / 60)
    if (h < 48) return `${h}h`
    return `${Math.round(h / 24)}d`
}

export async function resolveSpec(spec, ctx) {
    if (spec == null) return []
    if (typeof spec === 'function') spec = await spec(ctx)
    const list = Array.isArray(spec) ? spec : [spec]
    const out = []
    for (const raw of list) {
        if (raw == null || raw === '') continue
        if (typeof raw !== 'string') {
            throw new Error(`Recipient must be a string, got ${typeof raw}: ${JSON.stringify(raw)}`)
        }
        if (raw.startsWith('@')) {
            const name = raw.slice(1)
            const listSpec = ctx.lists?.[name]
            if (listSpec === undefined) {
                throw new Error(`Unknown recipient list "@${name}". Define it in postEmail({ lists: { ${name}: ... } }).`)
            }
            out.push(...await resolveSpec(listSpec, ctx))
        } else {
            out.push(raw)
        }
    }
    return out
}

export function dedupe(addresses) {
    const seen = new Set()
    const out = []
    for (const a of addresses) {
        const k = a.toLowerCase().trim()
        if (!k || seen.has(k)) continue
        seen.add(k)
        out.push(a)
    }
    return out
}

export async function resolveAddresses({ entity, config, ctx }) {
    const meta = entity.meta ?? {}
    const to  = dedupe(await resolveSpec(meta.to, ctx))
    const cc  = dedupe([
        ...await resolveSpec(meta.cc,  ctx),
        ...await resolveSpec(config.cc, ctx),
    ])
    const bcc = dedupe([
        ...await resolveSpec(meta.bcc, ctx),
        ...await resolveSpec(config.bcc, ctx),
    ])
    const from = meta.from ?? config.from
    if (!from) {
        throw new Error(`postEmail: no "from" address — set it in postEmail({from:...}) or entity frontmatter`)
    }
    return { from, to, cc, bcc, subject: meta.subject }
}

export function decideTiming({ meta, maxDelayMs, now = Date.now() }) {
    const raw = meta.sendAt
    if (raw == null || raw === 'now') return { mode: 'now', sendAt: now }

    const ts = typeof raw === 'number' ? raw : Date.parse(raw)
    if (Number.isNaN(ts)) {
        throw new Error(`postEmail: invalid sendAt "${raw}" (expected ISO 8601 or 'now')`)
    }
    if (ts > now)               return { mode: 'queue',   sendAt: ts }
    if (now - ts <= maxDelayMs) return { mode: 'now',     sendAt: ts }
    return                        { mode: 'expired', sendAt: ts, overdueMs: now - ts }
}

// ---------- send-once ledger (pure parts) ----------------------------
//
// A durable on-disk marker lets postEmail skip re-sending an email it
// already delivered — even after a mikser cache-wipe, which clears the
// queue table (its rows cascade off mikser_entities). Without this a
// rebuild re-renders every email document and re-fires it. These are the
// pure pieces; the fs lives in index.js (see sentFolder handling).

// `sendAt` is part of the delivery identity, but 'now' and "absent" mean
// the same thing, so they must normalize to the same value.
export function normalizeSendAt(value) {
    return (value == null || value === 'now') ? null : String(value)
}

// Stable content hash identifying a delivery. Deliberately NOT the
// composed .eml bytes: nodemailer stamps a fresh Message-ID and Date on
// every compose, so hashing the .eml would change on every build and
// defeat the guard. Hash the semantic fields — same submission ⇒ same
// hash, a genuinely edited one ⇒ new hash ⇒ resend.
//
// `sendAt` IS included: a recurring/rescheduled email keeps its id and
// its body and only moves its send time, and without it every occurrence
// after the first would hash identically and be suppressed — a silently
// lost email, which is worse than the duplicate this guard prevents.
//
// `deliveryKey` (entity frontmatter) pins the identity explicitly for
// templates whose rendered body is volatile — a timestamp, a random
// token, a cache-buster. Such a body hashes differently on every build,
// which would make the guard inert; naming a key opts out of hashing the
// body at all.
export function deliveryHash({ from, to, cc, bcc, subject, html, sendAt, deliveryKey }) {
    const norm = v => Array.isArray(v) ? v.join(',') : (v ?? '')
    const keyed = deliveryKey != null
    const payload = JSON.stringify({
        from: norm(from), to: norm(to), cc: norm(cc), bcc: norm(bcc),
        subject: subject ?? '',
        key: keyed ? String(deliveryKey) : null,
        html: keyed ? '' : (html ?? ''),
        sendAt: normalizeSendAt(sendAt),
    })
    return createHash('sha256').update(payload).digest('hex')
}

// One marker file per delivery identity.
//
// The sanitized id is for humans reading the folder; the appended digest
// is what makes the name UNIQUE. Sanitizing alone collides: every
// character outside the safe set becomes '_', so a fully non-ASCII id
// (Cyrillic document paths are normal here) collapses to a name that
// encodes only its length — '/бг/оферта' and '/бг/заявка' both became
// '__________.sent'. Colliding entities then overwrite each other's
// marker and BOTH re-send on every rebuild, defeating the guard, or —
// if their content matches — one is silently never sent.
//
// Also bounded: ids can be long and most filesystems cap a name at 255
// bytes. The digest is taken from the raw id, so truncation cannot
// merge two distinct ids.
export function markerName(id) {
    const raw = String(id)
    const safe = raw.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)
    const digest = createHash('sha256').update(raw).digest('hex').slice(0, 12)
    return `${safe}-${digest}.sent`
}

// Marker body: "<revision>:<hash>". Bumping config.revision invalidates
// every marker at once (force-resend), mirroring the assets preset's
// `revision` export.
export function formatMarker(revision, hash) {
    return `${revision}:${hash}`
}

// "Already delivered this exact content, at or above the current
// revision?" — the decision a marker body encodes.
export function isDelivered(markerBody, revision, hash) {
    if (typeof markerBody !== 'string') return false
    const idx = markerBody.indexOf(':')
    if (idx === -1) return false
    const rev = Number.parseInt(markerBody.slice(0, idx), 10)
    const stored = markerBody.slice(idx + 1)
    return Number.isFinite(rev) && rev >= revision && stored === hash
}
