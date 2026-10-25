# Officium Message — production setup

Officium Message is one workspace for Officium Connect. Sign-in, channels, direct messages, groups, tasks, reminders, workflows, and the audit log are stored in Postgres. External providers stay **not configured** until the host has credentials and the provider itself accepts a request.

Do not put real secrets in the repository. Set the names below in the host’s environment. Empty names are also listed in `.env.example`.

## Host

- Domain: `message.officiumconnect.in`
- HTTPS is required. The host terminates TLS. Do not run this app on plain HTTP in production.
- The app is published independently of this builder. After publish, it keeps running on the host and its database.
- `DATABASE_URL` is injected for Postgres. Migrations in `migrations/` run on deploy and on embedded-database startup. Do not edit `migrations/auth/0001_auth.sql`.
- Take database backups from the Postgres provider. Restoring a backup and republishing is the recovery path. This app does not ship its own backup daemon.

## Scheduler

`/api/cron/tick` runs reminders, webhook retries, and scheduled workflows. On the Hobby plan the committed schedule is once a day at 03:00 UTC, because a five-minute schedule is rejected and the whole deployment fails. The request must send `Authorization: Bearer <CRON_SECRET>`.

If `CRON_SECRET` is missing, the route refuses to run (HTTP 503). While someone has the app open, the same work also runs so a missed cron does not drop due reminders. A Pro plan can change the schedule back to `*/5 * * * *`.

## Real time

New messages, reactions, and unread counts refresh every few seconds for people who can see that thread. This host does not keep durable WebSockets, so the app does not open one. A dropped refresh retries on the next interval.

## AI

- `XAI_API_KEY` — server only. Never exposed to the browser.
- `XAI_MODEL` — optional. Defaults to `grok-4.5`.
- `/ask` is the only command that calls the model. It uses the last few messages in the thread the person can already open.
- Settings can disable AI and can require a manager to approve a draft before it is posted. A draft is not a sent message.
- If the key is missing, `/ask` says AI is not configured. It does not invent a reply.
- Each person is limited to 20 `/ask` calls an hour. The provider call times out after 20 seconds and is capped at 400 output tokens.

## WhatsApp (official Cloud API only)

- `WHATSAPP_TOKEN`
- `WHATSAPP_PHONE_NUMBER_ID`
- `WHATSAPP_VERIFY_TOKEN` — you choose this string and enter the same value in the Meta webhook form.
- `WHATSAPP_APP_SECRET` — used to check `X-Hub-Signature-256`. Unsigned posts are rejected.

Webhook URL: `https://message.officiumconnect.in/api/hooks/whatsapp`

Subscribe to messages and message statuses. The verify request must echo the challenge only when the token matches. Incoming messages are copied into `#automation-logs`. The app does not auto-reply. A workflow WhatsApp action sends only after Graph API returns success, and the row is **accepted**, not delivered, until a status webhook updates it. No unofficial WhatsApp Web session is used.

Live end-to-end verification stays pending until those four values are set and Meta accepts the handshake.

## Telegram

- `TELEGRAM_BOT_TOKEN` — from BotFather.
- `TELEGRAM_WEBHOOK_SECRET` — a long random string you choose.
- `TELEGRAM_WEBHOOK_URL` — `https://message.officiumconnect.in/api/hooks/telegram`

In Apps, **Test connection** calls `getMe` and does not send a chat message. **Register webhook** calls Telegram `setWebhook` and is operational only if Telegram returns success. Incoming updates must present the secret header. Duplicate update ids are ignored. The app does not auto-reply.

## Email

- `SMTP_URL` — `smtps://user:password@host:465` or an `https://` endpoint that accepts JSON `{ "to", "subject", "text" }` and returns HTTP 2xx.
- `SMTP_FROM` — optional From address.

A banner or a lone HTTP 200 on GET is only **reachable**. A workflow email action is recorded only after the SMTP server accepts DATA, or the HTTPS endpoint returns 2xx. Plain SMTP on port 587 is not used.

## Google Calendar

- `GOOGLE_CALENDAR_ACCESS_TOKEN` — an OAuth access token with calendar scope. This app does not embed a Google client secret. Create the token in Google Cloud OAuth, then set it on the host. Refresh it when it expires.

Test connection lists calendars and does not create an event. A workflow calendar action (`title | 2026-10-25T10:00:00Z`) creates a 30-minute event only if Google returns success.

## CRM, candidate portal, tasks, webhooks

These products do not ship a documented API inside this repository, so the app does not invent write endpoints for them.

- `OFFICIUM_CRM_URL` — HTTPS GET only. Success is **reachable**, not connected.
- `OFFICIUM_PORTAL_URL` — same.
- `EXTERNAL_TASKS_URL` — HTTPS. GET is the health check. A workflow external-task action POSTs `{ "title", "source": "officium-message" }` and succeeds only on HTTP 2xx.
- `OFFICIUM_WEBHOOK_URL` — default HTTPS target for webhook actions.
- `OFFICIUM_WEBHOOK_SECRET` — optional HMAC in `x-officium-signature`.

Webhook failures are retried with backoff, up to three attempts, and the same failure is not queued twice.

## Files — Cloudflare R2

R2 is the object store for new attachments. PostgreSQL keeps users, channels, messages, and file metadata. File bytes go to a private bucket, not into the message row.

Variables, names only:

- `R2_ACCOUNT_ID` — Cloudflare account identifier. Used to build `https://<account>.r2.cloudflarestorage.com` when `R2_ENDPOINT` is empty.
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET` — bucket name, not a URL.
- `R2_ENDPOINT` — optional HTTPS S3 endpoint. No user, password, or query string.
- `R2_REGION` — optional, default `auto`.

If an `R2_` name is empty, the matching older `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, or `S3_ENDPOINT` value is used. Set the real values in the host environment. They are not in the frontend bundle.

### Account and billing

Confirm the current allowance on [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/) before you rely on it. As published on 1 Oct 2026, R2 Standard includes, each month, 10 GB-month of storage, 1 million Class A operations (writes and lists, including `PutObject`), and 10 million Class B operations (reads, including `HeadBucket`, `HeadObject`, and `GetObject`). Egress to the internet is free. Deletes are free. That allowance does **not** apply to Infrequent Access. Create the bucket as **Standard**. Past the free allowance, Standard storage is about $0.015 per GB-month, Class A about $4.50 per million, and Class B about $0.36 per million. There is no minimum commitment, but a Cloudflare account may ask for a payment method before R2 can be used. This app does not turn on a paid storage class.

A team that shares modest PDFs and images should stay inside the free Standard allowance. The storage test writes and deletes one tiny object, which counts as operations.

### Setup

1. Create a Cloudflare account and open R2.
2. Create a bucket on **Standard**. Leave the bucket private. Do not enable the public `r2.dev` URL.
3. Create an API token limited to Object Read & Write on that bucket. Copy the access key id and secret once.
4. Copy the account id from the R2 overview.
5. Set `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and `R2_BUCKET` on the host. Leave them out of git.
6. Add the CORS rule below so the browser can upload directly. Do not use `*`. CORS is not authentication: the server still checks membership before it issues a signed link.

7. Sign in as a manager, open Apps, choose storage, and use Test connection.

Test connection calls `HeadBucket`, then `PutObject`, `HeadObject`, and `DeleteObject` on `officium/ws_officium/_health/<id>.txt`. The status becomes **Operational** only if all of those succeed. If the variables are missing, the status stays **Not configured** and nothing is sent. Invalid values, such as a bucket URL or an `http://` endpoint, show **Configuration error**. A reachable setup that still fails the write or delete shows **Connection failed**.

A direct server upload and a signed PUT were both tested against the production bucket on 25 Oct 2026. R2 answered **HTTP 401 Unauthorized** to both. The signed URL used region `auto`, the bucket name `officium-message-files`, a 32-character hexadecimal access key, and no checksum parameter. That 401 is the credential pair being rejected. It is not caused by CORS. A missing Object Read & Write permission normally returns 403, which did not happen. The browser additionally shows a network error until the CORS rule below exists, because the browser is not allowed to read R2's response.

Replace both `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` in the Vercel Production environment with a new token, then redeploy. Do not wrap the values in quotes. Leave `R2_REGION` unset.

CORS lets the browser send the file bytes to R2. It does not authenticate the user and it does not decide who may see a file. Membership is checked on this server before a signed upload or download link is issued. Keep the bucket private. Do not turn on the public `r2.dev` domain.

Use this CORS rule only if the browser uploads directly. The app origin is `https://message.officiumconnect.in`. Add a second origin only for a real preview host you control. Do not use `*`.

```json
[
  {
    "AllowedOrigins": ["https://message.officiumconnect.in"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["content-type"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

The five variables are set on the host that runs the server, not in a committed `.env` file. Changing a file on your laptop does not update the published site. After you set them, redeploy or restart that server, sign in as a manager, and run Test connection. Do not send the access key or secret in chat.

### What the app does

- Allowed types: PNG, JPEG, WebP, GIF, PDF, plain text. 8 MB maximum in R2. 120 KB maximum in the database.
- The composer asks for a five-minute signed PUT after the user is signed in and is a member of that channel or direct message. The browser uploads the bytes to R2. Sending the message checks the object size and the first bytes against the declared type. A mismatch deletes the object and does not attach it.
- Downloads are five-minute signed GET links, only after the same membership check. The bucket stays private.
- Credentials never go to the browser. Signed URLs expire.
- New R2 files are stored as `r2:<file id>` on the message. The bytes are not copied into Postgres.
- Older messages that still hold a `data:` URL or an `s3:<file id>` pointer keep working. `s3:` and `r2:` both resolve through `stored_files` when the object is in the configured bucket.
- "Copy database files to R2" copies up to 20 database files per click, confirms the object, then points the message at R2. The old database bytes stay until a manager uses "Remove verified database copies". "Preview file move" only counts files. Neither button deletes old bytes during the copy. Run the copy again if more files remain. A failed R2 delete leaves the file row as `delete_pending` so a later maintenance pass can retry. An object still used by another live message is not deleted.
- Pending uploads older than a day are deleted from R2 and from `stored_files` on the maintenance pass, when R2 is configured.
- Deleting your own message removes the R2 object only when no other live message still points at it. If R2 refuses the delete, the file row stays as `delete_pending` and a later maintenance pass retries. The database row is not dropped before that retry succeeds.

Small files can still be posted through the server as a data URL. When R2 is configured, that path uploads with the SDK and stores only the pointer. When it is not, the data URL remains on the message so existing previews keep working.


## Auth rate limit

Sign-in rate limits use the client IP from `x-forwarded-for`, which the hosted platform sets. The auth server configuration is owned by the platform and is not edited here. Better Auth only accepts that header when it is a single valid address; a missing header, a hostname, or a local-preview chain such as `127.0.0.1, ::ffff:127.0.0.1` is reduced to one address (loopback when nothing usable is present) so preview does not share one unnamed bucket and does not log "could not determine a client IP". A single platform address is left unchanged. When several distinct addresses arrive, `x-real-ip` is used if it is valid, otherwise the leftmost forwarded client. Do not send a spoofed forwarding header from a browser; production should keep the platform header.

## Status words

- `not_configured` — a required variable is missing. The storage screen says **Not configured**. Nothing was sent.
- `reachable` — HTTPS responded, but the body is not a known Officium API, or email was not actually submitted.
- `operational` — the provider accepted a real method such as WhatsApp phone lookup, Telegram `getMe`, Calendar list, or an R2 write, read, and delete. Storage says **Operational**.
- `error` — the provider rejected the attempt. For storage, the note says **Configuration error** or **Connection failed**.
- `disconnected` — seeded before any test. It is not a successful connection. Storage displays this as **Not configured** until a test runs.

## Still pending without credentials

Live WhatsApp send and receive, live Telegram send and receive, a real mailbox submission, a real calendar event, any CRM or portal write, and a real Cloudflare R2 bucket. The storage code signs links locally and reports not configured or error when R2 is missing or unreachable. It has not been marked operational in this environment because no R2 credentials were provided.
