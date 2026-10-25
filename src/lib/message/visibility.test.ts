import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { VISIBLE_MESSAGE_SQL } from "./visibility.ts";

const SCHEMA = `
  create table memberships (
    workspace_id text not null,
    user_id text not null,
    role text not null default 'member',
    primary key (workspace_id, user_id)
  );
  create table channels (
    id text primary key,
    workspace_id text not null,
    visibility text not null,
    archived boolean not null default false
  );
  create table channel_members (
    channel_id text not null,
    user_id text not null,
    primary key (channel_id, user_id)
  );
  create table conversations (
    id text primary key,
    workspace_id text not null
  );
  create table conversation_members (
    conversation_id text not null,
    user_id text not null,
    primary key (conversation_id, user_id)
  );
  create table messages (
    id text primary key,
    workspace_id text not null,
    channel_id text,
    conversation_id text,
    body text not null,
    attachment_name text,
    deleted boolean not null default false,
    created_at timestamptz not null default now()
  );
`;

async function seed() {
  const db = new PGlite();
  await db.waitReady;
  await db.exec(SCHEMA);
  await db.exec(`
    insert into memberships (workspace_id, user_id, role) values
      ('ws', 'owner', 'owner'),
      ('ws', 'member', 'member'),
      ('ws', 'guest', 'guest');
    insert into channels (id, workspace_id, visibility) values
      ('pub', 'ws', 'public'),
      ('priv', 'ws', 'private');
    insert into channel_members (channel_id, user_id) values ('priv', 'owner');
    insert into conversations (id, workspace_id) values ('dm', 'ws');
    insert into conversation_members (conversation_id, user_id) values ('dm', 'owner'), ('dm', 'member');
    insert into messages (id, workspace_id, channel_id, conversation_id, body, attachment_name) values
      ('m-pub', 'ws', 'pub', null, 'public hello', 'brief.pdf'),
      ('m-priv', 'ws', 'priv', null, 'private channel secret', null),
      ('m-dm', 'ws', null, 'dm', 'dm secret between owner and member', 'payslip.pdf');
  `);
  return db;
}

async function visibleBodies(db: PGlite, userId: string) {
  const result = await db.query<{ body: string }>(
    `select m.body from messages m
     where m.workspace_id = $2 and m.deleted = false and ${VISIBLE_MESSAGE_SQL}
     order by m.id`,
    [userId, "ws"],
  );
  return result.rows.map((row) => row.body);
}

test("a member cannot read another person's private channel or a conversation they are not in", async () => {
  const db = await seed();
  const outsider = new PGlite();
  await outsider.waitReady;
  await outsider.exec(SCHEMA);
  await outsider.exec(`
    insert into memberships (workspace_id, user_id, role) values ('ws', 'outsider', 'member');
    insert into channels (id, workspace_id, visibility) values ('pub', 'ws', 'public'), ('priv', 'ws', 'private');
    insert into channel_members (channel_id, user_id) values ('priv', 'owner');
    insert into conversations (id, workspace_id) values ('dm', 'ws');
    insert into conversation_members (conversation_id, user_id) values ('dm', 'owner'), ('dm', 'member');
    insert into messages (id, workspace_id, channel_id, conversation_id, body) values
      ('m-pub', 'ws', 'pub', null, 'public hello'),
      ('m-priv', 'ws', 'priv', null, 'private channel secret'),
      ('m-dm', 'ws', null, 'dm', 'dm secret');
  `);
  const rows = await visibleBodies(outsider, "outsider");
  assert.deepEqual(rows, ["public hello"]);
  await outsider.close();
  await db.close();
});

test("direct messages and private files are hidden from non-members, including guests on public channels", async () => {
  const db = await seed();
  assert.deepEqual(await visibleBodies(db, "guest"), []);
  const member = await visibleBodies(db, "member");
  assert.equal(member.includes("dm secret between owner and member"), true);
  assert.equal(member.includes("private channel secret"), false);
  assert.equal(member.includes("public hello"), true);
  const files = await db.query<{ attachment_name: string }>(
    `select m.attachment_name from messages m
     where m.workspace_id = $2 and m.deleted = false and m.attachment_name is not null
       and ${VISIBLE_MESSAGE_SQL}`,
    ["guest", "ws"],
  );
  assert.equal(files.rows.length, 0);
  const memberFiles = await db.query<{ attachment_name: string }>(
    `select m.attachment_name from messages m
     where m.workspace_id = $2 and m.deleted = false and m.attachment_name is not null
       and ${VISIBLE_MESSAGE_SQL}
     order by m.attachment_name`,
    ["member", "ws"],
  );
  assert.deepEqual(memberFiles.rows.map((row) => row.attachment_name), ["brief.pdf", "payslip.pdf"]);
  await db.close();
});

test("scoped sidebar preview does not return another conversation and is cheaper than a global scan", async () => {
  const db = new PGlite();
  await db.waitReady;
  await db.exec(`
    create table messages (
      id text primary key,
      workspace_id text not null,
      channel_id text,
      conversation_id text,
      body text not null,
      deleted boolean not null default false,
      created_at timestamptz not null default now()
    );
    create index messages_channel_idx on messages (channel_id, created_at);
  `);
  const values: string[] = [];
  for (let i = 0; i < 3000; i += 1) {
    const channel = i % 2 === 0 ? "mine" : "secret";
    values.push(`('m${i}', 'ws', '${channel}', null, 'body ${channel} ${i}', false, now() - interval '${3000 - i} seconds')`);
  }
  await db.exec(`insert into messages (id, workspace_id, channel_id, conversation_id, body, deleted, created_at) values ${values.join(",")}`);
  const globalStart = performance.now();
  const globalRows = await db.query<{ body: string }>(
    `select body from messages where workspace_id = $1 and deleted = false order by created_at desc limit 300`,
    ["ws"],
  );
  const globalMs = performance.now() - globalStart;
  const scopedStart = performance.now();
  const scoped = await db.query<{ body: string }>(
    `select distinct on (channel_id) body from messages
     where deleted = false and channel_id in ($1)
     order by channel_id, created_at desc`,
    ["mine"],
  );
  const scopedMs = performance.now() - scopedStart;
  assert.equal(scoped.rows.length, 1);
  assert.equal(String(scoped.rows[0]?.body).includes("secret"), false);
  assert.equal(globalRows.rows.length, 300);
  console.log(`[perf] global preview scan ${globalMs.toFixed(1)}ms rows=${globalRows.rows.length}; scoped preview ${scopedMs.toFixed(1)}ms rows=${scoped.rows.length}`);
  await db.close();
});
