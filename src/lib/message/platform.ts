import type { Sql } from "@/lib/db";
import { allowFile, storageConfigured, storageSetupMessage } from "./storage.ts";

export { allowFile, storageConfigured, storageSetupMessage };

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function bytesOf(value: Buffer | string) {
  return typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
}

async function hmacRaw(key: Buffer | string, data: string) {
  const cryptoKey = await crypto.subtle.importKey("raw", bytesOf(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
  return Buffer.from(sig);
}

async function hmacHex(key: string, data: string) {
  return (await hmacRaw(key, data)).toString("hex");
}

export const WS = "ws_officium";

export function newId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 18)}`;
}

export function redactSecrets(text: string) {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/(token|secret|password|key)=([^&\s]+)/gi, "$1=[redacted]")
    .slice(0, 400);
}

export function nextBackoffMs(attempt: number) {
  const step = Math.min(Math.max(attempt, 1), 6);
  return Math.min(60_000 * 2 ** (step - 1), 30 * 60_000);
}

export async function verifyMetaSignature(appSecret: string, rawBody: string, header: string | null) {
  if (!appSecret || !header?.startsWith("sha256=")) return false;
  const expected = await hmacHex(appSecret, rawBody);
  return safeEqual(expected, header.slice("sha256=".length));
}

export function verifySharedSecret(expected: string, provided: string | null) {
  if (!expected || !provided) return false;
  return safeEqual(expected, provided);
}

export function aiConfigured() {
  return Boolean(process.env.XAI_API_KEY?.trim());
}

type Probe = { status: "not_configured" | "operational" | "reachable" | "error"; note: string };

async function withTimeout(url: string, init: RequestInit, ms = 8000) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
}

export async function probeProvider(provider: string): Promise<Probe> {
  try {
    if (provider === "whatsapp") return await probeWhatsapp();
    if (provider === "telegram") return await probeTelegram();
    if (provider === "email") return await probeEmail();
    if (provider === "calendar") return await probeCalendar();
    if (provider === "crm") return await probeUrl("OFFICIUM_CRM_URL", "CRM");
    if (provider === "portal") return await probeUrl("OFFICIUM_PORTAL_URL", "Candidate portal");
    if (provider === "tasks") return await probeUrl("EXTERNAL_TASKS_URL", "Task system");
    if (provider === "webhooks") return await probeUrl("OFFICIUM_WEBHOOK_URL", "Webhook");
    if (provider === "storage") return await checkObjectStorage();
    return { status: "error", note: "Unknown provider." };
  } catch (err) {
    return { status: "error", note: redactSecrets(err instanceof Error ? err.message : "Probe failed") };
  }
}

async function probeWhatsapp(): Promise<Probe> {
  const token = process.env.WHATSAPP_TOKEN?.trim();
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();
  if (!token || !phoneId) {
    return { status: "not_configured", note: "Set WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID on the server. Nothing was sent." };
  }
  const res = await withTimeout(`https://graph.facebook.com/v21.0/${encodeURIComponent(phoneId)}?fields=display_phone_number,verified_name`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return { status: "error", note: `WhatsApp rejected the credentials (HTTP ${res.status}). No message was sent.` };
  return { status: "operational", note: "WhatsApp Cloud API accepted the phone-number lookup. No outbound message was sent." };
}

async function probeTelegram(): Promise<Probe> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return { status: "not_configured", note: "Set TELEGRAM_BOT_TOKEN on the server. Nothing was sent." };
  const res = await withTimeout(`https://api.telegram.org/bot${token}/getMe`, {});
  const body = (await res.json().catch(() => null)) as { ok?: boolean; description?: string } | null;
  if (!res.ok || !body?.ok) {
    return { status: "error", note: `Telegram getMe failed${body?.description ? `: ${body.description}` : ` (HTTP ${res.status})`}.` };
  }
  return { status: "operational", note: "Telegram getMe succeeded. No chat message was sent." };
}

async function probeEmail(): Promise<Probe> {
  const smtp = process.env.SMTP_URL?.trim();
  if (!smtp) return { status: "not_configured", note: "Set SMTP_URL (smtp:// or https://) on the server. No email was sent." };
  let url: URL;
  try { url = new URL(smtp); } catch { return { status: "error", note: "SMTP_URL is not a valid URL." }; }
  if (url.protocol === "https:") {
    const res = await withTimeout(smtp, { method: "GET" });
    return res.ok
      ? { status: "reachable", note: `Email HTTPS endpoint responded ${res.status}. No message was sent, so this is not marked operational.` }
      : { status: "error", note: `Email endpoint returned HTTP ${res.status}.` };
  }
  if (url.protocol !== "smtp:" && url.protocol !== "smtps:") {
    return { status: "error", note: "SMTP_URL must use smtp:, smtps:, or https:." };
  }
  const port = Number(url.port || (url.protocol === "smtps:" ? 465 : 587));
  const banner = await readSmtpBanner(url.hostname, port, url.protocol === "smtps:");
  return { status: "reachable", note: `SMTP banner received from ${url.hostname}:${port} (${banner.slice(0, 80)}). No email was sent.` };
}

async function readSmtpBanner(host: string, port: number, secure: boolean) {
  const socket = secure
    ? (await import("node:tls")).connect({ host, port, servername: host })
    : (await import("node:net")).connect({ host, port });
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("SMTP connection timed out"));
    }, 8000);
    socket.once("data", (buf: Buffer) => {
      clearTimeout(timer);
      socket.end("QUIT\r\n");
      resolve(buf.toString("utf8").trim());
    });
    socket.once("error", (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function probeCalendar(): Promise<Probe> {
  const token = process.env.GOOGLE_CALENDAR_ACCESS_TOKEN?.trim();
  if (!token) {
    return { status: "not_configured", note: "Set GOOGLE_CALENDAR_ACCESS_TOKEN from an OAuth consent flow. No calendar was changed." };
  }
  const res = await withTimeout("https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return { status: "error", note: `Google Calendar returned HTTP ${res.status}.` };
  return { status: "operational", note: "Google Calendar list succeeded. No event was created." };
}

async function probeUrl(envName: string, label: string): Promise<Probe> {
  const raw = process.env[envName]?.trim();
  if (!raw) return { status: "not_configured", note: `${label} is not configured. Set ${envName}. No data was written.` };
  let url: URL;
  try { url = new URL(raw); } catch { return { status: "error", note: `${envName} is not a valid URL.` }; }
  if (url.protocol !== "https:") return { status: "error", note: `${label} URL must be https.` };
  const res = await withTimeout(raw, { method: "GET" });
  if (!res.ok) return { status: "error", note: `${label} returned HTTP ${res.status}. Not marked connected.` };
  return { status: "reachable", note: `${label} responded HTTP ${res.status}. The response shape is not a known Officium API, so this is reachability only, not a connected integration.` };
}

export async function postWebhook(url: string, payload: unknown, secret: string | undefined) {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error("Webhook URL is invalid."); }
  if (parsed.protocol !== "https:") throw new Error("Webhook URL must be https.");
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret) headers["x-officium-signature"] = await hmacHex(secret, body);
  const res = await withTimeout(url, { method: "POST", headers, body });
  if (!res.ok) throw new Error(`Webhook returned HTTP ${res.status}`);
  return `Webhook accepted HTTP ${res.status}`;
}

export type WhatsappEvent =
  | { kind: "message"; id: string; from: string; text: string }
  | { kind: "status"; id: string; status: string };

export function whatsappEvents(payload: unknown): WhatsappEvent[] {
  const events: WhatsappEvent[] = [];
  const root = payload as { entry?: { changes?: { value?: { messages?: unknown[]; statuses?: unknown[] } }[] }[] };
  for (const entry of root.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const message of change.value?.messages ?? []) {
        const row = message as { id?: string; from?: string; text?: { body?: string }; type?: string };
        if (!row.id || !row.from) continue;
        events.push({ kind: "message", id: row.id, from: row.from, text: (row.text?.body || row.type || "attachment").slice(0, 500) });
      }
      for (const status of change.value?.statuses ?? []) {
        const row = status as { id?: string; status?: string };
        if (!row.id || !row.status) continue;
        events.push({ kind: "status", id: row.id, status: row.status.slice(0, 40) });
      }
    }
  }
  return events;
}

export function telegramUpdate(payload: unknown) {
  const row = payload as { update_id?: number; message?: { message_id?: number; text?: string; chat?: { id?: number } } };
  const chatId = row.message?.chat?.id;
  const messageId = row.message?.message_id;
  if (chatId == null || messageId == null) return null;
  return {
    externalId: `${chatId}:${messageId}`,
    chatId: String(chatId),
    text: (row.message?.text || "non-text update").slice(0, 500),
  };
}

async function rememberEvent(sql: Sql, provider: string, direction: string, externalId: string, status: string, detail: string) {
  try {
    await sql`
      insert into provider_events (id, provider, direction, external_id, status, detail)
      values (${newId("pev")}, ${provider}, ${direction}, ${externalId}, ${status}, ${detail.slice(0, 400)})
    `;
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (/unique|duplicate/i.test(message)) return false;
    throw err;
  }
}

async function postLog(sql: Sql, body: string) {
  await sql`
    insert into messages (id, workspace_id, channel_id, author_id, body)
    values (${newId("msg")}, ${WS}, ${"ch_logs"}, ${"bot:bot_apps"}, ${body.slice(0, 500)})
  `;
}

export async function ingestWhatsapp(sql: Sql, payload: unknown) {
  let accepted = 0;
  let duplicates = 0;
  for (const event of whatsappEvents(payload)) {
    if (event.kind === "status") {
      const fresh = await rememberEvent(sql, "whatsapp", "status", event.id, event.status, `status ${event.status}`);
      if (!fresh) duplicates += 1;
      else {
        accepted += 1;
        await sql`
          update provider_events set status = ${event.status}, detail = ${`Provider status: ${event.status}`}
          where provider = 'whatsapp' and direction = 'out' and external_id = ${event.id}
        `;
      }
      continue;
    }
    const fresh = await rememberEvent(sql, "whatsapp", "in", event.id, "received", `from ${event.from}`);
    if (!fresh) {
      duplicates += 1;
      continue;
    }
    accepted += 1;
    await postLog(sql, `WhatsApp message ${event.id} from ${event.from}: ${event.text}. No automatic reply was sent.`);
  }
  return { accepted, duplicates };
}

export async function ingestTelegram(sql: Sql, payload: unknown) {
  const update = telegramUpdate(payload);
  if (!update) return { accepted: 0, duplicates: 0 };
  const fresh = await rememberEvent(sql, "telegram", "in", update.externalId, "received", `chat ${update.chatId}`);
  if (!fresh) return { accepted: 0, duplicates: 1 };
  await postLog(sql, `Telegram message ${update.externalId}: ${update.text}. No automatic reply was sent.`);
  return { accepted: 1, duplicates: 0 };
}

export async function sendWhatsappText(to: string, text: string) {
  const token = process.env.WHATSAPP_TOKEN?.trim();
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();
  if (!token || !phoneId) return { ok: false as const, error: "WhatsApp is not configured. No message was sent." };
  if (!/^\d{8,15}$/.test(to)) return { ok: false as const, error: "WhatsApp recipient must be digits only, with country code." };
  const res = await withTimeout(`https://graph.facebook.com/v21.0/${encodeURIComponent(phoneId)}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: text.slice(0, 1000) } }),
  });
  const json = (await res.json().catch(() => null)) as { messages?: { id?: string }[]; error?: { message?: string } } | null;
  if (!res.ok) return { ok: false as const, error: `WhatsApp rejected the send (HTTP ${res.status}). Nothing was marked delivered.` };
  return { ok: true as const, externalId: json?.messages?.[0]?.id ?? "", detail: "WhatsApp accepted the message. Delivery is unconfirmed until a status webhook arrives." };
}

export async function sendTelegramText(chatId: string, text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return { ok: false as const, error: "Telegram is not configured. No message was sent." };
  if (!/^-?\d+$/.test(chatId)) return { ok: false as const, error: "Telegram chat id must be numeric." };
  const res = await withTimeout(`https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 1000) }),
  });
  const json = (await res.json().catch(() => null)) as { ok?: boolean; result?: { message_id?: number }; description?: string } | null;
  if (!res.ok || !json?.ok) return { ok: false as const, error: `Telegram rejected the send${json?.description ? `: ${json.description}` : ` (HTTP ${res.status})`}.` };
  return { ok: true as const, externalId: String(json.result?.message_id ?? ""), detail: "Telegram accepted the message." };
}

export async function registerTelegramWebhook() {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const url = process.env.TELEGRAM_WEBHOOK_URL?.trim();
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (!token || !url || !secret) {
    return { ok: false as const, error: "Set TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_URL, and TELEGRAM_WEBHOOK_SECRET. The webhook was not registered." };
  }
  let parsed: URL;
  try { parsed = new URL(url); } catch { return { ok: false as const, error: "TELEGRAM_WEBHOOK_URL is not a valid URL." }; }
  if (parsed.protocol !== "https:") return { ok: false as const, error: "TELEGRAM_WEBHOOK_URL must be https." };
  const res = await withTimeout(`https://api.telegram.org/bot${encodeURIComponent(token)}/setWebhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url, secret_token: secret, allowed_updates: ["message"], drop_pending_updates: false }),
  });
  const json = (await res.json().catch(() => null)) as { ok?: boolean; description?: string } | null;
  if (!res.ok || !json?.ok) {
    return { ok: false as const, error: `Telegram did not register the webhook${json?.description ? `: ${json.description}` : ` (HTTP ${res.status})`}.` };
  }
  return { ok: true as const, note: "Telegram accepted the webhook URL. Incoming chats are not treated as delivered until a signed update arrives." };
}

function safeHeader(value: string) {
  return value.replace(/[\r\n]/g, " ").trim();
}

export async function sendEmailMessage(to: string, subject: string, text: string) {
  const smtp = process.env.SMTP_URL?.trim();
  if (!smtp) return { ok: false as const, error: "Email is not configured. No message was sent." };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return { ok: false as const, error: "Recipient is not an email address." };
  let url: URL;
  try { url = new URL(smtp); } catch { return { ok: false as const, error: "SMTP_URL is not a valid URL." }; }
  if (url.protocol === "https:") {
    const res = await withTimeout(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to, subject: safeHeader(subject).slice(0, 200), text: text.slice(0, 4000) }),
    });
    if (!res.ok) return { ok: false as const, error: `Email endpoint returned HTTP ${res.status}. No success was recorded.` };
    return { ok: true as const, detail: `Email endpoint accepted HTTP ${res.status}.` };
  }
  if (url.protocol !== "smtp:" && url.protocol !== "smtps:") return { ok: false as const, error: "SMTP_URL must use smtp:, smtps:, or https:." };
  const port = Number(url.port || (url.protocol === "smtps:" ? 465 : 587));
  if (url.protocol !== "smtps:" && port !== 465) {
    return { ok: false as const, error: "Use smtps:// on port 465, or an https:// email endpoint. Plain SMTP was not used, so no message was sent." };
  }
  const from = safeHeader(process.env.SMTP_FROM?.trim() || decodeURIComponent(url.username || "noreply@officiumconnect.in"));
  await smtpDeliver(url, from, to, safeHeader(subject).slice(0, 200), text.slice(0, 4000));
  return { ok: true as const, detail: "SMTP server accepted the message." };
}

async function smtpDeliver(url: URL, from: string, to: string, subject: string, text: string) {
  const tls = await import("node:tls");
  const port = Number(url.port || 465);
  const socket = tls.connect({ host: url.hostname, port, servername: url.hostname });
  const chunks: Buffer[] = [];
  let waiter: ((line: string) => void) | null = null;
  const pending: string[] = [];
  const fail = (err: Error) => {
    socket.destroy();
    throw err;
  };
  socket.on("data", (buf: Buffer) => {
    chunks.push(buf);
    const textBuf = Buffer.concat(chunks).toString("utf8");
    const lines = textBuf.split(/\r?\n/);
    chunks.length = 0;
    if (!textBuf.endsWith("\n")) chunks.push(Buffer.from(lines.pop() ?? ""));
    for (const line of lines) {
      if (!line) continue;
      if (waiter) waiter(line);
      else pending.push(line);
    }
  });
  const closed = new Promise<never>((_, reject) => {
    socket.once("error", reject);
  });
  const nextLine = () => {
    const queued = pending.shift();
    if (queued) return Promise.resolve(queued);
    return Promise.race([
      new Promise<string>((resolve) => { waiter = resolve; }),
      closed,
    ]).finally(() => { waiter = null; });
  };
  const reply = async () => {
    let textOut = "";
    for (;;) {
      const line = await nextLine();
      textOut += `${line}\n`;
      const mark = /^(\d{3})([ -])/.exec(line);
      if (!mark) fail(new Error("Unexpected SMTP reply."));
      if (mark && mark[2] === " ") return { code: Number(mark[1]), text: textOut };
    }
  };
  const cmd = async (line: string, ok: number[]) => {
    socket.write(`${line}\r\n`);
    const got = await reply();
    if (!ok.includes(got.code)) throw new Error(`SMTP ${line.split(" ")[0]} returned ${got.code}.`);
    return got;
  };
  const timer = setTimeout(() => socket.destroy(new Error("SMTP timed out")), 12000);
  try {
    const greet = await reply();
    if (greet.code !== 220) throw new Error(`SMTP greeting ${greet.code}.`);
    await cmd("EHLO officium", [250]);
    if (url.username) {
      await cmd("AUTH LOGIN", [334]);
      await cmd(Buffer.from(decodeURIComponent(url.username)).toString("base64"), [334]);
      await cmd(Buffer.from(decodeURIComponent(url.password)).toString("base64"), [235]);
    }
    await cmd(`MAIL FROM:<${from}>`, [250]);
    await cmd(`RCPT TO:<${to}>`, [250, 251]);
    await cmd("DATA", [354]);
    const dotted = text.replace(/^\./gm, "..");
    socket.write(`Subject: ${subject}\r\nTo: ${to}\r\nFrom: ${from}\r\n\r\n${dotted}\r\n.\r\n`);
    const data = await reply();
    if (data.code !== 250) throw new Error(`SMTP DATA returned ${data.code}.`);
    socket.write("QUIT\r\n");
  } finally {
    clearTimeout(timer);
    socket.end();
  }
}

export async function createCalendarEvent(title: string, startIso: string) {
  const token = process.env.GOOGLE_CALENDAR_ACCESS_TOKEN?.trim();
  if (!token) return { ok: false as const, error: "Google Calendar is not configured. No event was created." };
  const start = new Date(startIso);
  if (Number.isNaN(start.getTime())) return { ok: false as const, error: "Calendar start time is not a valid date." };
  const end = new Date(start.getTime() + 30 * 60_000);
  const res = await withTimeout("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      summary: title.slice(0, 200),
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() },
    }),
  });
  if (!res.ok) return { ok: false as const, error: `Google Calendar returned HTTP ${res.status}. No event was confirmed.` };
  const json = (await res.json().catch(() => null)) as { id?: string } | null;
  return { ok: true as const, externalId: json?.id ?? "", detail: json?.id ? `Calendar event ${json.id} created.` : "Calendar accepted the event." };
}

export async function postExternalTask(title: string) {
  const raw = process.env.EXTERNAL_TASKS_URL?.trim();
  if (!raw) return { ok: false as const, error: "External tasks are not configured. No task was sent." };
  let url: URL;
  try { url = new URL(raw); } catch { return { ok: false as const, error: "EXTERNAL_TASKS_URL is not a valid URL." }; }
  if (url.protocol !== "https:") return { ok: false as const, error: "EXTERNAL_TASKS_URL must be https." };
  const res = await withTimeout(url.toString(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: title.slice(0, 200), source: "officium-message" }),
  });
  if (!res.ok) return { ok: false as const, error: `Task endpoint returned HTTP ${res.status}. It was not marked sent.` };
  return { ok: true as const, detail: `Task endpoint accepted HTTP ${res.status}.` };
}

export async function askModel(prompt: string, history: { role: "user" | "assistant"; content: string }[]) {
  const key = process.env.XAI_API_KEY?.trim();
  if (!key) return { ok: false as const, error: "AI is not configured. Set XAI_API_KEY on the server." };
  const model = process.env.XAI_MODEL?.trim() || "grok-4.5";
  const res = await withTimeout("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      max_tokens: 400,
      messages: [
        { role: "system", content: "You are the Officium Connect recruitment assistant. Be brief and factual. Never invent candidate records, delivery receipts, or provider status. If you do not know, say so." },
        ...history.slice(-8),
        { role: "user", content: prompt.slice(0, 2000) },
      ],
    }),
  }, 20000);
  if (!res.ok) return { ok: false as const, error: `AI provider returned HTTP ${res.status}.` };
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = json.choices?.[0]?.message?.content?.trim();
  if (!text) return { ok: false as const, error: "AI provider returned an empty reply." };
  return { ok: true as const, text: text.slice(0, 2000), model };
}

async function setting(sql: Sql, key: string, fallback: string) {
  const rows = await sql<{ value: string }>`select value from app_settings where key = ${key}`;
  return rows[0]?.value ?? fallback;
}

export async function readAiSettings(sql: Sql) {
  const enabled = (await setting(sql, "ai_enabled", "true")) !== "false";
  const requireApproval = (await setting(sql, "ai_require_approval", "true")) !== "false";
  return { configured: aiConfigured(), enabled, requireApproval, model: process.env.XAI_MODEL?.trim() || "grok-4.5", storage: storageConfigured() ? "object" : "database", maxBytes: storageConfigured() ? 8_000_000 : 120_000 };
}

export async function writeAiSettings(sql: Sql, enabled: boolean, requireApproval: boolean) {
  await sql`
    insert into app_settings (key, value) values (${"ai_enabled"}, ${enabled ? "true" : "false"})
    on conflict (key) do update set value = excluded.value
  `;
  await sql`
    insert into app_settings (key, value) values (${"ai_require_approval"}, ${requireApproval ? "true" : "false"})
    on conflict (key) do update set value = excluded.value
  `;
}

export async function deliverDueReminders(sql: Sql) {
  const due = await sql<{ id: string; user_id: string; body: string }>`
    update reminders set done = true
    where workspace_id = ${WS} and done = false and due_at <= now()
    returning id, user_id, body
  `;
  for (const row of due) {
    await sql`
      insert into notifications (id, workspace_id, user_id, body)
      values (${newId("ntf")}, ${WS}, ${row.user_id}, ${`Reminder: ${row.body}`.slice(0, 240)})
    `;
  }
  return due.map((row) => row.body);
}

export async function enqueueJob(sql: Sql, kind: string, payload: unknown, idempotencyKey: string, delayMs: number) {
  const runAt = new Date(Date.now() + delayMs).toISOString();
  await sql`
    insert into jobs (id, workspace_id, kind, payload, run_at, idempotency_key)
    values (${newId("job")}, ${WS}, ${kind}, ${JSON.stringify(payload)}, ${runAt}, ${idempotencyKey})
    on conflict (idempotency_key) do nothing
  `;
}

async function objectStore() {
  return import("./object-store.ts");
}

async function checkObjectStorage(): Promise<Probe> {
  const result = await (await objectStore()).checkStorage();
  return { status: result.status, note: result.note };
}

export async function putObject(key: string, body: Buffer, contentType: string) {
  await (await objectStore()).uploadObject(key, body, contentType);
}

export async function signedGetUrl(key: string, fileName = "file", contentType = "application/octet-stream", seconds = 300) {
  return (await objectStore()).signedDownloadUrl(key, fileName, contentType, seconds);
}

export async function signedPutUrl(key: string, contentType: string, seconds = 300) {
  return (await objectStore()).signedUploadUrl(key, contentType, seconds);
}

export async function confirmObject(key: string, contentType: string, size: number) {
  return (await objectStore()).confirmStoredObject(key, contentType, size);
}

export async function removeObject(key: string) {
  await (await objectStore()).deleteStoredObject(key);
}

export async function storedObjectExists(key: string) {
  return (await objectStore()).objectExists(key);
}

export async function runDueJobs(sql: Sql) {
  await sql`
    update jobs set status = 'pending'
    where workspace_id = ${WS} and status = 'running' and run_at < now() - interval '15 minutes'
  `;
  const jobs = await sql<{ id: string; kind: string; payload: string; attempts: number; max_attempts: number }>`
    select id, kind, payload, attempts, max_attempts from jobs
    where workspace_id = ${WS} and status = 'pending' and run_at <= now()
    order by run_at asc limit 10
  `;
  let ran = 0;
  for (const job of jobs) {
    const claimed = await sql<{ id: string }>`
      update jobs set status = 'running', run_at = now()
      where id = ${job.id} and status = 'pending'
      returning id
    `;
    if (!claimed[0]) continue;
    ran += 1;
    try {
      if (job.kind === "webhook") {
        const payload = JSON.parse(job.payload) as { url?: string; body?: unknown };
        if (!payload.url) throw new Error("Job is missing a webhook URL.");
        await postWebhook(payload.url, payload.body ?? {}, process.env.OFFICIUM_WEBHOOK_SECRET);
      } else {
        throw new Error(`Unknown job ${job.kind}`);
      }
      await sql`update jobs set status = 'done', attempts = attempts + 1, last_error = '' where id = ${job.id}`;
    } catch (err) {
      const message = redactSecrets(err instanceof Error ? err.message : "Job failed");
      const attempts = job.attempts + 1;
      if (attempts >= job.max_attempts) {
        await sql`update jobs set status = 'failed', attempts = ${attempts}, last_error = ${message} where id = ${job.id}`;
      } else {
        const runAt = new Date(Date.now() + nextBackoffMs(attempts)).toISOString();
        await sql`update jobs set status = 'pending', attempts = ${attempts}, last_error = ${message}, run_at = ${runAt} where id = ${job.id}`;
      }
    }
  }
  return ran;
}

export async function runScheduledWorkflows(sql: Sql, apply: (workflowId: string, config: string) => Promise<void>) {
  const rows = await sql<{ id: string; config_json: string; last_run_at: unknown }>`
    select id, config_json, last_run_at from workflows where workspace_id = ${WS} and enabled = true
  `;
  for (const row of rows) {
    let cfg: { trigger?: { type?: string; value?: string } };
    try { cfg = JSON.parse(row.config_json) as typeof cfg; } catch { continue; }
    if (cfg.trigger?.type !== "schedule") continue;
    const minutes = Number(cfg.trigger.value);
    if (!Number.isFinite(minutes) || minutes < 5) continue;
    const last = row.last_run_at ? new Date(String(row.last_run_at)).getTime() : 0;
    if (Date.now() - last < minutes * 60_000) continue;
    await apply(row.id, row.config_json);
  }
}
