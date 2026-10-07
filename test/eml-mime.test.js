// `out/**/*.eml` has to BE an .eml.
//
// It was composed with nodemailer's jsonTransport, whose `message` is the
// envelope serialised as JSON — `{"from":…,"to":…,"html":…}`. The README
// called the result "the .eml audit file" and it did not open in a mail
// client, because a .eml is RFC 5322 and that is not.
//
// The same bytes have a second reader. `deliveryPayload` falls back to
// `{ raw: <the file> }` for a row queued before payloads were stored, and
// nodemailer's `raw` means raw MIME — so that path handed a transport a JSON
// blob to transmit verbatim.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { composeEml } from '../index.js'

describe('the composed .eml', () => {
    const message = {
        from: 'site@example.com',
        to: 'sales@example.com',
        subject: 'Запитване от сайта',
        html: '<p>Здравейте, <b>интересувам се</b></p>',
    }

    it('is MIME, not a JSON envelope', async () => {
        const eml = String(await composeEml(message))
        assert.doesNotMatch(eml.trimStart().slice(0, 1), /\{/, 'the file still starts as JSON')
        assert.match(eml, /^From: site@example\.com$/m)
        assert.match(eml, /^To: sales@example\.com$/m)
        assert.match(eml, /^MIME-Version: 1\.0$/m)
        assert.match(eml, /^Content-Type: text\/html; charset=utf-8$/m)
    })

    it('separates the headers from the body, and the body is the message', async () => {
        // The structural rule a mail client applies. Without the blank line
        // the whole file is headers and the message appears empty — and
        // decoding what follows is what proves it is the body rather than
        // more envelope.
        const eml = String(await composeEml(message))
        const separator = eml.indexOf('\r\n\r\n')
        assert.notEqual(separator, -1, 'no header/body separator')
        const headers = eml.slice(0, separator)
        const body = eml.slice(separator + 4)
        assert.match(headers, /^Subject:/m)
        const encoding = (headers.match(/^Content-Transfer-Encoding: (\S+)$/m) ?? [])[1]
        const decoded = encoding === 'base64'
            ? Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8')
            : body
        assert.match(decoded, /интересувам се/, `the body did not survive: ${decoded.slice(0, 80)}`)
    })

    it('encodes a non-ASCII subject per RFC 2047 rather than emitting raw bytes', async () => {
        // Cyrillic subjects are the normal case here, and a raw 8-bit header
        // is what a receiving MTA rejects.
        const eml = String(await composeEml(message))
        const subject = eml.split(/\r?\n/).find(line => line.startsWith('Subject:'))
        assert.match(subject, /^Subject: =\?UTF-8\?/, `not encoded: ${subject}`)
    })

    it('carries a Message-ID and a Date, like anything that has been sent', async () => {
        const eml = String(await composeEml(message))
        assert.match(eml, /^Message-ID: <.+>$/m)
        assert.match(eml, /^Date: .+$/m)
    })
})
