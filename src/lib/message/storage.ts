/** Cloudflare R2 settings and file checks. No SDK and no secrets in return values. */

export const DB_FILE_LIMIT = 120_000;
export const OBJECT_FILE_LIMIT = 8_000_000;
export const SIGNED_URL_SECONDS = 300;

const ALLOWED_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
  "text/plain",
]);

const STORAGE_ENV = [
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
] as const;

export function envName(name: string) {
  return process.env[name]?.trim() ?? "";
}

export type StorageConfig = {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  endpoint: string;
  region: string;
  secretAccessKey: string;
};

function endpointProblem(explicit: string, accountId: string) {
  if (!explicit) {
    if (!accountId) return "";
    if (!/^[A-Za-z0-9]{8,64}$/.test(accountId)) {
      return "R2_ACCOUNT_ID must be the Cloudflare account identifier, without spaces or slashes.";
    }
    return "";
  }
  let url: URL;
  try {
    url = new URL(explicit);
  } catch {
    return "R2_ENDPOINT is not a valid URL.";
  }
  if (url.protocol !== "https:") return "R2_ENDPOINT must start with https://.";
  if (url.username || url.password) return "R2_ENDPOINT must not contain a username or password.";
  if (url.search || url.hash) return "R2_ENDPOINT must not include a query or hash.";
  return "";
}

export function readStorageConfig(): StorageConfig | null {
  const accountId = envName("R2_ACCOUNT_ID");
  const bucket = envName("R2_BUCKET") || envName("S3_BUCKET");
  const accessKeyId = envName("R2_ACCESS_KEY_ID") || envName("S3_ACCESS_KEY_ID");
  const secretAccessKey = envName("R2_SECRET_ACCESS_KEY") || envName("S3_SECRET_ACCESS_KEY");
  const explicit = envName("R2_ENDPOINT") || envName("S3_ENDPOINT");
  const region = envName("R2_REGION") || envName("S3_REGION") || "auto";
  if (!bucket || !accessKeyId || !secretAccessKey) return null;
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) return null;
  if (!explicit && !accountId) return null;
  if (endpointProblem(explicit, accountId)) return null;
  const endpoint = explicit
    ? new URL(explicit).origin
    : `https://${accountId}.r2.cloudflarestorage.com`;
  return { accountId, bucket, accessKeyId, secretAccessKey, endpoint, region };
}

export function storageConfigured() {
  return readStorageConfig() !== null;
}

export function storageSetupMessage() {
  return storageDiagnosis().note;
}

export type StorageDiagnosis = {
  kind: "not_configured" | "configuration_error" | "ready";
  note: string;
};

/** What the server can say about R2 before it tries the network. */
export function storageDiagnosis(): StorageDiagnosis {
  const problem = endpointProblem(
    envName("R2_ENDPOINT") || envName("S3_ENDPOINT"),
    envName("R2_ACCOUNT_ID"),
  );
  const bucket = envName("R2_BUCKET") || envName("S3_BUCKET");
  const access = envName("R2_ACCESS_KEY_ID") || envName("S3_ACCESS_KEY_ID");
  const secret = envName("R2_SECRET_ACCESS_KEY") || envName("S3_SECRET_ACCESS_KEY");
  const explicit = envName("R2_ENDPOINT") || envName("S3_ENDPOINT");
  const accountId = envName("R2_ACCOUNT_ID");
  const hint = "Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET on the server. R2_ENDPOINT is optional and defaults to https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com. S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, and S3_ENDPOINT still work as aliases. Do not put these values in the browser.";
  const bucketOk = !bucket || /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket);
  if (readStorageConfig()) {
    return {
      kind: "ready",
      note: "R2 variables are present. Storage stays not operational until Test connection writes and deletes a probe object.",
    };
  }
  if (problem || !bucketOk) {
    const detail = problem || "R2_BUCKET must be the bucket name only, not a URL or a path.";
    return { kind: "configuration_error", note: `Configuration error. ${detail} ${hint}` };
  }
  const missing: string[] = [];
  if (!bucket) missing.push("R2_BUCKET");
  if (!access) missing.push("R2_ACCESS_KEY_ID");
  if (!secret) missing.push("R2_SECRET_ACCESS_KEY");
  if (!explicit && !accountId) missing.push("R2_ACCOUNT_ID or R2_ENDPOINT");
  return {
    kind: "not_configured",
    note: `Not configured. Cloudflare R2 is not configured. Missing ${missing.join(", ") || "required R2 variables"}. ${hint}`,
  };
}

/** True only when no other live message still points at this file. */
export function shouldRemoveStoredObject(otherLiveMessages: number) {
  return otherLiveMessages < 1;
}

export function storageEnvNames() {
  return STORAGE_ENV;
}

export function allowFile(contentType: string, bytes: number, objectStorage: boolean) {
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!ALLOWED_TYPES.has(type)) return { ok: false as const, error: "That file type is not allowed. Use PNG, JPEG, WebP, GIF, PDF, or plain text." };
  const limit = objectStorage ? OBJECT_FILE_LIMIT : DB_FILE_LIMIT;
  if (!Number.isFinite(bytes) || bytes < 1) return { ok: false as const, error: "The file is empty." };
  if (bytes > limit) {
    return {
      ok: false as const,
      error: objectStorage
        ? "File is over the 8 MB limit."
        : "File is over 120 KB. Cloudflare R2 is not configured, so larger files are not written into the database.",
    };
  }
  return { ok: true as const, type };
}

export function objectKeyFor(fileId: string) {
  if (!/^file_[a-f0-9]{18}$/.test(fileId)) throw new Error("That file id is not valid.");
  return `officium/ws_officium/${fileId}`;
}

export function assertObjectKey(key: string) {
  if (!/^officium\/ws_officium\/(?:file_[a-f0-9]{18}|_health\/[a-f0-9]{32}\.txt)$/.test(key)) {
    throw new Error("That storage key is not allowed.");
  }
  return key;
}

export function remotePointer(fileId: string) {
  return `r2:${fileId}`;
}

export function remoteFileId(pointer: string | null | undefined) {
  if (!pointer) return "";
  if (pointer.startsWith("r2:") || pointer.startsWith("s3:")) return pointer.slice(3);
  return "";
}

export function sniffBinary(sample: Uint8Array) {
  if (sample.length >= 8 && sample[0] === 0x89 && sample[1] === 0x50 && sample[2] === 0x4e && sample[3] === 0x47) return "image/png";
  if (sample.length >= 3 && sample[0] === 0xff && sample[1] === 0xd8 && sample[2] === 0xff) return "image/jpeg";
  if (sample.length >= 6 && sample[0] === 0x47 && sample[1] === 0x49 && sample[2] === 0x46 && sample[3] === 0x38) return "image/gif";
  if (
    sample.length >= 12
    && sample[0] === 0x52 && sample[1] === 0x49 && sample[2] === 0x46 && sample[3] === 0x46
    && sample[8] === 0x57 && sample[9] === 0x45 && sample[10] === 0x42 && sample[11] === 0x50
  ) return "image/webp";
  if (sample.length >= 5 && sample[0] === 0x25 && sample[1] === 0x50 && sample[2] === 0x44 && sample[3] === 0x46 && sample[4] === 0x2d) {
    return "application/pdf";
  }
  return "";
}

export function matchesDeclaredType(declared: string, sample: Uint8Array) {
  const sniffed = sniffBinary(sample);
  if (declared === "text/plain") {
    if (sniffed) return false;
    for (const byte of sample) {
      if (byte === 9 || byte === 10 || byte === 13) continue;
      if (byte < 32) return false;
    }
    return sample.length > 0;
  }
  return sniffed === declared;
}

export function safeFileName(name: string) {
  const cleaned = name.replace(/[\r\n"\\]/g, "").replace(/[^\w.\- ()[\]]+/g, "_").slice(0, 120);
  return cleaned || "file";
}
