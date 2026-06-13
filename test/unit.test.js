// Pure-logic tests for postEmail. No engine, no nodemailer transport,
// no sqlite — just the resolution + decision-tree functions.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
    parseDuration, humanizeMs,
    resolveSpec, dedupe, resolveAddresses,
    decideTiming,
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
