/**
 * Server-only Cloudflare R2 client (S3-compatible API).
 * Import this from server handlers. It reads credentials from the environment
 * and must not be called with values typed by the browser.
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  SIGNED_URL_SECONDS,
  assertObjectKey,
  credentialFingerprint,
  matchesDeclaredType,
  readStorageConfig,
  safeFileName,
  storageDiagnosis,
  type StorageConfig,
} from "./storage.ts";

let cached: { key: string; client: S3Client } | null = null;

function clientKey(cfg: StorageConfig) {
  let sum = cfg.secretAccessKey.length;
  for (let i = 0; i < cfg.secretAccessKey.length; i += 1) sum = (sum + cfg.secretAccessKey.charCodeAt(i)) % 1_000_003;
  return `${cfg.endpoint}|${cfg.bucket}|${cfg.accessKeyId}|${cfg.region}|${sum}`;
}

function clientFor(cfg: StorageConfig) {
  const key = clientKey(cfg);
  if (cached?.key === key) return cached.client;
  const client = new S3Client({
    region: cfg.region || "auto",
    endpoint: cfg.endpoint,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    maxAttempts: 2,
  });
  cached = { key, client };
  return client;
}

function requireConfig() {
  const diagnosis = storageDiagnosis();
  if (diagnosis.kind !== "ready") throw new Error(diagnosis.note);
  const cfg = readStorageConfig();
  if (!cfg) throw new Error(diagnosis.note);
  return cfg;
}

function storageError(err: unknown, action: string) {
  const name = err && typeof err === "object" && "name" in err ? String((err as { name: unknown }).name) : "";
  const status = err && typeof err === "object" && "$metadata" in err
    ? Number((err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode ?? 0)
    : 0;
  if (name === "NoSuchBucket" || name === "NotFound" || status === 404) {
    return new Error(`R2 could not find the bucket or file during ${action}. Check R2_BUCKET and that the object is still there.`);
  }
  if (name === "AccessDenied" || name === "Forbidden" || status === 403) {
    return new Error(`R2 denied ${action}. Check R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and that the token can use this bucket.`);
  }
  if (name === "Unauthorized" || status === 401) {
    return new Error(`R2 rejected the credentials during ${action}. Create a new Object Read & Write token for this bucket and replace both the access key and the secret. ${credentialFingerprint()}`);
  }
  if (name === "TimeoutError" || name === "AbortError") return new Error(`R2 timed out during ${action}.`);
  const raw = err instanceof Error ? err.message : "Unknown storage error";
  const safe = raw.replace(/[A-Za-z0-9+/=_-]{24,}/g, "[redacted]").slice(0, 240);
  return new Error(`R2 ${action} failed (${name || status || "error"}): ${safe}`);
}

function fail(err: unknown, action: string): never {
  throw storageError(err, action);
}

export async function uploadObject(key: string, body: Uint8Array, contentType: string) {
  const cfg = requireConfig();
  assertObjectKey(key);
  try {
    await clientFor(cfg).send(new PutObjectCommand({
      Bucket: cfg.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }), { abortSignal: AbortSignal.timeout(15000) });
  } catch (err) {
    fail(err, "the upload");
  }
}

export async function deleteStoredObject(key: string) {
  const cfg = requireConfig();
  assertObjectKey(key);
  try {
    await clientFor(cfg).send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }), { abortSignal: AbortSignal.timeout(8000) });
  } catch (err) {
    throw storageError(err, "the delete");
  }
}

export async function signedDownloadUrl(key: string, fileName: string, contentType: string, seconds = SIGNED_URL_SECONDS) {
  const cfg = requireConfig();
  assertObjectKey(key);
  const command = new GetObjectCommand({
    Bucket: cfg.bucket,
    Key: key,
    ResponseContentType: contentType,
    ResponseContentDisposition: `attachment; filename="${safeFileName(fileName)}"`,
  });
  try {
    return await getSignedUrl(clientFor(cfg), command, { expiresIn: seconds });
  } catch (err) {
    throw storageError(err, "the download link");
  }
}

export async function signedUploadUrl(key: string, contentType: string, seconds = SIGNED_URL_SECONDS) {
  const cfg = requireConfig();
  assertObjectKey(key);
  const command = new PutObjectCommand({
    Bucket: cfg.bucket,
    Key: key,
    ContentType: contentType,
  });
  try {
    return await getSignedUrl(clientFor(cfg), command, { expiresIn: seconds });
  } catch (err) {
    throw storageError(err, "the upload link");
  }
}

async function prefixBytes(cfg: StorageConfig, key: string) {
  let result;
  try {
    result = await clientFor(cfg).send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key, Range: "bytes=0-31" }), { abortSignal: AbortSignal.timeout(8000) });
  } catch (err) {
    fail(err, "the file check");
  }
  const body = result.Body;
  if (!body || !("transformToByteArray" in body) || typeof body.transformToByteArray !== "function") {
    throw new Error("R2 returned a file the server could not read.");
  }
  const bytes = await body.transformToByteArray();
  return bytes.slice(0, 32);
}

export async function confirmStoredObject(key: string, contentType: string, size: number) {
  const cfg = requireConfig();
  assertObjectKey(key);
  let length = 0;
  try {
    const head = await clientFor(cfg).send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: key }), { abortSignal: AbortSignal.timeout(8000) });
    length = Number(head.ContentLength ?? 0);
  } catch (err) {
    const wrapped = storageError(err, "the file check");
    if (wrapped.message.includes("could not find")) {
      return { ok: false as const, error: "The file has not arrived in R2 yet. Upload it, then send the message again." };
    }
    return { ok: false as const, error: wrapped.message };
  }
  if (length !== size) {
    try { await deleteStoredObject(key); } catch { /* the mismatched object is removed when R2 allows it */ }
    return { ok: false as const, error: `Uploaded file is ${length} bytes, not the declared ${size} bytes. It was not attached.` };
  }
  let sample: Uint8Array;
  try {
    sample = await prefixBytes(cfg, key);
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : "R2 could not be read back." };
  }
  if (!matchesDeclaredType(contentType, sample)) {
    try { await deleteStoredObject(key); } catch { /* best effort */ }
    return { ok: false as const, error: "The file contents do not match the declared type, so it was rejected." };
  }
  return { ok: true as const };
}

export async function objectExists(key: string) {
  const cfg = requireConfig();
  assertObjectKey(key);
  try {
    await clientFor(cfg).send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: key }), { abortSignal: AbortSignal.timeout(8000) });
    return true;
  } catch {
    return false;
  }
}

export async function checkStorage(): Promise<{
  status: "not_configured" | "operational" | "error";
  label: "Not configured" | "Configuration error" | "Connection failed" | "Operational";
  note: string;
}> {
  const diagnosis = storageDiagnosis();
  if (diagnosis.kind === "not_configured") {
    return { status: "not_configured", label: "Not configured", note: diagnosis.note };
  }
  if (diagnosis.kind === "configuration_error") {
    return { status: "error", label: "Configuration error", note: diagnosis.note };
  }
  const cfg = readStorageConfig();
  if (!cfg) return { status: "not_configured", label: "Not configured", note: diagnosis.note };
  try {
    await clientFor(cfg).send(new HeadBucketCommand({ Bucket: cfg.bucket }), { abortSignal: AbortSignal.timeout(8000) });
  } catch (err) {
    return { status: "error", label: "Connection failed", note: `Connection failed. ${storageError(err, "the bucket check").message}` };
  }
  const key = `officium/ws_officium/_health/${crypto.randomUUID().replace(/-/g, "")}.txt`;
  try {
    await clientFor(cfg).send(new PutObjectCommand({
      Bucket: cfg.bucket,
      Key: key,
      Body: new TextEncoder().encode("officium-r2-check"),
      ContentType: "text/plain",
    }), { abortSignal: AbortSignal.timeout(8000) });
    await clientFor(cfg).send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: key }), { abortSignal: AbortSignal.timeout(8000) });
    await clientFor(cfg).send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }), { abortSignal: AbortSignal.timeout(8000) });
    return {
      status: "operational",
      label: "Operational",
      note: "Operational. R2 accepted a private write, a read, and a delete in this bucket. Message files are not public. This does not enable Infrequent Access or a paid plan by itself.",
    };
  } catch (err) {
    try {
      await clientFor(cfg).send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }), { abortSignal: AbortSignal.timeout(4000) });
    } catch { /* probe object may remain under officium/ws_officium/_health/ */ }
    return {
      status: "error",
      label: "Connection failed",
      note: `Connection failed. ${storageError(err, "the write check").message} The bucket was visible, but a file could not be stored and removed.`,
    };
  }
}
