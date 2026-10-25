import assert from "node:assert/strict";
import test from "node:test";
import { checkStorage, signedDownloadUrl, signedUploadUrl } from "./object-store.ts";
import {
  allowFile,
  assertObjectKey,
  matchesDeclaredType,
  objectKeyFor,
  readStorageConfig,
  safeFileName,
  shouldRemoveStoredObject,
  sniffBinary,
  storageConfigured,
  storageDiagnosis,
  storageSetupMessage,
  credentialFingerprint,
} from "./storage.ts";

const KEYS = [
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
  "R2_ENDPOINT",
  "R2_REGION",
  "S3_ENDPOINT",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_REGION",
];

function saveEnv() {
  const previous = new Map<string, string | undefined>();
  for (const key of KEYS) previous.set(key, process.env[key]);
  return previous;
}

function restoreEnv(previous: Map<string, string | undefined>) {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function clearEnv() {
  for (const key of KEYS) delete process.env[key];
}

test("credential fingerprint describes shape and never echoes the secret", () => {
  const previous = saveEnv();
  clearEnv();
  process.env.R2_ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
  process.env.R2_ACCESS_KEY_ID = "abcdef0123456789abcdef0123456789";
  process.env.R2_SECRET_ACCESS_KEY = "\"not-a-real-secret-value\"";
  process.env.R2_BUCKET = "officium-message-files";
  const note = credentialFingerprint();
  assert.match(note, /Account id is 32 characters, hexadecimal/);
  assert.match(note, /Access key is 32 characters, hexadecimal/);
  assert.match(note, /Secret is 25 characters, not hexadecimal, wrapped in quotes/);
  assert.match(note, /expected private bucket/);
  assert.equal(note.includes("not-a-real-secret-value"), false);
  assert.equal(note.includes("abcdef0123456789abcdef0123456789"), false);
  restoreEnv(previous);
});

test("rejects types and sizes without writing a file", () => {
  assert.equal(allowFile("image/png", 120_000, false).ok, true);
  assert.equal(allowFile("image/png", 120_001, false).ok, false);
  assert.equal(allowFile("image/png", 8_000_000, true).ok, true);
  assert.equal(allowFile("image/png", 8_000_001, true).ok, false);
  assert.equal(allowFile("application/zip", 10, true).ok, false);
  assert.equal(allowFile("image/png", 0, true).ok, false);
  assert.equal(sniffBinary(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "image/png");
  assert.equal(matchesDeclaredType("image/png", Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), true);
  assert.equal(matchesDeclaredType("image/jpeg", Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), false);
  assert.equal(matchesDeclaredType("text/plain", Uint8Array.from([0x68, 0x69])), true);
});

test("R2 config is absent until every required name is set", () => {
  const previous = saveEnv();
  clearEnv();
  try {
    assert.equal(storageConfigured(), false);
    assert.equal(readStorageConfig(), null);
    const note = storageSetupMessage();
    assert.match(note, /R2_BUCKET/);
    assert.equal(note.includes("example"), false);
    process.env.R2_BUCKET = "officium-message";
    process.env.R2_ACCESS_KEY_ID = "example-access-key";
    process.env.R2_SECRET_ACCESS_KEY = "example-secret-key";
    process.env.R2_ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
    const cfg = readStorageConfig();
    assert.ok(cfg);
    assert.equal(cfg?.endpoint, "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com");
    process.env.R2_ENDPOINT = "http://127.0.0.1:9";
    assert.equal(readStorageConfig(), null);
    assert.match(storageSetupMessage(), /https/);
  } finally {
    restoreEnv(previous);
  }
});

test("signed download URL is local and does not contain the secret", async () => {
  const previous = saveEnv();
  clearEnv();
  process.env.R2_ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
  process.env.R2_ACCESS_KEY_ID = "exampleAccessKey123";
  process.env.R2_SECRET_ACCESS_KEY = "exampleSecretKeyValue99";
  process.env.R2_BUCKET = "officium-message";
  try {
    const url = await signedDownloadUrl(
      "officium/ws_officium/file_0123456789abcdef01",
      "notes.txt",
      "text/plain",
      300,
    );
    assert.equal(url.startsWith("https://"), true);
    assert.equal(url.includes("0123456789abcdef0123456789abcdef"), true);
    assert.equal(url.includes("officium-message"), true);
    assert.equal(url.includes("X-Amz-Expires=300"), true);
    assert.equal(url.includes("exampleSecretKeyValue99"), false);
    assert.equal(url.includes("exampleAccessKey123"), true);
  } finally {
    restoreEnv(previous);
  }
});

test("storage health stays not operational without credentials and when the endpoint refuses", async () => {
  const previous = saveEnv();
  clearEnv();
  try {
    const missing = await checkStorage();
    assert.equal(missing.status, "not_configured");
    assert.equal(missing.note.includes("exampleSecret"), false);
    process.env.R2_ENDPOINT = "https://127.0.0.1:9";
    process.env.R2_BUCKET = "officium-message";
    process.env.R2_ACCESS_KEY_ID = "exampleAccessKey123";
    process.env.R2_SECRET_ACCESS_KEY = "exampleSecretKeyValue99";
    const refused = await checkStorage();
    assert.equal(refused.status, "error");
    assert.equal(refused.label, "Connection failed");
    assert.match(refused.note, /Connection failed/);
    assert.notEqual(refused.status, "operational");
    assert.equal(refused.note.includes("exampleSecretKeyValue99"), false);
  } finally {
    restoreEnv(previous);
  }
});

test("configuration errors stay distinct from a missing setup", () => {
  const previous = saveEnv();
  clearEnv();
  try {
    const missing = storageDiagnosis();
    assert.equal(missing.kind, "not_configured");
    assert.match(missing.note, /Not configured/);
    assert.equal(missing.note.includes("exampleSecret"), false);
    process.env.R2_BUCKET = "https://bucket.example";
    process.env.R2_ACCESS_KEY_ID = "exampleAccessKey123";
    process.env.R2_SECRET_ACCESS_KEY = "exampleSecretKeyValue99";
    process.env.R2_ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
    const bad = storageDiagnosis();
    assert.equal(bad.kind, "configuration_error");
    assert.match(bad.note, /Configuration error/);
    assert.equal(bad.note.includes("exampleSecretKeyValue99"), false);
  } finally {
    restoreEnv(previous);
  }
});

test("object keys reject traversal and signed links expire", async () => {
  assert.equal(shouldRemoveStoredObject(0), true);
  assert.equal(shouldRemoveStoredObject(1), false);
  assert.equal(objectKeyFor("file_0123456789abcdef01"), "officium/ws_officium/file_0123456789abcdef01");
  assert.throws(() => objectKeyFor("../etc/passwd"), /not valid/);
  assert.throws(() => assertObjectKey("officium/ws_officium/../../secret"), /not allowed/);
  assert.equal(safeFileName('notes"\r\n.txt'), "notes.txt");
  const previous = saveEnv();
  clearEnv();
  process.env.R2_ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
  process.env.R2_ACCESS_KEY_ID = "exampleAccessKey123";
  process.env.R2_SECRET_ACCESS_KEY = "exampleSecretKeyValue99";
  process.env.R2_BUCKET = "officium-message";
  try {
    const upload = await signedUploadUrl("officium/ws_officium/file_0123456789abcdef01", "text/plain", 300);
    assert.equal(upload.includes("X-Amz-Expires=300"), true);
    assert.equal(upload.includes("exampleSecretKeyValue99"), false);
    const brief = await signedDownloadUrl(
      "officium/ws_officium/file_0123456789abcdef01",
      "notes.txt",
      "text/plain",
      60,
    );
    assert.equal(brief.includes("X-Amz-Expires=60"), true);
    assert.equal(brief.includes("exampleSecretKeyValue99"), false);
  } finally {
    restoreEnv(previous);
  }
});
