import { copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Nitro bundles PGLite's JavaScript but loads `pglite.data` / wasm via
 * `new URL("./pglite.data", import.meta.url)` next to that bundle. Those
 * files are not emitted, so a production preview crashes with ENOENT unless
 * they are copied into `_libs` after the build (and again before preview).
 */
export function copyPgliteAssets() {
  const srcDir = join(root, "node_modules", "@electric-sql", "pglite", "dist");
  const destDir = join(root, ".vercel", "output", "functions", "__server.func", "_libs");
  const names = ["pglite.data", "pglite.wasm", "initdb.wasm"];

  if (!existsSync(destDir)) {
    console.log("[pglite] production output not present, skip asset copy");
    return false;
  }

  for (const name of names) {
    const from = join(srcDir, name);
    if (!existsSync(from)) {
      throw new Error(`[pglite] missing ${from}`);
    }
    copyFileSync(from, join(destDir, name));
  }
  console.log("[pglite] copied database assets next to the bundled library");
  return true;
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  try {
    copyPgliteAssets();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
