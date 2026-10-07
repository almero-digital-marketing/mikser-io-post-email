// Why is a delivery being sent again?
//
// The send-once identity hashes the rendered body, which is right for the
// case it was built for — a genuinely edited submission is a new delivery.
// It is also what makes an edited email LAYOUT re-send everything that uses
// it, because every one of those bodies changed at once. Reported: four
// duplicate enquiries to real people after a template edit.
//
// `deliveryKey` already prevented it. Nothing said so, because nothing could
// tell a layout edit apart from forty-seven edited submissions — the hash
// moved either way. Storing the identity WITHOUT the body is what separates
// them: same recipients, same subject, same schedule, different body.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
    deliveryHash, bodylessDeliveryHash, formatMarker, parseMarker, isDelivered, resendReason,
} from '../lib/pure.js'

const enquiry = {
    from: 'site@example.com',
    to: 'sales@example.com',
    subject: 'Запитване',
    html: '<p>original body</p>',
    sendAt: null,
}
const marker = (fields, revision = 1) =>
    formatMarker(revision, deliveryHash(fields), bodylessDeliveryHash(fields))

describe('the body-less delivery identity', () => {
    it('ignores the body', () => {
        assert.equal(
            bodylessDeliveryHash(enquiry),
            bodylessDeliveryHash({ ...enquiry, html: '<p>a new layout wrapped this</p>' }))
    })

    it('still separates two different recipients', () => {
        assert.notEqual(bodylessDeliveryHash(enquiry),
            bodylessDeliveryHash({ ...enquiry, to: 'someone-else@example.com' }))
    })

    it('still separates two different subjects', () => {
        assert.notEqual(bodylessDeliveryHash(enquiry),
            bodylessDeliveryHash({ ...enquiry, subject: 'Друго' }))
    })

    it('still separates two different send times', () => {
        // A recurring email keeps its id and its body and only moves its send
        // time. Collapsing those would suppress every occurrence after the
        // first, which is a silently lost email — worse than a duplicate.
        assert.notEqual(bodylessDeliveryHash(enquiry),
            bodylessDeliveryHash({ ...enquiry, sendAt: '2026-01-01T00:00:00Z' }))
    })

    it('is not the full identity, so one cannot stand in for the other', () => {
        assert.notEqual(bodylessDeliveryHash(enquiry), deliveryHash(enquiry))
    })
})

describe('the marker body', () => {
    it('round-trips all three fields', () => {
        assert.deepEqual(parseMarker(formatMarker(2, 'aaa', 'bbb')),
            { revision: 2, hash: 'aaa', bodylessHash: 'bbb' })
    })

    it('still reads a marker written before the third field existed', () => {
        // Installs upgrading in place have these on disk. They must keep
        // suppressing the duplicate they were written to suppress.
        assert.equal(isDelivered('1:abc', 1, 'abc'), true)
        assert.deepEqual(parseMarker('1:abc'), { revision: 1, hash: 'abc', bodylessHash: null })
    })

    it('answers isDelivered off the three-field form', () => {
        assert.equal(isDelivered(formatMarker(1, 'abc', 'xyz'), 1, 'abc'), true)
        assert.equal(isDelivered(formatMarker(1, 'abc', 'xyz'), 1, 'different'), false)
        assert.equal(isDelivered(formatMarker(1, 'abc', 'xyz'), 2, 'abc'), false,
            'a revision bump must invalidate the marker')
    })

    it('refuses junk rather than reading a revision out of it', () => {
        for (const junk of [null, undefined, '', 'nonsense', ':abc', 'x:abc']) {
            assert.equal(parseMarker(junk), null, `parsed ${JSON.stringify(junk)}`)
            assert.equal(isDelivered(junk, 1, 'abc'), false)
        }
    })
})

describe('resendReason', () => {
    const current = (fields) => ({
        hash: deliveryHash(fields),
        bodylessHash: bodylessDeliveryHash(fields),
    })

    it("says 'body' when only the rendered body moved", () => {
        const edited = { ...enquiry, html: '<p>the layout now wraps it in a table</p>' }
        assert.equal(resendReason(marker(enquiry), 1, current(edited)), 'body')
    })

    it("says 'content' when the delivery itself differs", () => {
        const other = { ...enquiry, to: 'someone-else@example.com', html: '<p>x</p>' }
        assert.equal(resendReason(marker(enquiry), 1, current(other)), 'content')
    })

    it("says 'revision' when a bump asked for the resend", () => {
        // Deliberate, and the one case that must never be warned about.
        const edited = { ...enquiry, html: '<p>new</p>' }
        assert.equal(resendReason(marker(enquiry, 1), 2, current(edited)), 'revision')
    })

    it('says nothing when the delivery is unchanged', () => {
        assert.equal(resendReason(marker(enquiry), 1, current(enquiry)), null)
    })

    it('says nothing when there is no marker to compare against', () => {
        // A first delivery is not a resend.
        assert.equal(resendReason(null, 1, current(enquiry)), null)
    })

    it('does not guess from a marker that predates the body-less field', () => {
        // Two-field markers cannot tell the shapes apart, and a warning that
        // might be about a genuinely different delivery is worse than none.
        const old = formatMarker(1, deliveryHash(enquiry))
        assert.equal(resendReason(old, 1, current({ ...enquiry, html: '<p>new</p>' })), 'content')
    })

    it('reports a keyed delivery as unchanged when only its body moved', () => {
        // deliveryKey already takes the body out of the identity — the lever
        // the warning points at. Nothing to resend, so nothing to explain.
        const keyed = { ...enquiry, deliveryKey: 'enquiry-4821' }
        const edited = { ...keyed, html: '<p>a different layout</p>' }
        assert.equal(resendReason(marker(keyed), 1, current(edited)), null)
    })
})
