# Officium Message

Team messaging and workflow automation for Officium Connect. One workspace.

## What works without extra accounts

- Email, Google, and X sign-in
- Public and private channels, direct messages, and groups
- Messages, reactions, pins, replies, and small attachments
- Labels, internal notes, assignments, tasks, and local candidate refs
- Slash commands, including `/ask` when AI is configured
- Workflows, including keyword, mention, channel, schedule, and unanswered triggers
- Reminders. They run on the host scheduler when `CRON_SECRET` is set, and also on the next visit so a missed cron still delivers them
- Roles, invite codes, and an audit log

## What stays pending until a provider accepts a request

WhatsApp Cloud API, Telegram, email delivery, Google Calendar, CRM, the candidate portal, external tasks, outbound webhooks, and private object storage.

Checking that a variable exists is not a connection. Apps → Test connection records `not_configured`, `reachable`, `operational`, or `error`. Nothing is marked sent unless the provider returns success.

Full variable list, cron, webhook URLs, and file storage: [PRODUCTION.md](./PRODUCTION.md).

The platform injects `DATABASE_URL` and sign-in settings on deploy. Do not commit secrets.

## Deploy

1. Publish this project. Migrations in `migrations/` apply on deploy.
2. Point `message.officiumconnect.in` at the published site and turn HTTPS on at the host.
3. Set `CRON_SECRET` on the host. The committed schedule calls `/api/cron/tick` once a day at 03:00 UTC, which is the Hobby plan limit. Opening the app still runs due reminders between those runs.
4. Sign in. The first account is the owner. Invite the team from Admin.

## Files

Without Cloudflare R2, the composer keeps files at or under 120 KB inside the database, and larger files are refused. With R2 configured, the browser uploads to a private bucket through a five-minute signed link, and downloads use a five-minute signed link after a membership check. Old database attachments keep working. A manager can move them with "Move database files to R2" after a successful storage test. See [PRODUCTION.md](./PRODUCTION.md) for the account, free allowance, and CORS steps. Do not treat storage as connected until Apps → storage → Test connection reports operational.

## Updates

Change the source and publish again. The running site does not need this builder to stay online.
