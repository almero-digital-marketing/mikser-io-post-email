// Pure helpers — no mikser-io, no nodemailer, no sqlite imports.
// Kept separate so unit tests don't have to load the engine.

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
