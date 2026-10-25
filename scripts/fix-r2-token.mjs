/**
 * Checks the R2 token and, only when the secret is a real 64-character key,
 * writes and deletes one private probe object.
 *
 * A script cannot invent the missing secret. Production currently has a
 * 32-character secret, which Cloudflare rejects with HTTP 401.
 *
 *   R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... R2_BUCKET=officium-message-files \
 *     node --experimental-strip-types scripts/fix-r2-token.mjs
 *
 * Do not pass the secret as a shell argument that stays in history, and do not commit it.
 */
import { credentialFingerprint, r2TokenProblem } from "../src/lib/message/storage.ts";
import { checkStorage, deleteStoredObject, signedDownloadUrl, signedUploadUrl } from "../src/lib/message/object-store.ts";

const problem = r2TokenProblem();
console.log(credentialFingerprint());
if (problem) {
  console.error(problem);
  console.error("Create the token in Cloudflare: R2 → Manage R2 API Tokens → Create API token.");
  console.error("Permission: Object Read & Write. Bucket: officium-message-files. Leave the bucket private.");
  console.error("Copy the Access Key ID (32 hex) and the Secret Access Key (64 hex, shown once).");
  console.error("In Vercel, replace both R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY for Production, then redeploy.");
  console.error("Also set the bucket CORS rule for https://message.officiumconnect.in with PUT, GET, and HEAD, header content-type.");
  process.exit(2);
}

const health = await checkStorage();
console.log(`${health.label}. ${health.note}`);
if (health.status !== "operational") process.exit(1);

const key = `officium/ws_officium/_health/${crypto.randomUUID().replace(/-/g, "")}.txt`;
const body = "officium-r2-signed-check\n";
let uploadUrl = "";
try {
  uploadUrl = await signedUploadUrl(key, "text/plain", 120);
  const put = await fetch(uploadUrl, { method: "PUT", headers: { "content-type": "text/plain" }, body });
  if (!put.ok) {
    console.error(`Signed upload was rejected with HTTP ${put.status}. The token can use the API, but a browser-style PUT was refused.`);
    process.exit(1);
  }
  const downloadUrl = await signedDownloadUrl(key, "probe.txt", "text/plain", 120);
  const got = await fetch(downloadUrl);
  const text = await got.text();
  if (!got.ok || text !== body) {
    console.error(`Signed download failed with HTTP ${got.status}.`);
    process.exit(1);
  }
  console.log("Signed upload and download succeeded. The probe object was private.");
} finally {
  if (uploadUrl) {
    try { await deleteStoredObject(key); } catch { console.error("The probe object could not be deleted. Remove officium/ws_officium/_health/ from the bucket."); }
  }
}
console.log("R2 token is usable. Redeploy production after saving these same values in Vercel.");
