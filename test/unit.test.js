// Pure-logic tests for postEmail. No engine, no nodemailer transport,
// no sqlite — just the resolution + decision-tree functions.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
    parseDuration, humanizeMs,
    resolveSpec, dedupe, resolveAddresses,
    decideTiming,
    deliveryHash, markerName, formatMarker, isDelivered, normalizeSendAt,
    sendWithTimeout, backoffDelay,
} from '../lib/pure.js'

describe('parseDuration', () => {
    it('returns fallback on null', () => {
        assert.equal(parseDuration(null, 42), 42)
    })
    it('passes through numbers', () => {
        assert.equal(parseDuration(1234), 1234)
    })
    it('parses suffixed strings', () => {
        assert.equal(parseDuration('500ms'), 500)
        assert.equal(parseDuration('10s'),   10_000)
        assert.equal(parseDuration('30m'),   1_800_000)
        assert.equal(parseDuration('1h'),    3_600_000)
        assert.equal(parseDuration('2d'),    172_800_000)
    })
    it('throws on garbage', () => {
        assert.throws(() => parseDuration('soon'))
        assert.throws(() => parseDuration('1week'))
    })
})

describe('humanizeMs', () => {
    it('chooses appropriate units', () => {
        assert.equal(humanizeMs(500), '500ms')
        assert.equal(humanizeMs(2_500), '3s')
        assert.equal(humanizeMs(120_000), '2m')
        assert.equal(humanizeMs(3_600_000), '1h')
        assert.equal(humanizeMs(48 * 3_600_000), '2d')
    })
})

describe('resolveSpec', () => {
    const ctx = (lists = {}) => ({ entity: {}, runtime: {}, config: {}, lists, logger: { debug() {} } })

    it('returns [] for null', async () => {
        assert.deepEqual(await resolveSpec(null, ctx()), [])
    })
    it('passes literal address through', async () => {
        assert.deepEqual(await resolveSpec('a@x.com', ctx()), ['a@x.com'])
    })
    it('expands array of literals', async () => {
        assert.deepEqual(await resolveSpec(['a@x.com', 'b@y.com'], ctx()), ['a@x.com', 'b@y.com'])
    })
    it('expands @listname against options.lists', async () => {
        const r = await resolveSpec('@team', ctx({ team: ['a@x.com', 'b@y.com'] }))
        assert.deepEqual(r, ['a@x.com', 'b@y.com'])
    })
    it('expands listname when value is a function', async () => {
        const r = await resolveSpec('@subs', ctx({ subs: async () => ['c@z.com'] }))
        assert.deepEqual(r, ['c@z.com'])
    })
    it('mixes literals and @lists', async () => {
        const r = await resolveSpec(['@team', 'extra@me.com'], ctx({ team: ['a@x.com'] }))
        assert.deepEqual(r, ['a@x.com', 'extra@me.com'])
    })
    it('recurses into nested @-references', async () => {
        const r = await resolveSpec('@outer', ctx({
            outer: ['@inner', 'top@x.com'],
            inner: ['a@x.com', 'b@x.com'],
        }))
        assert.deepEqual(r, ['a@x.com', 'b@x.com', 'top@x.com'])
    })
    it('throws on unknown @listname', async () => {
        await assert.rejects(
            () => resolveSpec('@nope', ctx()),
            /Unknown recipient list "@nope"/,
        )
    })
})

describe('dedupe', () => {
    it('removes case-insensitive duplicates', () => {
        assert.deepEqual(
            dedupe(['A@X.com', 'a@x.com', 'b@y.com']),
            ['A@X.com', 'b@y.com'],
        )
    })
    it('drops empty and whitespace', () => {
        assert.deepEqual(dedupe(['', '  ', 'a@x.com']), ['a@x.com'])
    })
})

describe('resolveAddresses', () => {
    const entity = (meta) => ({ id: '/x', meta })
    const ctx = (lists) => ({ runtime: {}, lists, logger: { debug() {} } })

    it('to is exclusive to the entity (no options fallback)', async () => {
        const r = await resolveAddresses({
            entity: entity({ to: 'alice@acme.com' }),
            config: { from: 'me@x.com', cc: ['audit@x.com'] },
            ctx: { ...ctx(), config: {} },
        })
        assert.deepEqual(r.to, ['alice@acme.com'])
        assert.deepEqual(r.cc, ['audit@x.com'])
        assert.equal(r.from, 'me@x.com')
    })
    it('cc/bcc are additive between entity and options', async () => {
        const r = await resolveAddresses({
            entity: entity({ to: 'a@x.com', cc: ['per@entity.com'], bcc: ['x@y.com'] }),
            config: { from: 'me@x.com', cc: ['from@options.com'], bcc: ['x@y.com', 'z@y.com'] },
            ctx: { ...ctx(), config: {} },
        })
        assert.deepEqual(r.cc, ['per@entity.com', 'from@options.com'])
        assert.deepEqual(r.bcc, ['x@y.com', 'z@y.com'])   // deduped across both
    })
    it('expands @listname references in any field', async () => {
        const r = await resolveAddresses({
            entity: entity({ to: '@subs' }),
            config: { from: 'me@x.com', bcc: ['@audit'] },
            ctx: { ...ctx({ subs: ['a@x.com', 'b@x.com'], audit: ['log@x.com'] }), config: {} },
        })
        assert.deepEqual(r.to,  ['a@x.com', 'b@x.com'])
        assert.deepEqual(r.bcc, ['log@x.com'])
    })
    it('frontmatter from beats options from', async () => {
        const r = await resolveAddresses({
            entity: entity({ to: 'a@x.com', from: 'override@x.com' }),
            config: { from: 'default@x.com' },
            ctx: { ...ctx(), config: {} },
        })
        assert.equal(r.from, 'override@x.com')
    })
    it('throws when from is missing entirely', async () => {
        await assert.rejects(
            () => resolveAddresses({
                entity: entity({ to: 'a@x.com' }),
                config: {},
                ctx: { ...ctx(), config: {} },
            }),
            /no "from" address/,
        )
    })
})

describe('decideTiming', () => {
    const now = 1_700_000_000_000   // fixed ts to avoid Date.now-based flake
    const oneHour = 3_600_000

    it('missing sendAt → now', () => {
        const r = decideTiming({ meta: {}, maxDelayMs: oneHour, now })
        assert.equal(r.mode, 'now')
        assert.equal(r.sendAt, now)
    })
    it('"now" literal → now', () => {
        const r = decideTiming({ meta: { sendAt: 'now' }, maxDelayMs: oneHour, now })
        assert.equal(r.mode, 'now')
    })
    it('future ISO → queue', () => {
        const r = decideTiming({ meta: { sendAt: new Date(now + 86_400_000).toISOString() }, maxDelayMs: oneHour, now })
        assert.equal(r.mode, 'queue')
        assert.equal(r.sendAt, now + 86_400_000)
    })
    it('past within maxDelay → now (catch-up)', () => {
        const r = decideTiming({ meta: { sendAt: new Date(now - 30 * 60_000).toISOString() }, maxDelayMs: oneHour, now })
        assert.equal(r.mode, 'now')
    })
    it('past beyond maxDelay → expired', () => {
        const r = decideTiming({ meta: { sendAt: new Date(now - 2 * oneHour).toISOString() }, maxDelayMs: oneHour, now })
        assert.equal(r.mode, 'expired')
        assert.ok(r.overdueMs > oneHour)
    })
    it('garbage sendAt throws', () => {
        assert.throws(() => decideTiming({ meta: { sendAt: 'soon' }, maxDelayMs: oneHour, now }))
    })
})

describe('deliveryHash', () => {
    const base = { from: 'me@x.com', to: 'a@x.com', subject: 'Hi', html: '<p>hi</p>' }
    it('is deterministic for the same content', () => {
        assert.equal(deliveryHash(base), deliveryHash({ ...base }))
    })
    it('changes when subject or body changes', () => {
        assert.notEqual(deliveryHash(base), deliveryHash({ ...base, subject: 'Hi!' }))
        assert.notEqual(deliveryHash(base), deliveryHash({ ...base, html: '<p>bye</p>' }))
    })
    it('treats array and joined-string recipients the same', () => {
        assert.equal(
            deliveryHash({ ...base, to: ['a@x.com', 'b@x.com'] }),
            deliveryHash({ ...base, to: 'a@x.com,b@x.com' }),
        )
    })
    it('returns a 64-char hex sha256', () => {
        assert.match(deliveryHash(base), /^[0-9a-f]{64}$/)
    })
})

describe('normalizeSendAt', () => {
    it('treats absent and "now" as the same immediate send', () => {
        assert.equal(normalizeSendAt(undefined), null)
        assert.equal(normalizeSendAt(null), null)
        assert.equal(normalizeSendAt('now'), null)
    })
    it('keeps a real timestamp', () => {
        assert.equal(normalizeSendAt('2026-09-01T10:00:00Z'), '2026-09-01T10:00:00Z')
        assert.equal(normalizeSendAt(1_700_000_000_000), '1700000000000')
    })
})

describe('deliveryHash — sendAt is part of the identity', () => {
    const base = { from: 'me@x.com', to: 'a@x.com', subject: 'Weekly digest', html: '<p>same</p>' }

    // Regression: a recurring email keeps its id, recipients and body and
    // only moves sendAt. Hashing without sendAt made every occurrence after
    // the first look already-delivered, so it was silently never sent.
    it('a rescheduled occurrence of identical content is a NEW delivery', () => {
        const week1 = deliveryHash({ ...base, sendAt: '2026-09-01T08:00:00Z' })
        const week2 = deliveryHash({ ...base, sendAt: '2026-09-08T08:00:00Z' })
        assert.notEqual(week1, week2)
    })
    it('the same occurrence still hashes stably (rebuild ⇒ no resend)', () => {
        const a = deliveryHash({ ...base, sendAt: '2026-09-01T08:00:00Z' })
        const b = deliveryHash({ ...base, sendAt: '2026-09-01T08:00:00Z' })
        assert.equal(a, b)
    })
    it('absent and "now" sendAt are equivalent', () => {
        assert.equal(deliveryHash(base), deliveryHash({ ...base, sendAt: 'now' }))
    })
})

describe('deliveryHash — deliveryKey pins volatile bodies', () => {
    const base = { from: 'me@x.com', to: 'a@x.com', subject: 'Receipt' }

    it('a changing body does not change the hash when a key is set', () => {
        const a = deliveryHash({ ...base, html: '<p>generated 10:00:01</p>', deliveryKey: 'receipt-42' })
        const b = deliveryHash({ ...base, html: '<p>generated 23:59:59</p>', deliveryKey: 'receipt-42' })
        assert.equal(a, b)
    })
    it('a different key is a different delivery', () => {
        const a = deliveryHash({ ...base, html: '<p>x</p>', deliveryKey: 'receipt-42' })
        const b = deliveryHash({ ...base, html: '<p>x</p>', deliveryKey: 'receipt-43' })
        assert.notEqual(a, b)
    })
    it('without a key the body still counts', () => {
        assert.notEqual(
            deliveryHash({ ...base, html: '<p>a</p>' }),
            deliveryHash({ ...base, html: '<p>b</p>' }),
        )
    })
})

describe('markerName', () => {
    it('keeps a readable prefix and appends a disambiguating digest', () => {
        assert.match(markerName('/franchise/123-request'), /^_franchise_123-request-[0-9a-f]{12}\.sent$/)
    })

    // Regression: sanitizing alone mapped every unsafe char to '_', so ids
    // that differ only in unsafe characters — including any two same-length
    // Cyrillic paths — produced ONE marker file. Colliding entities then
    // overwrote each other and both re-sent on every rebuild.
    it('does not collide for same-length non-ASCII ids', () => {
        assert.notEqual(markerName('/бг/оферта'), markerName('/бг/заявка'))
    })
    it('does not collide for ids differing only in unsafe characters', () => {
        assert.notEqual(markerName('/mail/a:b'), markerName('/mail/a/b'))
    })
    it('is stable for the same id', () => {
        assert.equal(markerName('/mail/x'), markerName('/mail/x'))
    })
    it('bounds the filename for very long ids', () => {
        const name = markerName('/' + 'x'.repeat(500))
        assert.ok(name.length <= 140, `too long: ${name.length}`)
    })
    it('still separates long ids that share a truncated prefix', () => {
        const a = markerName('/' + 'x'.repeat(300) + 'a')
        const b = markerName('/' + 'x'.repeat(300) + 'b')
        assert.notEqual(a, b)
    })
})

describe('formatMarker / isDelivered', () => {
    const h = 'a'.repeat(64)
    it('round-trips a delivered marker', () => {
        assert.equal(isDelivered(formatMarker(1, h), 1, h), true)
    })
    it('treats a higher stored revision as delivered', () => {
        assert.equal(isDelivered(formatMarker(3, h), 2, h), true)
    })
    it('rejects a lower stored revision (force-resend on bump)', () => {
        assert.equal(isDelivered(formatMarker(1, h), 2, h), false)
    })
    it('rejects a different hash (content changed)', () => {
        assert.equal(isDelivered(formatMarker(1, h), 1, 'b'.repeat(64)), false)
    })
    it('rejects malformed or missing markers', () => {
        assert.equal(isDelivered('', 1, h), false)
        assert.equal(isDelivered('garbage', 1, h), false)
        assert.equal(isDelivered(undefined, 1, h), false)
    })
})

describe('sendWithTimeout', () => {
    it('passes the payload through and returns what the transport returned', async () => {
        const seen = []
        const result = await sendWithTimeout({
            send: async message => { seen.push(message); return { messageId: 'ok' } },
            payload: { to: ['a@example.com'] },
            timeoutMs: 1000,
        })
        assert.deepEqual(seen, [{ to: ['a@example.com'] }])
        assert.deepEqual(result, { messageId: 'ok' })
    })

    it('rejects when the transport does not answer in time', async () => {
        await assert.rejects(
            sendWithTimeout({
                send: () => new Promise(() => {}),   // never settles
                payload: {},
                timeoutMs: 20,
            }),
            /did not answer within/)
    })

    it('lets a real transport error through unchanged', async () => {
        await assert.rejects(
            sendWithTimeout({
                send: async () => { throw new Error('421 rate limited') },
                payload: {},
                timeoutMs: 1000,
            }),
            /421 rate limited/)
    })

    it('waits forever when the timeout is falsy', async () => {
        // Opting out must not wrap the call at all: a send that takes longer
        // than any plausible timeout still resolves.
        const result = await sendWithTimeout({
            send: () => new Promise(resolve => setTimeout(() => resolve('late'), 30)),
            payload: {},
            timeoutMs: 0,
        })
        assert.equal(result, 'late')
    })

    it('does not leave a pending timer behind on success', async () => {
        // A leaked timer keeps the event loop alive for the rest of the
        // timeout — for a one-shot build that is the process refusing to exit.
        const before = process.getActiveResourcesInfo().filter(r => r === 'Timeout').length
        await sendWithTimeout({ send: async () => 'sent', payload: {}, timeoutMs: 60_000 })
        const after = process.getActiveResourcesInfo().filter(r => r === 'Timeout').length
        assert.equal(after, before)
    })
})

describe('backoffDelay', () => {
    const opts = { baseMs: 60_000, maxMs: 900_000 }

    it('waits the base delay after the first failure', () => {
        assert.equal(backoffDelay({ attempts: 0, ...opts }), 60_000)
    })
    it('doubles with each attempt already made', () => {
        assert.equal(backoffDelay({ attempts: 1, ...opts }), 120_000)
        assert.equal(backoffDelay({ attempts: 2, ...opts }), 240_000)
        assert.equal(backoffDelay({ attempts: 3, ...opts }), 480_000)
    })
    it('caps at maxMs instead of growing without bound', () => {
        assert.equal(backoffDelay({ attempts: 4, ...opts }), 900_000)
        assert.equal(backoffDelay({ attempts: 40, ...opts }), 900_000)
    })
    it('treats a missing or junk attempt count as none made', () => {
        // attempts comes straight from a sqlite row, which can be null on a
        // row written before the column existed.
        assert.equal(backoffDelay({ attempts: null, ...opts }), 60_000)
        assert.equal(backoffDelay({ attempts: undefined, ...opts }), 60_000)
        assert.equal(backoffDelay({ attempts: -3, ...opts }), 60_000)
    })
})
