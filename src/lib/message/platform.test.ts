import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  allowFile,
  askModel,
  nextBackoffMs,
  probeProvider,
  redactSecrets,
  telegramUpdate,
  verifyMetaSignature,
  verifySharedSecret,
  whatsappEvents,
} from "./platform.ts";

test("redacts bearer tokens and query secrets", () => {
  const out = redactSecrets("Authorization: Bearer abc.def_123 token=super-secret");
  assert.equal(out.includes("super-secret"), false);
  assert.equal(out.includes("abc.def"), false);
});

test("rejects oversized database files and unknown types", () => {
  assert.equal(allowFile("image/png", 120_000, false).ok, true);
  assert.equal(allowFile("image/png", 120_001, false).ok, false);
  assert.equal(allowFile("image/png", 8_000_000, true).ok, true);
  assert.equal(allowFile("application/zip", 10, true).ok, false);
});

test("backs off and then caps", () => {
  assert.equal(nextBackoffMs(1), 60_000);
  assert.equal(nextBackoffMs(2), 120_000);
  assert.equal(nextBackoffMs(10), 30 * 60_000);
});

test("checks WhatsApp signatures", async () => {
  const body = "{\"ok\":true}";
  const secret = "app-secret";
  const good = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  assert.equal(await verifyMetaSignature(secret, body, good), true);
  assert.equal(await verifyMetaSignature(secret, body, "sha256=dead"), false);
  assert.equal(await verifyMetaSignature("", body, good), false);
  assert.equal(verifySharedSecret("same", "same"), true);
  assert.equal(verifySharedSecret("same", "other"), false);
});

test("reads WhatsApp and Telegram payloads without treating them as sent", () => {
  const events = whatsappEvents({
    entry: [{ changes: [{ value: {
      messages: [{ id: "wamid.1", from: "919999999999", type: "text", text: { body: "hello" } }],
      statuses: [{ id: "wamid.1", status: "delivered" }],
    } }] }],
  });
  assert.equal(events.length, 2);
  assert.equal(events[0]?.kind, "message");
  assert.equal(events[1]?.kind, "status");
  const update = telegramUpdate({ update_id: 4, message: { message_id: 9, text: "hi", chat: { id: 42 } } });
  assert.equal(update?.externalId, "42:9");
  assert.equal(telegramUpdate({ update_id: 1 }), null);
});

test("AI and WhatsApp stay unconfigured when credentials are absent", async () => {
  const previousAi = process.env.XAI_API_KEY;
  const previousToken = process.env.WHATSAPP_TOKEN;
  const previousPhone = process.env.WHATSAPP_PHONE_NUMBER_ID;
  delete process.env.XAI_API_KEY;
  delete process.env.WHATSAPP_TOKEN;
  delete process.env.WHATSAPP_PHONE_NUMBER_ID;
  try {
    const ai = await askModel("hello", []);
    assert.equal(ai.ok, false);
    if (!ai.ok) assert.match(ai.error, /not configured/);
    const probe = await probeProvider("whatsapp");
    assert.equal(probe.status, "not_configured");
  } finally {
    if (previousAi) process.env.XAI_API_KEY = previousAi;
    else delete process.env.XAI_API_KEY;
    if (previousToken) process.env.WHATSAPP_TOKEN = previousToken;
    if (previousPhone) process.env.WHATSAPP_PHONE_NUMBER_ID = previousPhone;
  }
});
