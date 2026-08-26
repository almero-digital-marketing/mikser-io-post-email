# mikser-io-post-email

Email postprocessor for [mikser-io](https://github.com/almero-digital-marketing/mikser-io). Reads rendered HTML from a postprocess chain, composes a MIME message, delivers it via SMTP (or any [nodemailer](https://nodemailer.com/) transport), and writes the `.eml` audit file to the output folder. Idempotency falls out of mikser's render manifest — unchanged inputs don't resend.

Sits *after* `post-mjml` in the canonical chain, so the same source content ships as a web page *and* a responsive email built from one MJML layout:

```
layouts/welcome.html-mjml-email.hbs    # renderer → MJML → post-mjml → HTML → post-email → EML
```

## Install

```bash
npm install mikser-io-post-email
```

## Minimal usage

```js
// mikser.config.js
import { documents, layouts, renderHbs, frontMatter } from 'mikser-io'
import { postMjml } from 'mikser-io-post-mjml'
import { postEmail } from 'mikser-io-post-email'

export default {
    plugins: [
        documents(),
        frontMatter(),
        layouts(),
        renderHbs(),
        postMjml(),
        postEmail({
            from: 'hello@me.com',
            transport: {
                host: 'smtp.example.com',
                port: 587,
                auth: { user: '...', pass: '...' },
            },
        }),
    ],
}
```

```yaml
---
to: alice@acme.com
subject: Welcome, Alice
layout: welcome.html-mjml-email
---
```

That's the transactional case: one entity, one recipient. The `.eml` lands at `out/welcome.eml` and the message ships immediately. On the next build, mikser's render manifest sees unchanged inputs and skips the whole chain — no resend.

## Recipient lists — `@listname` references

For broadcast, define named lists in plugin options and reference them from `to`/`cc`/`bcc` with an `@` prefix.

```js
postEmail({
    from: 'newsletter@me.com',
    lists: {
        subscribers: async ({ entity }) =>
            (await queryEntities({ type: 'subscriber', meta: { lang: entity.meta.lang } }))
                .map(s => s.meta.email),
        clients:     ['ceo@acme.com', 'cto@acme.com'],
        team:        ['ops@me.com'],
        archive:     ['audit@me.com'],
    },
    bcc: ['@archive'],     // global audit copy on every send
})
```

```yaml
# newsletter
---
to: '@subscribers'
subject: This week
---

# client update + one-off CC
---
to: '@clients'
cc: ['investor@vc.com']
---
```

### Resolution rule

| Field | Where it comes from | Combine semantics |
|---|---|---|
| `to`  | entity `meta.to` only | exclusive — no plugin-options fallback |
| `cc`  | entity `meta.cc` + plugin `cc` | additive, deduped (case-insensitive) |
| `bcc` | entity `meta.bcc` + plugin `bcc` | additive, deduped |
| `from`| entity `meta.from` ?? plugin `from` | entity wins; missing entirely → error |

A `@listname` in any of these fields resolves through `options.lists`. Spec values can be a literal string, an array, or `(ctx) => Promise<string | string[]>` where `ctx = { entity, runtime, config, lists, logger }`.

**Errors:**
- `to` missing → hard error (no silent send-to-nobody).
- `@unknown` → hard error naming the missing list.
- `to: []` (empty after resolution) → writes an empty `.eml` marker, logs debug, no delivery. Valid "no subscribers for this language" case.

## Scheduling — `sendAt`

```yaml
---
to: '@subscribers'
subject: Friday digest
sendAt: 2026-06-20T09:00:00Z   # ISO 8601, or missing/'now' for immediate
---
```

Resolution against `maxDelay` (default `'1h'`):

| `sendAt` | What happens |
|---|---|
| missing / `'now'` | Deliver immediately during the chain |
| future | Write `.eml`, queue a row, deliver on drain when due |
| recent past (≤ `maxDelay`) | Catch-up: deliver immediately, warn nothing |
| ancient past (> `maxDelay`) | Write `.eml`, mark `expired_at`, log warning, no delivery |

`maxDelay` is overridable per-entity:

```yaml
---
sendAt: 2026-06-20T09:00:00Z
maxDelay: 4h                    # tolerate up to 4h of downtime
---
```

### How the queue works

A persistent table (`mikser_post_email_queue` in `runtime/mikser.sqlite`) holds future sends.

```sql
mikser_post_email_queue (
    id          PRIMARY KEY → mikser_entities(id) ON DELETE CASCADE,
    eml_path,
    send_at, sent_at, expired_at,
    attempts, last_error
)
```

- **PK on entity id + UPSERT** — re-editing `sendAt` reschedules in place; can't double-queue.
- **FK CASCADE** — delete the source doc, queue row vanishes. Schedule follows the file.
- **Drain triggers**: on startup, after every cycle (`onFinalized`), and every 60s in `--watch` mode.
- **Failures stay queued**: `attempts` and `last_error` track retries; the next drain re-attempts.
- **Retention**: delivered + expired rows are kept for `retention` (default `'90d'`) then pruned.

## Transport

Anything [nodemailer.createTransport](https://nodemailer.com/transports/) accepts:

```js
postEmail({
    transport: {
        host: 'smtp.example.com', port: 587, secure: false,
        auth: { user: '...', pass: '...' },
    },
})
```

With no `transport` provided, the plugin builds a JSON transport — useful for dev/testing: messages serialize to the `.eml` on disk but never leave the box.

## Dry-run

```js
postEmail({ dryRun: process.env.NODE_ENV !== 'production' })
```

`dryRun: true` writes every `.eml` (so authors can review them in the output folder) but skips `transport.sendMail()`. The queue still records deliveries (with `sent_at`) for observability. No send-once marker is written, so a dry run never suppresses a later real delivery.

## Send-once — durable delivery markers

An email is delivered **once**, even across rebuilds. After a successful send
the plugin writes a marker file into `sentFolder` (default `emails/` in the
working folder); on every later build the marker suppresses re-delivery.

This can't live in the queue table: mikser wipes its cache whenever
`mikser.config.js` changes, and the queue rows cascade off `mikser_entities`.
Both drop the sent state, so before markers existed a rebuild re-rendered every
email document and re-sent the lot — a whole backlog of form submissions at
once. The marker is on disk for the same reason the assets plugin keeps `.md5`
sidecars there: it has to outlive the cache.

```js
postEmail({
    from: 'Site <info@example.com>',
    sentFolder: 'emails',   // default; relative to the working folder, or absolute
    revision: 1,            // bump to invalidate every marker and allow a resend
})
```

**Keep `sentFolder` out of source control and out of any deploy that deletes
what it doesn't ship.** It is runtime delivery state, not build cache — unlike
`assets/`, "who we already emailed" must never be committed, and if a deploy's
`rsync --delete` removes it the backlog re-sends. Treat it like `runtime/`:
add it to `.gitignore` and to the deploy's exclude list.

### What counts as "the same email"

The delivery identity is a hash of `from`, `to`, `cc`, `bcc`, `subject`, the
rendered body, and `sendAt` — not the composed `.eml` bytes, which carry a
fresh `Message-ID` and `Date` on every compose and would never match.

`sendAt` is part of it on purpose: a recurring email keeps its id and its body
and only moves its send time, so without it every occurrence after the first
would look already-delivered and be silently dropped.

**Volatile bodies.** If a template renders something that changes every build —
a timestamp, a random token, a cache-buster — its hash changes too and the
guard never matches. Name a stable identity in the entity's frontmatter
instead, and the body stops being part of it:

```yaml
to: client@example.com
subject: Your receipt
deliveryKey: receipt-42
```

### Forcing a resend

Delete the entity's marker file, or bump `revision` to invalidate all of them.

## Options reference

| Option | Type | Default | |
|---|---|---|---|
| `name` | string | `'email'` | Chain identifier (used in layout filenames as `-email`) |
| `from` | string | required (or per-entity `from`) | Default sender |
| `lists` | `Record<string, string \| string[] \| function>` | `{}` | Named recipient lists for `@listname` references |
| `cc` | spec | none | Global CC, deduped with entity `cc` |
| `bcc` | spec | none | Global BCC, deduped with entity `bcc` |
| `transport` | nodemailer config | JSON transport | Delivery target |
| `maxDelay` | duration string | `'1h'` | How late past `sendAt` is still acceptable |
| `retention` | duration string | `'90d'` | How long delivered/expired rows stay in the queue |
| `sentFolder` | string | `'emails'` | Where send-once markers live; keep it gitignored and out of the deploy's delete set |
| `revision` | number | `1` | Bump to invalidate every marker (forces a resend) |
| `dryRun` | boolean | `false` | Write `.eml`, skip transport (and write no marker) |

## What it does NOT do (v1)

- **No transport-native scheduling.** Setting `send_at` on SendGrid/Mailchimp/etc. is not exposed — when an entity is rescheduled (frontmatter edited), the transport would hold both the old and new send. The internal queue dedupes via PK; transport-native scheduling can't.
- **No rename-preserving queue.** A file rename = old entity DELETE + new entity INSERT; the old queue row cascades out, the new one's queue row inherits the renamed file's `sendAt`. Acceptable for v1.
- **No throttling.** If 10k pending sends drain at once after long downtime, that's transport-side load to manage via SMTP-pool config.
- **No retry policy beyond "next drain tries again".** `attempts` is recorded for visibility; there's no exponential backoff or dead-lettering.

## License

MIT
