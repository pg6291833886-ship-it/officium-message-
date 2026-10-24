import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { pendingMigrations } from "./migration-plan.mjs";

test("app migrations apply on PGLite and rows survive a reopen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pglite-phase1-"));
  try {
    const files = readdirSync("migrations").filter((name) => name.endsWith(".sql"));
    const paths = files.map((name) => join("migrations", name));
    const open = async () => {
      const db = new PGlite({ dataDir: dir });
      await db.waitReady;
      return db;
    };
    const db = await open();
    await db.exec(
      "create table if not exists _migrations (name text primary key, applied_at timestamptz not null default now())",
    );
    for (const { name } of pendingMigrations(paths, [])) {
      const sql = readFileSync(join("migrations", name), "utf8");
      await db.transaction(async (tx) => {
        await tx.exec(sql);
        await tx.query("insert into _migrations (name) values ($1)", [name]);
      });
    }
    await db.exec(
      `insert into "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
       values ('u_phase1', 'Phase One', 'phase1@officium.test', true, now(), now())`,
    );
    await db.close();

    const again = await open();
    const done = (await again.query("select name from _migrations")).rows.map((row) => row.name);
    assert.deepEqual(pendingMigrations(paths, done), []);
    const users = await again.query(`select email from "user" where id = 'u_phase1'`);
    assert.equal(users.rows[0]?.email, "phase1@officium.test");
    const channels = await again.query(
      "select to_regclass('public.channels') as channels, to_regclass('public.memberships') as memberships",
    );
    assert.equal(channels.rows[0]?.channels, "channels");
    assert.equal(channels.rows[0]?.memberships, "memberships");
    await again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
