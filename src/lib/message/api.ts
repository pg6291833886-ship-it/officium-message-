import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql, type Sql } from "@/lib/db";
import {
  allowFile,
  askModel,
  createCalendarEvent,
  confirmObject,
  deliverDueReminders,
  enqueueJob,
  postExternalTask,
  postWebhook,
  probeProvider,
  putObject,
  readAiSettings,
  redactSecrets,
  registerTelegramWebhook,
  removeObject,
  runDueJobs,
  runScheduledWorkflows,
  sendEmailMessage,
  sendTelegramText,
  sendWhatsappText,
  signedGetUrl,
  signedPutUrl,
  storageConfigured,
  storageSetupMessage,
  storedObjectExists,
  writeAiSettings,
} from "@/lib/message/platform";
import { matchesDeclaredType, objectKeyFor, remoteFileId, remotePointer, shouldRemoveStoredObject } from "@/lib/message/storage.ts";

const WS = "ws_officium";

const CHANNELS: [string, string, string, string][] = [
  ["ch_general", "general", "Workspace-wide conversation", "Day-to-day talk for the Officium Connect team."],
  ["ch_announcements", "announcements", "Official updates", "Source of record for team announcements."],
  ["ch_recruitment", "recruitment-ops", "Recruitment operations", "Sourcing, screening, and daily ops."],
  ["ch_support", "candidate-support", "Candidate questions", "Queries that need a careful reply."],
  ["ch_interviews", "interview-scheduling", "Interviews", "Slots, reminders, and no-shows."],
  ["ch_placements", "placements", "Placements", "Offers, joining, and closure notes."],
  ["ch_updates", "team-updates", "Team updates", "Shift notes and handovers."],
  ["ch_logs", "automation-logs", "Automation logs", "Workflow and bot outcomes. Do not post candidate PII here."],
];

const BOTS: [string, string, string][] = [
  ["bot_recruitment", "Recruitment Assistant", "FAQs, channel routing, and follow-up reminders for authorised staff."],
  ["bot_support", "Support Assistant", "Labels queries, suggests approved replies, and escalates unresolved cases."],
  ["bot_reminder", "Reminder Bot", "Scheduled reminders and overdue follow-ups."],
  ["bot_summary", "Daily Summary Bot", "Rule-based summaries of recent thread activity."],
  ["bot_apps", "Application Notification Bot", "Records portal events only after a provider is configured. Nothing is sent externally yet."],
];

const PROVIDERS = [
  ["whatsapp", "WhatsApp Business (Meta Cloud API). Disconnected until WHATSAPP_TOKEN is set on the server."],
  ["telegram", "Telegram Bot API. Disconnected until TELEGRAM_BOT_TOKEN is set on the server."],
  ["email", "Email. Disconnected until SMTP_URL is set on the server."],
  ["calendar", "Google Calendar. Disconnected until GOOGLE_CALENDAR_CREDENTIALS is set on the server."],
  ["webhooks", "Inbound webhooks. Disconnected until OFFICIUM_WEBHOOK_SECRET is set on the server."],
  ["crm", "Officium Connect CRM. Disconnected until OFFICIUM_CRM_URL is set on the server."],
  ["portal", "Candidate portal. Disconnected until OFFICIUM_PORTAL_URL is set on the server."],
  ["tasks", "External tasks. Disconnected until EXTERNAL_TASKS_URL is set on the server."],
  ["storage", "Cloudflare R2. Disconnected until R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET are set. Test connection writes and deletes a tiny private probe. It is not marked operational until that succeeds."],
] as const;

const LABELS = ["Candidate", "Interview", "Follow-up", "Urgent", "Placement", "Internal", "Resolved"] as const;

function nid(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 18)}`;
}

function iso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  if (v == null) return "";
  return String(v);
}

function clean(s: string, max: number) {
  return s.replaceAll("\u0000", "").trim().slice(0, max);
}

import { canChangeRole, canInvite, canRedeemInvite, canSeeChannel, initialRole, isAdmin, isStaff, normalizeRole, type Role } from "./access.ts";
import { VISIBLE_MESSAGE_SQL } from "./visibility.ts";

async function audit(sql: Sql, actor: string, action: string, detail: string) {
  await sql`
    insert into audit_logs (id, workspace_id, actor_id, action, detail)
    values (${nid("aud")}, ${WS}, ${actor}, ${action}, ${detail.slice(0, 400)})
  `;
}

async function ensure(sql: Sql, userId: string) {
  const existing = await sql<{ role: string; display_name: string; email: string; presence: string; notify_pref: string }>`
    select m.role, p.display_name, p.email, p.presence, p.notify_pref
    from memberships m
    join profiles p on p.user_id = m.user_id
    where m.workspace_id = ${WS} and m.user_id = ${userId}
  `;
  if (existing[0]) {
    return {
      role: normalizeRole(existing[0].role),
      name: existing[0].display_name,
      email: existing[0].email,
      presence: existing[0].presence || "active",
      notifyPref: existing[0].notify_pref || "all",
    };
  }
  const people = await sql<{ name: string; email: string }>`
    select "name" as name, "email" as email from "user" where "id" = ${userId}
  `;
  const name = people[0]?.name?.trim() || "Member";
  const email = people[0]?.email ?? "";
  await sql`
    insert into profiles (user_id, display_name, email)
    values (${userId}, ${name}, ${email})
    on conflict (user_id) do update set email = excluded.email
  `;
  await sql`
    insert into workspaces (id, name, slug, created_by)
    values (${WS}, ${"Officium Connect"}, ${"officium"}, ${userId})
    on conflict (id) do nothing
  `;
  const owners = await sql<{ n: number }>`
    select count(*)::int as n from memberships where workspace_id = ${WS} and role = 'owner'
  `;
  const role: Role = initialRole(owners[0]?.n);
  await sql`
    insert into memberships (workspace_id, user_id, role)
    values (${WS}, ${userId}, ${role})
    on conflict (workspace_id, user_id) do nothing
  `;
  for (const [id, chName, topic, description] of CHANNELS) {
    await sql`
      insert into channels (id, workspace_id, name, topic, description, visibility, created_by)
      values (${id}, ${WS}, ${chName}, ${topic}, ${description}, ${"public"}, ${userId})
      on conflict (id) do nothing
    `;
  }
  if (role !== "guest") {
    await sql`
      insert into channel_members (channel_id, user_id)
      select c.id, ${userId} from channels c
      where c.workspace_id = ${WS} and c.visibility = 'public'
      on conflict (channel_id, user_id) do nothing
    `;
  }
  for (const [id, botName, description] of BOTS) {
    await sql`
      insert into bots (id, workspace_id, name, description, enabled, system, created_by)
      values (${id}, ${WS}, ${botName}, ${description}, true, true, ${userId})
      on conflict (id) do nothing
    `;
  }
  for (const [provider, note] of PROVIDERS) {
    await sql`
      insert into integrations (workspace_id, provider, status, note)
      values (${WS}, ${provider}, ${"disconnected"}, ${note})
      on conflict (workspace_id, provider) do nothing
    `;
  }
  const wf = JSON.stringify({
    trigger: { type: "keyword", value: "urgent", channelId: "" },
    match: "all",
    conditions: [],
    actions: [
      { type: "label", value: "Urgent" },
      { type: "notify", value: "A message was marked urgent." },
    ],
  });
  await sql`
    insert into workflows (id, workspace_id, name, description, enabled, config_json, created_by)
    values (
      ${"wf_urgent"}, ${WS}, ${"Urgent keyword"},
      ${"When a message contains urgent, label the thread and notify the team."},
      true, ${wf}, ${userId}
    )
    on conflict (id) do nothing
  `;
  const welcome =
    "Welcome to Officium Message. This channel is for the Officium Connect team. Type /help for bot commands. External providers stay disconnected until server credentials are configured.";
  await sql`
    insert into messages (id, workspace_id, channel_id, author_id, body)
    select ${"msg_welcome"}, ${WS}, ${"ch_general"}, ${"bot:bot_recruitment"}, ${welcome}
    where not exists (select 1 from messages where id = ${"msg_welcome"})
  `;
  const mem = await sql<{ role: string }>`
    select role from memberships where workspace_id = ${WS} and user_id = ${userId}
  `;
  const profile = await sql<{ display_name: string; email: string; presence: string; notify_pref: string }>`
    select display_name, email, presence, notify_pref from profiles where user_id = ${userId}
  `;
  return {
    role: normalizeRole(mem[0]?.role),
    name: profile[0]?.display_name ?? name,
    email: profile[0]?.email ?? email,
    presence: profile[0]?.presence ?? "active",
    notifyPref: profile[0]?.notify_pref ?? "all",
  };
}

async function assertChannel(sql: Sql, userId: string, channelId: string) {
  const rows = await sql<{ visibility: string; archived: boolean; is_member: boolean; role: string | null }>`
    select c.visibility, c.archived,
      exists (
        select 1 from channel_members cm
        where cm.channel_id = c.id and cm.user_id = ${userId}
      ) as is_member,
      m.role
    from channels c
    left join memberships m on m.workspace_id = ${WS} and m.user_id = ${userId}
    where c.id = ${channelId} and c.workspace_id = ${WS}
  `;
  const row = rows[0];
  if (!row || row.archived) throw new Error("Channel not found.");
  if (!canSeeChannel({ visibility: row.visibility, member: Boolean(row.is_member), role: row.role })) {
    throw new Error(row.visibility === "private"
      ? "This private channel is only visible to its members."
      : "This channel is not available to your account.");
  }
}

async function assertConvo(sql: Sql, userId: string, conversationId: string) {
  const m = await sql<{ ok: number }>`
    select 1 as ok from conversation_members where conversation_id = ${conversationId} and user_id = ${userId}
  `;
  if (!m[0]) throw new Error("You are not in this conversation.");
}

async function namesFor(sql: Sql, ids: string[]) {
  const map = new Map<string, string>();
  const humans = [...new Set(ids.filter((id) => id && !id.startsWith("bot:")))];
  const bots = [...new Set(ids.filter((id) => id.startsWith("bot:")).map((id) => id.slice(4)))];
  if (humans.length) {
    const rows = await sql.query<{ user_id: string; display_name: string }>(
      `select user_id, display_name from profiles where user_id in (${humans.map((_, i) => `$${i + 1}`).join(",")})`,
      humans,
    );
    for (const r of rows) map.set(r.user_id, r.display_name);
  }
  if (bots.length) {
    const rows = await sql.query<{ id: string; name: string }>(
      `select id, name from bots where id in (${bots.map((_, i) => `$${i + 1}`).join(",")})`,
      bots,
    );
    for (const r of rows) map.set(`bot:${r.id}`, r.name);
  }
  map.set("bot:system", "Officium Bot");
  return map;
}

type MsgRow = {
  id: string;
  body: string;
  author_id: string;
  created_at: unknown;
  edited_at: unknown;
  deleted: boolean;
  pinned: boolean;
  reply_to_id: string | null;
  attachment_name: string | null;
  attachment_data: string | null;
};

const MESSAGE_PAGE = 80;

async function loadMessages(sql: Sql, column: "channel_id" | "conversation_id", param: string, viewer: string, before?: string) {
  const rows = await sql.query<MsgRow>(
    `select id, body, author_id, created_at, edited_at, deleted, pinned, reply_to_id, attachment_name, attachment_data
     from (
       select id, body, author_id, created_at, edited_at, deleted, pinned, reply_to_id, attachment_name,
              case
                when attachment_data is null then null
                when attachment_data like 'r2:%' or attachment_data like 's3:%' then attachment_data
                when attachment_data like 'data:image/%' and octet_length(attachment_data) <= 20000 then attachment_data
                else ''
              end as attachment_data
       from messages
       where ${column} = $1 and workspace_id = $2
         and ($3::text is null or created_at < $3::timestamptz)
       order by created_at desc
       limit ${MESSAGE_PAGE}
     ) page
     order by created_at asc`,
    [param, WS, before || null],
  );
  const ids = rows.map((r) => r.id);
  const [reacts, authors, memberRows] = await Promise.all([
    ids.length
      ? sql.query<{ message_id: string; user_id: string; emoji: string }>(
          `select message_id, user_id, emoji from reactions where message_id in (${ids.map((_, i) => `$${i + 1}`).join(",")})`,
          ids,
        )
      : Promise.resolve([] as { message_id: string; user_id: string; emoji: string }[]),
    namesFor(sql, rows.map((r) => r.author_id)),
    column === "channel_id"
      ? sql<{ user_id: string; last_read_at: unknown }>`select user_id, last_read_at from channel_reads where channel_id = ${param}`
      : sql<{ user_id: string; last_read_at: unknown }>`select user_id, last_read_at from conversation_members where conversation_id = ${param}`,
  ]);
  return rows.map((r) => {
    const created = iso(r.created_at);
    const others = memberRows.filter((m) => m.user_id !== r.author_id);
    const read = others.some((m) => m.last_read_at && iso(m.last_read_at) >= created);
    return {
      id: r.id,
      body: r.deleted ? "Message deleted" : r.body,
      authorId: r.author_id,
      authorName: authors.get(r.author_id) ?? "Member",
      mine: r.author_id === viewer,
      createdAt: created,
      editedAt: r.edited_at ? iso(r.edited_at) : "",
      deleted: r.deleted,
      pinned: r.pinned,
      replyToId: r.reply_to_id ?? "",
      attachmentName: r.deleted ? "" : (r.attachment_name ?? ""),
      attachmentData: r.deleted || remoteFileId(r.attachment_data) ? "" : (r.attachment_data ?? ""),
      read,
      reactions: reacts.filter((x) => x.message_id === r.id).map((x) => ({ userId: x.user_id, emoji: x.emoji })),
      attachmentFileId: r.deleted ? "" : remoteFileId(r.attachment_data),
    };
  });
}

async function postBot(sql: Sql, target: { channelId?: string; conversationId?: string }, body: string, botId = "bot_recruitment") {
  const enabled = await sql<{ enabled: boolean }>`select enabled from bots where id = ${botId}`;
  if (enabled[0] && enabled[0].enabled === false) return;
  await sql`
    insert into messages (id, workspace_id, channel_id, conversation_id, author_id, body)
    values (${nid("msg")}, ${WS}, ${target.channelId ?? null}, ${target.conversationId ?? null}, ${`bot:${botId}`}, ${body.slice(0, 4000)})
  `;
}

function parseWhen(token: string): Date | null {
  const m = /^(\d+)(m|h|d)$/.exec(token);
  if (!m) return null;
  const n = Number(m[1]);
  const ms = m[2] === "m" ? n * 60_000 : m[2] === "h" ? n * 3_600_000 : n * 86_400_000;
  if (!Number.isFinite(ms) || ms < 60_000 || ms > 30 * 86_400_000) return null;
  return new Date(Date.now() + ms);
}

async function handleCommand(sql: Sql, userId: string, role: string, target: { kind: "channel" | "conversation"; id: string }, body: string) {
  const [head, ...rest] = body.slice(1).trim().split(/\s+/);
  const cmd = (head ?? "").toLowerCase();
  const arg = rest.join(" ").trim();
  const loc = target.kind === "channel" ? { channelId: target.id } : { conversationId: target.id };
  let result = "";
  const bot = "bot_recruitment";
  let speaker = bot;

  if (cmd === "help" || cmd === "workflow-help") {
    result = "Commands: /help, /ask question, /assign me | name, /remind 30m text, /candidate-status name, /summarize, /create-task title, /escalate, /workflow-help. /ask uses the configured AI provider when it is enabled. Other commands are rules.";
  } else if (cmd === "assign") {
    const who = arg || "me";
    let assignee = userId;
    if (who.toLowerCase() !== "me") {
      const found = await sql<{ user_id: string }>`
        select user_id from profiles
        where lower(display_name) = ${who.toLowerCase()} or lower(email) = ${who.toLowerCase()}
        limit 1
      `;
      if (!found[0]) result = `No teammate named "${who}".`;
      else assignee = found[0].user_id;
    }
    if (!result) {
      await sql`
        insert into assignments (id, workspace_id, target_kind, target_id, assignee_id, assigned_by)
        values (${nid("asg")}, ${WS}, ${target.kind}, ${target.id}, ${assignee}, ${userId})
      `;
      const nm = await namesFor(sql, [assignee]);
      result = `Assigned this thread to ${nm.get(assignee) ?? "a teammate"}.`;
      await audit(sql, userId, "assign", result);
    }
  } else if (cmd === "remind") {
    const [when, ...text] = arg.split(/\s+/);
    const due = when ? parseWhen(when) : null;
    const note = text.join(" ").trim();
    if (!due || !note) result = "Use /remind 30m Call the candidate. Units: m, h, d.";
    else {
      await sql`
        insert into reminders (id, workspace_id, user_id, body, due_at)
        values (${nid("rem")}, ${WS}, ${userId}, ${note}, ${due.toISOString()})
      `;
      result = `Reminder saved for ${due.toISOString()}. A scheduler delivers it even if nobody has the app open, once CRON_SECRET is set. Until then it also fires on the next workspace visit.`;
    }
  } else if (cmd === "candidate-status") {
    if (role === "guest") result = "Guests cannot look up candidate notes.";
    else if (!arg) result = "Use /candidate-status <name>. This checks local thread refs only. The CRM is not connected.";
    else {
      const q = `%${arg.replace(/[%_]/g, "").toLowerCase()}%`;
      const refs = await sql<{ target_kind: string; candidate_ref: string | null; status: string }>`
        select target_kind, candidate_ref, status from thread_meta
        where lower(coalesce(candidate_ref, '')) like ${q}
        limit 5
      `;
      result = refs.length
        ? `Local records only (CRM not connected):\n${refs.map((r) => `${r.candidate_ref} · ${r.status} · ${r.target_kind}`).join("\n")}`
        : `No local candidate ref matching "${arg}". The CRM integration is disconnected, so nothing was fetched from it.`;
    }
  } else if (cmd === "ask") {
    if (!arg) result = "Use /ask followed by a question. This does not send anything outside the workspace.";
    else if (role === "guest") result = "Guests cannot use the assistant.";
    else {
      const settings = await readAiSettings(sql);
      const asks = await sql<{ n: number }>`
        select count(*)::int as n from bot_logs
        where actor_id = ${userId} and command = '/ask' and created_at > now() - interval '1 hour'
      `;
      if ((asks[0]?.n ?? 0) >= 20) {
        result = "AI limit for this hour is reached. Nothing was generated.";
      } else if (!settings.configured || !settings.enabled) {
        result = settings.configured
          ? "AI replies are turned off in Settings. Nothing was generated."
          : "AI is not configured. Add XAI_API_KEY on the server. Nothing was generated.";
      } else {
        const history = target.kind === "channel"
          ? await sql<{ body: string; author_id: string }>`
              select body, author_id from messages where channel_id = ${target.id} and deleted = false
              order by created_at desc limit 8
            `
          : await sql<{ body: string; author_id: string }>`
              select body, author_id from messages where conversation_id = ${target.id} and deleted = false
              order by created_at desc limit 8
            `;
        const lines = history.reverse().map((row) => ({ role: "user" as const, content: row.body.slice(0, 300) }));
        const answer = await askModel(arg, lines);
        if (!answer.ok) result = answer.error;
        else if (settings.requireApproval) {
          await sql`
            insert into ai_drafts (id, workspace_id, target_kind, target_id, body, created_by)
            values (${nid("draft")}, ${WS}, ${target.kind}, ${target.id}, ${answer.text}, ${userId})
          `;
          result = "Draft saved for approval. It has not been posted to the thread.";
        } else {
          result = answer.text;
        }
      }
    }
  } else if (cmd === "summarize") {
    const recent = target.kind === "channel"
      ? await sql<{ body: string }>`
          select body from messages
          where channel_id = ${target.id} and deleted = false and author_id not like 'bot:%'
          order by created_at desc limit 8
        `
      : await sql<{ body: string }>`
          select body from messages
          where conversation_id = ${target.id} and deleted = false and author_id not like 'bot:%'
          order by created_at desc limit 8
        `;
    const lines = recent.reverse().map((r) => r.body.replace(/\s+/g, " ").slice(0, 140));
    result = lines.length
      ? `Rule-based summary of the last ${lines.length} human messages:\n- ${lines.join("\n- ")}`
      : "Nothing to summarize yet.";
  } else if (cmd === "create-task") {
    if (!arg) result = "Use /create-task <title>.";
    else {
      await sql`
        insert into tasks (id, workspace_id, title, assignee_id, created_by, source)
        values (${nid("tsk")}, ${WS}, ${arg.slice(0, 200)}, ${userId}, ${userId}, ${"command"})
      `;
      result = `Task created: ${arg.slice(0, 200)}`;
    }
  } else if (cmd === "escalate") {
    await sql`
      insert into labels (id, workspace_id, target_kind, target_id, label, created_by)
      values (${nid("lbl")}, ${WS}, ${target.kind}, ${target.id}, ${"Urgent"}, ${userId})
      on conflict (target_kind, target_id, label) do nothing
    `;
    const admins = await sql<{ user_id: string }>`
      select user_id from memberships
      where workspace_id = ${WS} and role in ('owner', 'administrator', 'manager')
    `;
    for (const a of admins) {
      await sql`
        insert into notifications (id, workspace_id, user_id, body)
        values (${nid("ntf")}, ${WS}, ${a.user_id}, ${"A thread was escalated and needs a human."})
      `;
    }
    result = "Escalated. Urgent label added and administrators were notified inside Officium Message. No external message was sent.";
    await audit(sql, userId, "escalate", target.id);
  } else {
    const wanted = cmd.replace(/[^a-z0-9]/g, "");
    const customs = await sql<{ id: string; name: string; description: string; enabled: boolean }>`
      select id, name, description, enabled from bots where workspace_id = ${WS} and system = false
    `;
    const hit = customs.find((b) => b.name.toLowerCase().replace(/[^a-z0-9]/g, "") === wanted);
    if (!wanted || !hit) result = `Unknown command /${cmd}. Type /help. A custom bot replies to its name with spaces removed, for example /followup.`;
    else if (!hit.enabled) result = `${hit.name} is turned off. A manager can enable it under Bots.`;
    else result = hit.description.trim() || `${hit.name} received /${wanted}. Add a description on the bot to change this reply.`;
    if (hit?.enabled) speaker = hit.id;
  }

  await sql`
    insert into bot_logs (id, workspace_id, bot_id, command, result, actor_id)
    values (${nid("log")}, ${WS}, ${bot}, ${`/${cmd}`}, ${result.slice(0, 500)}, ${userId})
  `;
  const speakerFor = cmd === "summarize" ? "bot_summary" : cmd === "remind" ? "bot_reminder" : speaker;
  await postBot(sql, loc, result, speakerFor);
}

type Action = { type: string; value: string };
type WfConfig = {
  trigger: { type: string; value: string; channelId?: string };
  actions: Action[];
};

function matchesTrigger(cfg: WfConfig, msg: { body: string; channelId: string | null }) {
  const t = cfg.trigger;
  if (!t) return false;
  const value = (t.value ?? "").toLowerCase();
  const body = msg.body.toLowerCase();
  if (t.channelId && msg.channelId !== t.channelId) return false;
  if (t.type === "keyword") return value.length > 0 && body.includes(value);
  if (t.type === "mention") return value.length > 0 && body.includes(`@${value}`);
  if (t.type === "channel_message") return Boolean(msg.channelId);
  return false;
}

async function applyAction(sql: Sql, userId: string, target: { kind: "channel" | "conversation"; id: string }, action: Action) {
  const loc = target.kind === "channel" ? { channelId: target.id } : { conversationId: target.id };
  if (action.type === "reply") {
    await postBot(sql, loc, action.value || "Automated reply.", "bot_support");
    return "Replied in thread.";
  }
  if (action.type === "label") {
    const label = LABELS.includes(action.value as (typeof LABELS)[number]) ? action.value : "Internal";
    await sql`
      insert into labels (id, workspace_id, target_kind, target_id, label, created_by)
      values (${nid("lbl")}, ${WS}, ${target.kind}, ${target.id}, ${label}, ${"bot:system"})
      on conflict (target_kind, target_id, label) do nothing
    `;
    return `Label ${label} added.`;
  }
  if (action.type === "task") {
    await sql`
      insert into tasks (id, workspace_id, title, created_by, source)
      values (${nid("tsk")}, ${WS}, ${(action.value || "Follow up").slice(0, 200)}, ${userId}, ${"workflow"})
    `;
    return "Task created.";
  }
  if (action.type === "note") {
    await sql`
      insert into notes (id, workspace_id, target_kind, target_id, body, author_id)
      values (${nid("nte")}, ${WS}, ${target.kind}, ${target.id}, ${(action.value || "Workflow note").slice(0, 1000)}, ${"bot:system"})
    `;
    return "Note added.";
  }
  if (action.type === "notify") {
    const members = await sql<{ user_id: string; notify_pref: string }>`
      select m.user_id, p.notify_pref from memberships m
      join profiles p on p.user_id = m.user_id
      where m.workspace_id = ${WS} and m.user_id <> ${userId}
    `;
    for (const m of members) {
      if (m.notify_pref === "off") continue;
      await sql`
        insert into notifications (id, workspace_id, user_id, body)
        values (${nid("ntf")}, ${WS}, ${m.user_id}, ${(action.value || "Workflow notification").slice(0, 240)})
      `;
    }
    return "In-app notifications created. Nothing was sent outside Officium Message.";
  }
  if (action.type === "webhook") {
    const url = action.value || process.env.OFFICIUM_WEBHOOK_URL || "";
    if (!url) throw new Error("Webhook URL is not configured. This run was not marked successful.");
    return await postWebhook(url, {
      workspaceId: WS,
      target,
      actorId: userId,
    }, process.env.OFFICIUM_WEBHOOK_SECRET);
  }
  if (action.type === "whatsapp" || action.type === "telegram" || action.type === "email" || action.type === "calendar" || action.type === "external_task") {
    return dispatchExternal(sql, action);
  }
  throw new Error(`Unknown action ${action.type}`);
}

async function dispatchExternal(sql: Sql, action: Action) {
  if (action.type === "whatsapp" || action.type === "telegram") {
    const split = action.value.trim().indexOf(" ");
    const to = split > 0 ? action.value.trim().slice(0, split) : "";
    const text = split > 0 ? action.value.trim().slice(split + 1).trim() : "";
    if (!to || !text) throw new Error(`${action.type} needs a recipient and a message. Nothing was sent.`);
    const sent = action.type === "whatsapp" ? await sendWhatsappText(to, text) : await sendTelegramText(to, text);
    if (!sent.ok) throw new Error(sent.error);
    await sql`
      insert into provider_events (id, provider, direction, external_id, status, detail)
      values (${nid("pev")}, ${action.type}, ${"out"}, ${sent.externalId || null}, ${"accepted"}, ${sent.detail})
    `;
    return sent.detail;
  }
  if (action.type === "email") {
    const parts = action.value.split("|").map((part) => part.trim());
    const [to, subject, ...rest] = parts;
    if (!to || !subject || rest.join(" ").trim() === "") throw new Error("Email action needs to | subject | message. Nothing was sent.");
    const sent = await sendEmailMessage(to, subject, rest.join(" | "));
    if (!sent.ok) throw new Error(sent.error);
    await sql`
      insert into provider_events (id, provider, direction, external_id, status, detail)
      values (${nid("pev")}, ${"email"}, ${"out"}, ${""}, ${"accepted"}, ${sent.detail})
    `;
    return sent.detail;
  }
  if (action.type === "calendar") {
    const [title, start] = action.value.split("|").map((part) => part.trim());
    if (!title || !start) throw new Error("Calendar action needs title | start time. No event was created.");
    const sent = await createCalendarEvent(title, start);
    if (!sent.ok) throw new Error(sent.error);
    await sql`
      insert into provider_events (id, provider, direction, external_id, status, detail)
      values (${nid("pev")}, ${"calendar"}, ${"out"}, ${sent.externalId}, ${"created"}, ${sent.detail})
    `;
    return sent.detail;
  }
  const sent = await postExternalTask(action.value || "Follow up");
  if (!sent.ok) throw new Error(sent.error);
  return sent.detail;
}

async function runWorkflowsForMessage(sql: Sql, userId: string, target: { kind: "channel" | "conversation"; id: string }, messageId: string, body: string) {
  if (body.startsWith("/")) return;
  const rows = await sql<{ id: string; config_json: string }>`
    select id, config_json from workflows where workspace_id = ${WS} and enabled = true
  `;
  for (const w of rows) {
    let cfg: WfConfig;
    try {
      cfg = JSON.parse(w.config_json) as WfConfig;
    } catch {
      continue;
    }
    const channelId = target.kind === "channel" ? target.id : null;
    if (!matchesTrigger(cfg, { body, channelId })) continue;
    const seen = await sql<{ ok: number }>`
      select 1 as ok from workflow_runs where workflow_id = ${w.id} and message_id = ${messageId} limit 1
    `;
    if (seen[0]) continue;
    const bits: string[] = [];
    try {
      for (const action of cfg.actions ?? []) bits.push(await applyAction(sql, userId, target, action));
      await sql`
        insert into workflow_runs (id, workflow_id, workspace_id, message_id, status, detail)
        values (${nid("run")}, ${w.id}, ${WS}, ${messageId}, ${"success"}, ${bits.join(" ") || "No actions."})
      `;
      await sql`update workflows set last_run_at = now() where id = ${w.id}`;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Workflow failed";
      await sql`
        insert into workflow_runs (id, workflow_id, workspace_id, message_id, status, detail)
        values (${nid("run")}, ${w.id}, ${WS}, ${messageId}, ${"failed"}, ${redactSecrets(message)})
      `;
      const webhook = (cfg.actions ?? []).find((action) => action.type === "webhook");
      if (webhook?.value || process.env.OFFICIUM_WEBHOOK_URL) {
        await enqueueJob(sql, "webhook", {
          url: webhook?.value || process.env.OFFICIUM_WEBHOOK_URL,
          body: { workflowId: w.id, messageId, failed: true },
        }, `retry:${w.id}:${messageId}`, 60_000);
      }
    }
  }
}

async function threadSide(sql: Sql, kind: string, id: string) {
  const [labels, notes, assign, meta] = await Promise.all([
    sql<{ label: string }>`select label from labels where target_kind = ${kind} and target_id = ${id}`,
    sql<{ id: string; body: string; author_id: string; created_at: unknown }>`
      select id, body, author_id, created_at from notes
      where target_kind = ${kind} and target_id = ${id}
      order by created_at desc limit 20
    `,
    sql<{ assignee_id: string }>`
      select assignee_id from assignments
      where target_kind = ${kind} and target_id = ${id}
      order by created_at desc limit 1
    `,
    sql<{ follow_up_on: string | null; candidate_ref: string | null; status: string }>`
      select follow_up_on, candidate_ref, status from thread_meta
      where target_kind = ${kind} and target_id = ${id}
    `,
  ]);
  const authorIds = notes.map((n) => n.author_id).concat(assign[0] ? [assign[0].assignee_id] : []);
  const names = await namesFor(sql, authorIds);
  return {
    labels: labels.map((l) => l.label),
    notes: notes.map((n) => ({
      id: n.id,
      body: n.body,
      authorName: names.get(n.author_id) ?? "Member",
      createdAt: iso(n.created_at),
    })),
    assigneeName: assign[0] ? names.get(assign[0].assignee_id) ?? "Member" : "",
    followUpOn: meta[0]?.follow_up_on ?? "",
    candidateRef: meta[0]?.candidate_ref ?? "",
    status: meta[0]?.status ?? "open",
  };
}

async function latestPreview(sql: Sql, column: "channel_id" | "conversation_id", ids: string[]) {
  const out = new Map<string, { preview: string; at: string }>();
  if (!ids.length) return out;
  const rows = await sql.query<{ id: string; body: string; created_at: unknown }>(
    `select distinct on (${column}) ${column} as id, body, created_at
     from messages
     where deleted = false and ${column} in (${ids.map((_, i) => `$${i + 1}`).join(",")})
     order by ${column}, created_at desc`,
    ids,
  );
  for (const row of rows) out.set(row.id, { preview: (row.body ?? "").slice(0, 80), at: iso(row.created_at) });
  return out;
}

async function sidebar(sql: Sql, userId: string, role: string) {
  const [channels, convos] = await Promise.all([
    sql<{ id: string; name: string; topic: string; visibility: string; description: string }>`
      select c.id, c.name, c.topic, c.visibility, c.description
      from channels c
      where c.workspace_id = ${WS} and c.archived = false
        and (
          exists (select 1 from channel_members cm where cm.channel_id = c.id and cm.user_id = ${userId})
          or (c.visibility = 'public' and ${role} in ('owner', 'administrator', 'manager', 'member'))
        )
      order by c.name
    `,
    sql<{ id: string; kind: string; name: string; muted: boolean }>`
      select c.id, c.kind, c.name, m.muted
      from conversations c
      join conversation_members m on m.conversation_id = c.id and m.user_id = ${userId}
      where c.workspace_id = ${WS} and c.archived = false
      order by c.created_at desc
    `,
  ]);
  const channelIds = channels.map((c) => c.id);
  const convoIds = convos.map((c) => c.id);
  const [channelPreview, convoPreview, channelUnread, convoUnread, parts] = await Promise.all([
    latestPreview(sql, "channel_id", channelIds),
    latestPreview(sql, "conversation_id", convoIds),
    channelIds.length
      ? sql.query<{ channel_id: string; n: number }>(
          `select m.channel_id, count(*)::int as n
           from messages m
           left join channel_reads r on r.channel_id = m.channel_id and r.user_id = $1
           where m.deleted = false and m.author_id <> $1
             and m.channel_id in (${channelIds.map((_, i) => `$${i + 2}`).join(",")})
             and m.created_at > coalesce(r.last_read_at, '1970-01-01'::timestamptz)
           group by m.channel_id`,
          [userId, ...channelIds],
        )
      : Promise.resolve([] as { channel_id: string; n: number }[]),
    convoIds.length
      ? sql.query<{ conversation_id: string; n: number }>(
          `select m.conversation_id, count(*)::int as n
           from messages m
           join conversation_members cm on cm.conversation_id = m.conversation_id and cm.user_id = $1
           where m.deleted = false and m.author_id <> $1
             and m.conversation_id in (${convoIds.map((_, i) => `$${i + 2}`).join(",")})
             and m.created_at > coalesce(cm.last_read_at, '1970-01-01'::timestamptz)
           group by m.conversation_id`,
          [userId, ...convoIds],
        )
      : Promise.resolve([] as { conversation_id: string; n: number }[]),
    convos.length
      ? sql.query<{ conversation_id: string; user_id: string; display_name: string; presence: string }>(
          `select cm.conversation_id, cm.user_id, p.display_name, p.presence
           from conversation_members cm join profiles p on p.user_id = cm.user_id
           where cm.conversation_id in (${convos.map((_, i) => `$${i + 1}`).join(",")})`,
          convos.map((c) => c.id),
        )
      : Promise.resolve([] as { conversation_id: string; user_id: string; display_name: string; presence: string }[]),
  ]);
  const unreadC = new Map(channelUnread.map((r) => [r.channel_id, r.n]));
  const unreadD = new Map(convoUnread.map((r) => [r.conversation_id, r.n]));
  return {
    channels: channels.map((c) => {
      const p = channelPreview.get(c.id);
      return { ...c, preview: p?.preview ?? "", at: p?.at ?? "", unread: unreadC.get(c.id) ?? 0 };
    }),
    conversations: convos.map((c) => {
      const people = parts.filter((p) => p.conversation_id === c.id && p.user_id !== userId);
      const title = c.kind === "dm" ? (people.map((p) => p.display_name).join(", ") || "Direct message") : (c.name || "Group");
      const p = convoPreview.get(c.id);
      return {
        id: c.id,
        kind: c.kind,
        name: title,
        muted: c.muted,
        presence: c.kind === "dm" ? (people[0]?.presence ?? "offline") : "",
        preview: p?.preview ?? "",
        at: p?.at ?? "",
        unread: unreadD.get(c.id) ?? 0,
      };
    }),
  };
}

const focusSchema = z.object({
  kind: z.enum(["channel", "conversation"]).optional(),
  id: z.string().max(80).optional(),
});

export const bootstrap = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    const me = await ensure(sql, context.userId);
    const staff = isStaff(me.role);
    const [
      ,
      side,
      members,
      tasks,
      reminders,
      workflows,
      runs,
      bots,
      logs,
      integrations,
      notesN,
      notifications,
      ai,
      drafts,
    ] = await Promise.all([
      sql`update profiles set presence = 'active' where user_id = ${context.userId}`,
      sidebar(sql, context.userId, me.role),
      sql<{ user_id: string; display_name: string; email: string; role: string; presence: string }>`
        select p.user_id, p.display_name, p.email, m.role, p.presence
        from memberships m join profiles p on p.user_id = m.user_id
        where m.workspace_id = ${WS}
        order by p.display_name
      `,
      sql<{ id: string; title: string; status: string; created_at: unknown }>`
        select id, title, status, created_at from tasks where workspace_id = ${WS} order by created_at desc limit 40
      `,
      sql<{ id: string; body: string; due_at: unknown; done: boolean }>`
        select id, body, due_at, done from reminders
        where workspace_id = ${WS} and user_id = ${context.userId}
        order by due_at asc limit 30
      `,
      staff
        ? sql<{ id: string; name: string; description: string; enabled: boolean; config_json: string; last_run_at: unknown }>`
            select id, name, description, enabled, config_json, last_run_at from workflows where workspace_id = ${WS} order by created_at
          `
        : Promise.resolve([] as { id: string; name: string; description: string; enabled: boolean; config_json: string; last_run_at: unknown }[]),
      staff
        ? sql<{ id: string; workflow_id: string; status: string; detail: string; created_at: unknown }>`
            select id, workflow_id, status, detail, created_at from workflow_runs where workspace_id = ${WS} order by created_at desc limit 30
          `
        : Promise.resolve([] as { id: string; workflow_id: string; status: string; detail: string; created_at: unknown }[]),
      staff
        ? sql<{ id: string; name: string; description: string; enabled: boolean; system: boolean }>`
            select id, name, description, enabled, system from bots where workspace_id = ${WS} order by name
          `
        : Promise.resolve([] as { id: string; name: string; description: string; enabled: boolean; system: boolean }[]),
      staff
        ? sql<{ id: string; command: string; result: string; created_at: unknown }>`
            select id, command, result, created_at from bot_logs where workspace_id = ${WS} order by created_at desc limit 20
          `
        : Promise.resolve([] as { id: string; command: string; result: string; created_at: unknown }[]),
      staff
        ? sql<{ provider: string; status: string; note: string }>`
            select provider, status, note from integrations where workspace_id = ${WS} order by provider
          `
        : Promise.resolve([] as { provider: string; status: string; note: string }[]),
      sql<{ n: number }>`select count(*)::int as n from notifications where user_id = ${context.userId} and read = false`,
      sql<{ id: string; body: string; read: boolean; created_at: unknown }>`
        select id, body, read, created_at from notifications where user_id = ${context.userId} order by created_at desc limit 25
      `,
      readAiSettings(sql),
      staff
        ? sql<{ id: string; target_kind: string; target_id: string; body: string; created_at: unknown }>`
            select id, target_kind, target_id, body, created_at from ai_drafts
            where workspace_id = ${WS} and status = 'pending'
            order by created_at desc limit 20
          `
        : Promise.resolve([] as { id: string; target_kind: string; target_id: string; body: string; created_at: unknown }[]),
    ]);
    return {
      me: { id: context.userId, ...me },
      workspace: { id: WS, name: "Officium Connect" },
      labels: [...LABELS],
      ...side,
      members: members.map((m) => ({ ...m, email: me.role === "guest" ? "" : m.email })),
      tasks: tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, createdAt: iso(t.created_at) })),
      reminders: reminders.map((r) => ({ id: r.id, body: r.body, dueAt: iso(r.due_at), done: r.done })),
      workflows: workflows.map((w) => ({
        id: w.id, name: w.name, description: w.description, enabled: w.enabled,
        configJson: w.config_json, lastRunAt: w.last_run_at ? iso(w.last_run_at) : "",
      })),
      runs: runs.map((r) => ({ id: r.id, workflowId: r.workflow_id, status: r.status, detail: r.detail, createdAt: iso(r.created_at) })),
      bots,
      logs: logs.map((l) => ({ id: l.id, command: l.command, result: l.result, createdAt: iso(l.created_at) })),
      integrations,
      unreadNotifications: notesN[0]?.n ?? 0,
      notifications: notifications.map((n) => ({ id: n.id, body: n.body, read: n.read, createdAt: iso(n.created_at) })),
      ai: { configured: ai.configured, enabled: ai.enabled, requireApproval: ai.requireApproval, model: ai.model, storage: ai.storage, maxBytes: ai.maxBytes },
      drafts: drafts.map((d) => ({ id: d.id, targetKind: d.target_kind, targetId: d.target_id, body: d.body, createdAt: iso(d.created_at) })),
    };
  });

async function sweepPendingUploads(sql: Sql) {
  const old = await sql<{ id: string; object_key: string | null }>`
    select id, object_key from stored_files
    where status = 'pending' and created_at < now() - interval '1 day'
    limit 20
  `;
  if (storageConfigured()) {
    for (const row of old) {
      if (row.object_key) {
        try { await removeObject(row.object_key); } catch { continue; }
      }
      await sql`delete from stored_files where id = ${row.id} and status = 'pending'`;
    }
    const doomed = await sql<{ id: string; object_key: string | null }>`
      select id, object_key from stored_files
      where status = 'delete_pending' and object_key is not null
      limit 20
    `;
    for (const row of doomed) {
      if (!row.object_key) continue;
      try {
        await removeObject(row.object_key);
      } catch {
        continue;
      }
      await sql`delete from stored_files where id = ${row.id} and status = 'delete_pending'`;
    }
  }
}

export async function runMaintenance(sql: Sql) {
  const reminders = await deliverDueReminders(sql);
  const jobs = await runDueJobs(sql);
  let schedules = 0;
  await runScheduledWorkflows(sql, async (workflowId, config) => {
    schedules += 1;
    await executeWorkflowConfig(sql, "bot:system", workflowId, config, true);
  });
  await runUnanswered(sql);
  try {
    await sweepPendingUploads(sql);
  } catch {
    /* a storage cleanup failure must not block reminders */
  }
  return { reminders, jobs, schedules };
}

async function executeWorkflowConfig(sql: Sql, userId: string, workflowId: string, config: string, scheduled: boolean) {
  const cfg = JSON.parse(config) as WfConfig;
  const channelId = cfg.trigger?.channelId || "ch_logs";
  const target = { kind: "channel" as const, id: channelId };
  const minutes = Number(cfg.trigger?.value);
  const bucket = scheduled && Number.isFinite(minutes) && minutes >= 5 ? Math.floor(Date.now() / (minutes * 60_000)) : Date.now();
  const messageId = scheduled ? `sched:${workflowId}:${bucket}` : `once:${workflowId}:${bucket}`;
  try {
    await sql`
      insert into workflow_runs (id, workflow_id, workspace_id, message_id, status, detail)
      values (${nid("run")}, ${workflowId}, ${WS}, ${messageId}, ${"running"}, ${"Started."})
    `;
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (/unique|duplicate/i.test(message)) {
      await sql`update workflows set last_run_at = now() where id = ${workflowId}`;
      return;
    }
    throw err;
  }
  const bits: string[] = [];
  try {
    for (const action of cfg.actions ?? []) bits.push(await applyAction(sql, userId, target, action));
    await sql`
      update workflow_runs set status = 'success', detail = ${bits.join(" ") || "No actions."}
      where workflow_id = ${workflowId} and message_id = ${messageId}
    `;
    await sql`update workflows set last_run_at = now() where id = ${workflowId}`;
  } catch (err) {
    const message = redactSecrets(err instanceof Error ? err.message : "Workflow failed");
    await sql`
      update workflow_runs set status = 'failed', detail = ${message}
      where workflow_id = ${workflowId} and message_id = ${messageId}
    `;
    await sql`update workflows set last_run_at = now() where id = ${workflowId}`;
  }
}

async function runUnanswered(sql: Sql) {
  const rows = await sql<{ id: string; config_json: string }>`
    select id, config_json from workflows where workspace_id = ${WS} and enabled = true
  `;
  for (const row of rows) {
    let cfg: WfConfig;
    try { cfg = JSON.parse(row.config_json) as WfConfig; } catch { continue; }
    if (cfg.trigger?.type !== "unanswered") continue;
    const minutes = Number(cfg.trigger.value);
    if (!Number.isFinite(minutes) || minutes < 5) continue;
    const waiting = await sql<{ id: string; channel_id: string; body: string }>`
      select m.id, m.channel_id, m.body from messages m
      where m.workspace_id = ${WS}
        and m.channel_id is not null
        and m.deleted = false
        and m.author_id not like 'bot:%'
        and m.created_at < now() - (${String(minutes)} || ' minutes')::interval
        and m.created_at > now() - interval '7 days'
        and (${cfg.trigger.channelId || ""} = '' or m.channel_id = ${cfg.trigger.channelId || ""})
        and not exists (
          select 1 from messages later
          where later.channel_id = m.channel_id and later.created_at > m.created_at
            and later.deleted = false and later.author_id not like 'bot:%'
        )
        and not exists (
          select 1 from workflow_runs r where r.workflow_id = ${row.id} and r.message_id = m.id
        )
      order by m.created_at asc
      limit 3
    `;
    for (const message of waiting) {
      const target = { kind: "channel" as const, id: message.channel_id };
      const bits: string[] = [];
      try {
        await sql`
          insert into workflow_runs (id, workflow_id, workspace_id, message_id, status, detail)
          values (${nid("run")}, ${row.id}, ${WS}, ${message.id}, ${"running"}, ${"Unanswered check."})
        `;
        for (const action of cfg.actions ?? []) bits.push(await applyAction(sql, "bot:system", target, action));
        await sql`update workflow_runs set status = 'success', detail = ${bits.join(" ") || "No actions."} where workflow_id = ${row.id} and message_id = ${message.id}`;
        await sql`update workflows set last_run_at = now() where id = ${row.id}`;
      } catch (err) {
        const detail = redactSecrets(err instanceof Error ? err.message : "Workflow failed");
        if (/unique|duplicate/i.test(detail)) continue;
        await sql`
          update workflow_runs set status = 'failed', detail = ${detail}
          where workflow_id = ${row.id} and message_id = ${message.id}
        `;
      }
    }
  }
}

export const pulse = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => focusSchema.parse(input ?? {}))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const me = await ensure(sql, context.userId);
    const now = Date.now();
    const gate = globalThis as typeof globalThis & { __officiumMaintAt?: number };
    const due = !gate.__officiumMaintAt || now - gate.__officiumMaintAt > 60_000;
    if (due) gate.__officiumMaintAt = now;
    if (data.kind && data.id) {
      if (data.kind === "channel") await assertChannel(sql, context.userId, data.id);
      else await assertConvo(sql, context.userId, data.id);
    }
    const key = data.kind && data.id ? `${data.kind}:${data.id}` : "";
    const [maintenance, side, messages, detail, typingRows, unreadNotifications] = await Promise.all([
      due ? runMaintenance(sql) : Promise.resolve({ reminders: [] as string[], jobs: 0, schedules: 0 }),
      sidebar(sql, context.userId, me.role),
      data.kind && data.id
        ? loadMessages(sql, data.kind === "channel" ? "channel_id" : "conversation_id", data.id, context.userId)
        : Promise.resolve([] as Awaited<ReturnType<typeof loadMessages>>),
      data.kind && data.id
        ? threadSide(sql, data.kind, data.id)
        : Promise.resolve(null as Awaited<ReturnType<typeof threadSide>> | null),
      key
        ? sql<{ display_name: string }>`
            select p.display_name from typing t
            join profiles p on p.user_id = t.user_id
            where t.target_key = ${key} and t.user_id <> ${context.userId}
              and t.updated_at > now() - interval '4 seconds'
          `
        : Promise.resolve([] as { display_name: string }[]),
      sql<{ n: number }>`
        select count(*)::int as n from notifications where user_id = ${context.userId} and read = false
      `,
    ]);
    const typing = typingRows.map((t) => ({ name: t.display_name }));
    return {
      ...side,
      messages,
      olderAvailable: messages.length >= MESSAGE_PAGE,
      detail,
      typing,
      firedReminders: maintenance.reminders,
      unreadNotifications: unreadNotifications[0]?.n ?? 0,
    };
  });

export const olderMessages = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({
    kind: z.enum(["channel", "conversation"]),
    id: z.string().min(1).max(80),
    before: z.string().min(1).max(40),
  }).parse(input))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await ensure(sql, context.userId);
    if (data.kind === "channel") await assertChannel(sql, context.userId, data.id);
    else await assertConvo(sql, context.userId, data.id);
    const messages = await loadMessages(
      sql,
      data.kind === "channel" ? "channel_id" : "conversation_id",
      data.id,
      context.userId,
      data.before,
    );
    return { ok: true as const, messages };
  });

const sendSchema = z.object({
  kind: z.enum(["channel", "conversation"]),
  id: z.string().min(1).max(80),
  body: z.string().max(4000),
  replyToId: z.string().max(80).optional(),
  attachmentName: z.string().max(120).optional(),
  attachmentData: z.string().max(8_500_000).optional(),
  attachmentFileId: z.string().max(40).optional(),
});

export const sendMessage = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => sendSchema.parse(input))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const me = await ensure(sql, context.userId);
    if (data.kind === "channel") await assertChannel(sql, context.userId, data.id);
    else await assertConvo(sql, context.userId, data.id);
    const body = clean(data.body, 4000);
    let attachmentName = data.attachmentName ? clean(data.attachmentName, 120) : "";
    const attachmentData = data.attachmentData ?? "";
    if (data.attachmentFileId && attachmentData) return { ok: false as const, error: "Send the file once, either by upload link or as a small preview." };
    if (!body && !attachmentName && !data.attachmentFileId) return { ok: false as const, error: "Write a message or attach a file." };
    const recent = await sql<{ n: number }>`
      select count(*)::int as n from messages
      where author_id = ${context.userId} and created_at > now() - interval '1 minute'
    `;
    if ((recent[0]?.n ?? 0) > 30) return { ok: false as const, error: "Too many messages in the last minute. Wait and try again." };
    let storedAttachment: string | null = null;
    let fileId = "";
    if (data.attachmentFileId) {
      if (!storageConfigured()) return { ok: false as const, error: storageSetupMessage() };
      const pendingId = data.attachmentFileId;
      if (!/^file_[a-f0-9]{18}$/.test(pendingId)) return { ok: false as const, error: "Unknown file." };
      const files = await sql<{ object_key: string | null; content_type: string; size_bytes: number; name: string }>`
        select object_key, content_type, size_bytes, name from stored_files
        where id = ${pendingId} and created_by = ${context.userId} and status = 'pending' and storage = 'r2'
      `;
      const file = files[0];
      if (!file?.object_key) return { ok: false as const, error: "That upload expired or does not belong to you." };
      const confirmed = await confirmObject(file.object_key, file.content_type, file.size_bytes);
      if (!confirmed.ok) return confirmed;
      fileId = pendingId;
      if (!attachmentName) attachmentName = file.name;
      storedAttachment = remotePointer(fileId);
    } else if (attachmentData) {
      const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(attachmentData);
      if (!match) return { ok: false as const, error: "Attachment must be a file preview." };
      const bytes = Buffer.from(match[2] ?? "", "base64");
      const allowed = allowFile(match[1] ?? "", bytes.length, storageConfigured());
      if (!allowed.ok) return { ok: false as const, error: allowed.error };
      if (!matchesDeclaredType(allowed.type, bytes.subarray(0, 32))) {
        return { ok: false as const, error: "The file contents do not match the declared type." };
      }
      fileId = nid("file");
      if (storageConfigured()) {
        let key = "";
        try {
          key = objectKeyFor(fileId);
          await putObject(key, bytes, allowed.type);
          await sql`
            insert into stored_files (id, message_id, name, content_type, size_bytes, storage, object_key, created_by, status)
            values (${fileId}, ${"pending"}, ${attachmentName || "file"}, ${allowed.type}, ${bytes.length}, ${"r2"}, ${key}, ${context.userId}, ${"ready"})
          `;
          storedAttachment = remotePointer(fileId);
        } catch (err) {
          if (key) {
            try { await removeObject(key); } catch { /* the row was not saved, so a later sweep cannot see this object */ }
          }
          const fallback = allowed.type.startsWith("image/") && bytes.length <= 1_500_000;
          if (!fallback) return { ok: false as const, error: err instanceof Error ? err.message : "Could not store the file." };
          storedAttachment = attachmentData;
          await sql`
            insert into stored_files (id, message_id, name, content_type, size_bytes, storage, inline_data, created_by, status)
            values (${fileId}, ${"pending"}, ${attachmentName || "file"}, ${allowed.type}, ${bytes.length}, ${"database"}, ${attachmentData}, ${context.userId}, ${"ready"})
          `;
        }
      } else {
        storedAttachment = attachmentData;
        await sql`
          insert into stored_files (id, message_id, name, content_type, size_bytes, storage, inline_data, created_by, status)
          values (${fileId}, ${"pending"}, ${attachmentName || "file"}, ${allowed.type}, ${bytes.length}, ${"database"}, ${attachmentData}, ${context.userId}, ${"ready"})
        `;
      }
    }
    const messageId = nid("msg");
    if (fileId) {
      await sql`update stored_files set message_id = ${messageId}, status = 'ready' where id = ${fileId}`;
    }
    await sql`
      insert into messages (id, workspace_id, channel_id, conversation_id, author_id, body, reply_to_id, attachment_name, attachment_data)
      values (
        ${messageId}, ${WS},
        ${data.kind === "channel" ? data.id : null},
        ${data.kind === "conversation" ? data.id : null},
        ${context.userId},
        ${body || `Shared ${attachmentName}`},
        ${data.replyToId || null},
        ${attachmentName || null},
        ${storedAttachment}
      )
    `;
    if (body.startsWith("/")) await handleCommand(sql, context.userId, me.role, { kind: data.kind, id: data.id }, body);
    else await runWorkflowsForMessage(sql, context.userId, { kind: data.kind, id: data.id }, messageId, body);
    return { ok: true as const };
  });

export const prepareUpload = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({
    kind: z.enum(["channel", "conversation"]),
    id: z.string().min(1).max(80),
    name: z.string().min(1).max(120),
    contentType: z.string().min(1).max(120),
    size: z.number().int().positive().max(8_000_000),
  }).parse(input))
  .handler(async ({ context, data }) => {
    if (!storageConfigured()) return { ok: false as const, error: storageSetupMessage() };
    const sql = await getSql();
    await ensure(sql, context.userId);
    if (data.kind === "channel") await assertChannel(sql, context.userId, data.id);
    else await assertConvo(sql, context.userId, data.id);
    const allowed = allowFile(data.contentType, data.size, true);
    if (!allowed.ok) return { ok: false as const, error: allowed.error };
    const recent = await sql<{ n: number }>`
      select count(*)::int as n from stored_files
      where created_by = ${context.userId} and created_at > now() - interval '1 minute'
    `;
    if ((recent[0]?.n ?? 0) > 20) return { ok: false as const, error: "Too many uploads in the last minute. Wait and try again." };
    const fileId = nid("file");
    const key = objectKeyFor(fileId);
    const name = clean(data.name, 120) || "file";
    let uploadUrl = "";
    try {
      uploadUrl = await signedPutUrl(key, allowed.type, 300);
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : "Could not prepare the upload." };
    }
    await sql`
      insert into stored_files (id, message_id, name, content_type, size_bytes, storage, object_key, created_by, status)
      values (${fileId}, ${"pending"}, ${name}, ${allowed.type}, ${data.size}, ${"r2"}, ${key}, ${context.userId}, ${"pending"})
    `;
    return {
      ok: true as const,
      fileId,
      uploadUrl,
      headers: { "content-type": allowed.type },
      expiresIn: 300,
    };
  });

export const changeMessage = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({
    id: z.string().min(1).max(80),
    action: z.enum(["edit", "delete", "pin", "react"]),
    body: z.string().max(4000).optional(),
    emoji: z.string().max(24).optional(),
  }).parse(input))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await ensure(sql, context.userId);
    const rows = await sql<{ author_id: string; channel_id: string | null; conversation_id: string | null }>`
      select author_id, channel_id, conversation_id from messages where id = ${data.id} and workspace_id = ${WS}
    `;
    const msg = rows[0];
    if (!msg) return { ok: false as const, error: "Message not found." };
    if (msg.channel_id) await assertChannel(sql, context.userId, msg.channel_id);
    if (msg.conversation_id) await assertConvo(sql, context.userId, msg.conversation_id);
    if (data.action === "react") {
      const emoji = clean(data.emoji ?? "", 24);
      if (!["Noted", "Yes", "Question", "Urgent", "👍", "✅", "❓", "👀"].includes(emoji)) return { ok: false as const, error: "Unknown reaction." };
      const existing = await sql<{ ok: number }>`
        select 1 as ok from reactions where message_id = ${data.id} and user_id = ${context.userId} and emoji = ${emoji}
      `;
      if (existing[0]) await sql`delete from reactions where message_id = ${data.id} and user_id = ${context.userId} and emoji = ${emoji}`;
      else await sql`insert into reactions (message_id, user_id, emoji) values (${data.id}, ${context.userId}, ${emoji})`;
      return { ok: true as const };
    }
    if (msg.author_id !== context.userId && data.action !== "pin") return { ok: false as const, error: "You can only change your own messages." };
    if (data.action === "edit") {
      const body = clean(data.body ?? "", 4000);
      if (!body) return { ok: false as const, error: "Message cannot be empty." };
      await sql`update messages set body = ${body}, edited_at = now() where id = ${data.id} and author_id = ${context.userId}`;
    } else if (data.action === "delete") {
      const attached = await sql<{ attachment_data: string | null }>`
        select attachment_data from messages where id = ${data.id} and author_id = ${context.userId}
      `;
      const pointer = remoteFileId(attached[0]?.attachment_data);
      await sql`update messages set deleted = true, body = '', attachment_data = null, attachment_name = null where id = ${data.id} and author_id = ${context.userId}`;
      if (pointer) {
        const live = await sql<{ n: number }>`
          select count(*)::int as n from messages
          where workspace_id = ${WS} and deleted = false
            and (attachment_data = ${`r2:${pointer}`} or attachment_data = ${`s3:${pointer}`})
        `;
        const files = await sql<{ object_key: string | null }>`select object_key from stored_files where id = ${pointer}`;
        if (!shouldRemoveStoredObject(live[0]?.n ?? 0)) {
          /* another live message still uses this object */
        } else if (files[0]?.object_key && storageConfigured()) {
          try {
            await removeObject(files[0].object_key);
            await sql`delete from stored_files where id = ${pointer}`;
          } catch {
            await sql`update stored_files set status = 'delete_pending' where id = ${pointer}`;
          }
        } else {
          await sql`delete from stored_files where id = ${pointer}`;
        }
      }
      await sql`delete from stored_files where message_id = ${data.id} and status <> 'delete_pending'`;
    } else if (data.action === "pin") {
      await sql`update messages set pinned = not pinned where id = ${data.id}`;
    }
    return { ok: true as const };
  });

export const markRead = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ kind: z.enum(["channel", "conversation"]), id: z.string().min(1).max(80) }).parse(input))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await ensure(sql, context.userId);
    if (data.kind === "channel") {
      await assertChannel(sql, context.userId, data.id);
      await sql`
        insert into channel_reads (channel_id, user_id, last_read_at)
        values (${data.id}, ${context.userId}, now())
        on conflict (channel_id, user_id) do update set last_read_at = now()
      `;
    } else {
      await assertConvo(sql, context.userId, data.id);
      await sql`update conversation_members set last_read_at = now() where conversation_id = ${data.id} and user_id = ${context.userId}`;
    }
    return { ok: true as const };
  });

export const setTyping = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ kind: z.enum(["channel", "conversation"]), id: z.string().min(1).max(80) }).parse(input))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await ensure(sql, context.userId);
    if (data.kind === "channel") await assertChannel(sql, context.userId, data.id);
    else await assertConvo(sql, context.userId, data.id);
    const key = `${data.kind}:${data.id}`;
    await sql`
      insert into typing (user_id, target_key, updated_at) values (${context.userId}, ${key}, now())
      on conflict (user_id) do update set target_key = excluded.target_key, updated_at = now()
    `;
    return { ok: true as const };
  });

export const createChannel = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({
    name: z.string().min(2).max(40),
    topic: z.string().max(140).optional(),
    visibility: z.enum(["public", "private"]),
  }).parse(input))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const me = await ensure(sql, context.userId);
    if (!isStaff(me.role)) return { ok: false as const, error: "Only managers can create channels." };
    const name = clean(data.name, 40).toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");
    if (name.length < 2) return { ok: false as const, error: "Use letters, numbers, or hyphens." };
    const id = nid("ch");
    await sql`
      insert into channels (id, workspace_id, name, topic, visibility, created_by)
      values (${id}, ${WS}, ${name}, ${clean(data.topic ?? "", 140)}, ${data.visibility}, ${context.userId})
    `;
    await sql`insert into channel_members (channel_id, user_id) values (${id}, ${context.userId})`;
    if (data.visibility === "public") {
      await sql`
        insert into channel_members (channel_id, user_id)
        select ${id}, user_id from memberships
        where workspace_id = ${WS} and role in ('owner', 'administrator', 'manager', 'member')
        on conflict (channel_id, user_id) do nothing
      `;
    }
    await audit(sql, context.userId, "create_channel", name);
    return { ok: true as const, id };
  });

export const openDm = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ userId: z.string().min(1).max(80) }).parse(input))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await ensure(sql, context.userId);
    if (data.userId === context.userId) return { ok: false as const, error: "Pick someone else." };
    const other = await sql<{ ok: number }>`select 1 as ok from memberships where workspace_id = ${WS} and user_id = ${data.userId}`;
    if (!other[0]) return { ok: false as const, error: "That person is not in the workspace." };
    const existing = await sql<{ id: string }>`
      select c.id from conversations c
      where c.workspace_id = ${WS} and c.kind = 'dm' and c.archived = false
        and exists (select 1 from conversation_members m where m.conversation_id = c.id and m.user_id = ${context.userId})
        and exists (select 1 from conversation_members m where m.conversation_id = c.id and m.user_id = ${data.userId})
        and (select count(*) from conversation_members m where m.conversation_id = c.id) = 2
      limit 1
    `;
    if (existing[0]) return { ok: true as const, id: existing[0].id };
    const id = nid("cv");
    await sql`insert into conversations (id, workspace_id, kind, name, created_by) values (${id}, ${WS}, ${"dm"}, ${""}, ${context.userId})`;
    await sql`
      insert into conversation_members (conversation_id, user_id, member_role) values
      (${id}, ${context.userId}, ${"admin"}), (${id}, ${data.userId}, ${"member"})
    `;
    return { ok: true as const, id };
  });

export const createGroup = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({
    name: z.string().min(2).max(60),
    memberIds: z.array(z.string().max(80)).max(20),
  }).parse(input))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const me = await ensure(sql, context.userId);
    if (me.role === "guest") return { ok: false as const, error: "Guests cannot create groups." };
    const id = nid("cv");
    await sql`
      insert into conversations (id, workspace_id, kind, name, created_by)
      values (${id}, ${WS}, ${"group"}, ${clean(data.name, 60)}, ${context.userId})
    `;
    for (const uid of new Set([context.userId, ...data.memberIds])) {
      const ok = await sql<{ ok: number }>`select 1 as ok from memberships where workspace_id = ${WS} and user_id = ${uid}`;
      if (!ok[0]) continue;
      await sql`
        insert into conversation_members (conversation_id, user_id, member_role)
        values (${id}, ${uid}, ${uid === context.userId ? "admin" : "member"})
        on conflict (conversation_id, user_id) do nothing
      `;
    }
    return { ok: true as const, id };
  });

export const searchAll = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ q: z.string().min(2).max(80) }).parse(input))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const me = await ensure(sql, context.userId);
    const q = `%${clean(data.q, 80).replace(/[%_]/g, "")}%`;
    const messages = await sql.query<{ id: string; body: string; channel_id: string | null; conversation_id: string | null; created_at: unknown }>(
      `select m.id, m.body, m.channel_id, m.conversation_id, m.created_at
       from messages m
       where m.workspace_id = $2 and m.deleted = false and m.body ilike $3
         and ${VISIBLE_MESSAGE_SQL}
       order by m.created_at desc
       limit 25`,
      [context.userId, WS, q],
    );
    const people = me.role === "guest"
      ? await sql<{ user_id: string; display_name: string }>`
          select p.user_id, p.display_name from profiles p
          join memberships m on m.user_id = p.user_id and m.workspace_id = ${WS}
          where p.display_name ilike ${q}
          limit 8
        `
      : await sql<{ user_id: string; display_name: string }>`
          select p.user_id, p.display_name from profiles p
          join memberships m on m.user_id = p.user_id and m.workspace_id = ${WS}
          where p.display_name ilike ${q} or p.email ilike ${q}
          limit 8
        `;
    const files = await sql.query<{ id: string; attachment_name: string; channel_id: string | null; conversation_id: string | null }>(
      `select m.id, m.attachment_name, m.channel_id, m.conversation_id
       from messages m
       where m.workspace_id = $2 and m.deleted = false and m.attachment_name ilike $3
         and ${VISIBLE_MESSAGE_SQL}
       limit 10`,
      [context.userId, WS, q],
    );
    return {
      messages: messages.map((m) => ({
        id: m.id, body: m.body.slice(0, 160), channelId: m.channel_id ?? "", conversationId: m.conversation_id ?? "", createdAt: iso(m.created_at),
      })),
      people,
      files: files.map((f) => ({ id: f.id, name: f.attachment_name, channelId: f.channel_id ?? "", conversationId: f.conversation_id ?? "" })),
    };
  });

const wfBody = z.object({
  id: z.string().max(80).optional(),
  name: z.string().min(2).max(80),
  description: z.string().max(240).optional(),
  enabled: z.boolean(),
  configJson: z.string().max(8000),
});

export const saveWorkflow = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => wfBody.parse(input))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const me = await ensure(sql, context.userId);
    if (!isStaff(me.role)) return { ok: false as const, error: "Only managers can edit workflows." };
    let parsed: WfConfig;
    try { parsed = JSON.parse(data.configJson) as WfConfig; } catch { return { ok: false as const, error: "Workflow config is not valid JSON." }; }
    if (!parsed.trigger?.type || !Array.isArray(parsed.actions) || parsed.actions.length === 0) {
      return { ok: false as const, error: "Add a trigger and at least one action." };
    }
    const triggers = ["keyword", "mention", "channel_message", "schedule", "unanswered"];
    if (!triggers.includes(parsed.trigger.type)) return { ok: false as const, error: "That trigger is not supported." };
    if (parsed.trigger.type === "schedule" || parsed.trigger.type === "unanswered") {
      const minutes = Number(parsed.trigger.value);
      if (!Number.isFinite(minutes) || minutes < 5) return { ok: false as const, error: "Use an interval of at least 5 minutes." };
    }
    const configJson = JSON.stringify(parsed);
    if (data.id) {
      const own = await sql<{ id: string }>`select id from workflows where id = ${data.id} and workspace_id = ${WS}`;
      if (!own[0]) return { ok: false as const, error: "Workflow not found." };
      await sql`
        update workflows set name = ${clean(data.name, 80)}, description = ${clean(data.description ?? "", 240)},
          enabled = ${data.enabled}, config_json = ${configJson}
        where id = ${data.id}
      `;
      return { ok: true as const, id: data.id };
    }
    const id = nid("wf");
    await sql`
      insert into workflows (id, workspace_id, name, description, enabled, config_json, created_by)
      values (${id}, ${WS}, ${clean(data.name, 80)}, ${clean(data.description ?? "", 240)}, ${data.enabled}, ${configJson}, ${context.userId})
    `;
    await audit(sql, context.userId, "save_workflow", data.name);
    return { ok: true as const, id };
  });

export const setWorkflowEnabled = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ id: z.string(), enabled: z.boolean() }).parse(input))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const me = await ensure(sql, context.userId);
    if (!isStaff(me.role)) return { ok: false as const, error: "Only managers can change workflows." };
    await sql`update workflows set enabled = ${data.enabled} where id = ${data.id} and workspace_id = ${WS}`;
    return { ok: true as const };
  });

export const testWorkflow = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ id: z.string().min(1).max(80) }).parse(input))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const me = await ensure(sql, context.userId);
    if (!isStaff(me.role)) return { ok: false as const, error: "Only managers can test workflows." };
    const rows = await sql<{ name: string; config_json: string }>`select name, config_json from workflows where id = ${data.id} and workspace_id = ${WS}`;
    if (!rows[0]) return { ok: false as const, error: "Workflow not found." };
    try {
      const cfg = JSON.parse(rows[0].config_json) as WfConfig;
      const plan = (cfg.actions ?? []).map((a) => `${a.type}: ${a.value || "(empty)"}`).join("; ");
      const detail = `Test of "${rows[0].name}". Would run: ${plan || "nothing"}. No messages were posted and no external provider was called.`;
      await sql`insert into workflow_runs (id, workflow_id, workspace_id, status, detail) values (${nid("run")}, ${data.id}, ${WS}, ${"test"}, ${detail})`;
      return { ok: true as const, detail };
    } catch {
      return { ok: false as const, error: "Could not read this workflow." };
    }
  });

export const duplicateWorkflow = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ id: z.string().min(1).max(80) }).parse(input))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const me = await ensure(sql, context.userId);
    if (!isStaff(me.role)) return { ok: false as const, error: "Only managers can change workflows." };
    const rows = await sql<{ name: string; description: string; config_json: string }>`
      select name, description, config_json from workflows where id = ${data.id} and workspace_id = ${WS}
    `;
    if (!rows[0]) return { ok: false as const, error: "Workflow not found." };
    const id = nid("wf");
    await sql`
      insert into workflows (id, workspace_id, name, description, enabled, config_json, created_by)
      values (${id}, ${WS}, ${`${rows[0].name} copy`.slice(0, 80)}, ${rows[0].description}, false, ${rows[0].config_json}, ${context.userId})
    `;
    return { ok: true as const, id };
  });

export const deleteWorkflow = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ id: z.string().min(1).max(80) }).parse(input))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const me = await ensure(sql, context.userId);
    if (!isStaff(me.role)) return { ok: false as const, error: "Only managers can delete workflows." };
    if (data.id === "wf_urgent") return { ok: false as const, error: "The starter workflow can be disabled, not deleted." };
    await sql`delete from workflow_runs where workflow_id = ${data.id}`;
    await sql`delete from workflows where id = ${data.id} and workspace_id = ${WS}`;
    return { ok: true as const };
  });

export const saveBot = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({
    id: z.string().max(80).optional(),
    name: z.string().min(2).max(60),
    description: z.string().max(240).optional(),
    enabled: z.boolean(),
  }).parse(input))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const me = await ensure(sql, context.userId);
    if (!isStaff(me.role)) return { ok: false as const, error: "Only managers can edit bots." };
    if (data.id) {
      await sql`
        update bots set name = ${clean(data.name, 60)}, description = ${clean(data.description ?? "", 240)}, enabled = ${data.enabled}
        where id = ${data.id} and workspace_id = ${WS}
      `;
      return { ok: true as const, id: data.id };
    }
    const id = nid("bot");
    await sql`
      insert into bots (id, workspace_id, name, description, enabled, system, created_by)
      values (${id}, ${WS}, ${clean(data.name, 60)}, ${clean(data.description ?? "", 240)}, ${data.enabled}, false, ${context.userId})
    `;
    return { ok: true as const, id };
  });

export const updateThread = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({
    kind: z.enum(["channel", "conversation"]),
    id: z.string().min(1).max(80),
    label: z.string().max(40).optional(),
    note: z.string().max(1000).optional(),
    assigneeId: z.string().max(80).optional(),
    followUpOn: z.string().max(20).optional(),
    candidateRef: z.string().max(80).optional(),
    status: z.string().max(40).optional(),
    removeLabel: z.string().max(40).optional(),
  }).parse(input))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const me = await ensure(sql, context.userId);
    if (me.role === "guest") return { ok: false as const, error: "Guests cannot update thread records." };
    if (data.kind === "channel") await assertChannel(sql, context.userId, data.id);
    else await assertConvo(sql, context.userId, data.id);
    if (data.label && (LABELS as readonly string[]).includes(data.label)) {
      await sql`
        insert into labels (id, workspace_id, target_kind, target_id, label, created_by)
        values (${nid("lbl")}, ${WS}, ${data.kind}, ${data.id}, ${data.label}, ${context.userId})
        on conflict (target_kind, target_id, label) do nothing
      `;
    }
    if (data.removeLabel) {
      await sql`delete from labels where target_kind = ${data.kind} and target_id = ${data.id} and label = ${data.removeLabel}`;
    }
    if (data.note && clean(data.note, 1000)) {
      await sql`
        insert into notes (id, workspace_id, target_kind, target_id, body, author_id)
        values (${nid("nte")}, ${WS}, ${data.kind}, ${data.id}, ${clean(data.note, 1000)}, ${context.userId})
      `;
    }
    if (data.assigneeId) {
      const ok = await sql<{ ok: number }>`select 1 as ok from memberships where workspace_id = ${WS} and user_id = ${data.assigneeId}`;
      if (!ok[0]) return { ok: false as const, error: "Assignee is not in the workspace." };
      await sql`
        insert into assignments (id, workspace_id, target_kind, target_id, assignee_id, assigned_by)
        values (${nid("asg")}, ${WS}, ${data.kind}, ${data.id}, ${data.assigneeId}, ${context.userId})
      `;
      await sql`
        insert into notifications (id, workspace_id, user_id, body)
        values (${nid("ntf")}, ${WS}, ${data.assigneeId}, ${"A conversation was assigned to you."})
      `;
    }
    if (data.followUpOn !== undefined || data.candidateRef !== undefined || data.status !== undefined) {
      await sql`
        insert into thread_meta (target_kind, target_id, follow_up_on, candidate_ref, status)
        values (${data.kind}, ${data.id}, ${clean(data.followUpOn || "", 20) || null}, ${clean(data.candidateRef || "", 80) || null}, ${clean(data.status || "open", 40) || "open"})
        on conflict (target_kind, target_id) do update set
          follow_up_on = excluded.follow_up_on,
          candidate_ref = excluded.candidate_ref,
          status = excluded.status
      `;
    }
    return { ok: true as const };
  });

export const saveTask = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({
    id: z.string().max(80).optional(),
    title: z.string().max(200).optional(),
    done: z.boolean().optional(),
  }).parse(input))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const me = await ensure(sql, context.userId);
    if (me.role === "guest") return { ok: false as const, error: "Guests cannot change tasks." };
    if (data.id && data.done !== undefined) {
      await sql`update tasks set status = ${data.done ? "done" : "open"} where id = ${data.id} and workspace_id = ${WS}`;
      return { ok: true as const };
    }
    const title = clean(data.title ?? "", 200);
    if (!title) return { ok: false as const, error: "Task title is required." };
    await sql`
      insert into tasks (id, workspace_id, title, assignee_id, created_by, source)
      values (${nid("tsk")}, ${WS}, ${title}, ${context.userId}, ${context.userId}, ${"manual"})
    `;
    return { ok: true as const };
  });

export const markNotificationsRead = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    await ensure(sql, context.userId);
    await sql`update notifications set read = true where user_id = ${context.userId} and read = false`;
    return { ok: true as const };
  });

export const updateProfile = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({
    displayName: z.string().min(1).max(60).optional(),
    presence: z.enum(["active", "away", "offline"]).optional(),
    notifyPref: z.enum(["all", "mentions", "off"]).optional(),
  }).parse(input))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await ensure(sql, context.userId);
    if (data.displayName) await sql`update profiles set display_name = ${clean(data.displayName, 60)} where user_id = ${context.userId}`;
    if (data.presence) await sql`update profiles set presence = ${data.presence} where user_id = ${context.userId}`;
    if (data.notifyPref) await sql`update profiles set notify_pref = ${data.notifyPref} where user_id = ${context.userId}`;
    return { ok: true as const };
  });

export const setRole = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({
    userId: z.string().min(1).max(80),
    role: z.enum(["owner", "administrator", "manager", "member", "guest"]),
  }).parse(input))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const me = await ensure(sql, context.userId);
    const target = await sql<{ role: string }>`
      select role from memberships where workspace_id = ${WS} and user_id = ${data.userId}
    `;
    if (!target[0]) return { ok: false as const, error: "Member not found." };
    const owners = await sql<{ n: number }>`select count(*)::int as n from memberships where workspace_id = ${WS} and role = 'owner'`;
    const decision = canChangeRole({
      actorRole: me.role,
      targetRole: target[0].role,
      self: data.userId === context.userId,
      nextRole: data.role,
      ownerCount: owners[0]?.n,
    });
    if (!decision.ok) return decision;
    const updated = await sql<{ user_id: string }>`
      update memberships set role = ${data.role}
      where workspace_id = ${WS} and user_id = ${data.userId}
      returning user_id
    `;
    if (!updated[0]) return { ok: false as const, error: "Member not found." };
    await audit(sql, context.userId, "set_role", `${data.userId} -> ${data.role}`);
    return { ok: true as const };
  });

export const createInvite = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ role: z.enum(["administrator", "manager", "member", "guest"]) }).parse(input))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const me = await ensure(sql, context.userId);
    const decision = canInvite(me.role, data.role);
    if (!decision.ok) return decision;
    const code = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
    await sql`insert into invites (code, workspace_id, role, created_by) values (${code}, ${WS}, ${data.role}, ${context.userId})`;
    await audit(sql, context.userId, "invite", data.role);
    return { ok: true as const, code };
  });

export const redeemInvite = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ code: z.string().min(4).max(20) }).parse(input))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const me = await ensure(sql, context.userId);
    const rows = await sql<{ role: string }>`select role from invites where code = ${clean(data.code, 20)} and workspace_id = ${WS}`;
    if (!rows[0]) return { ok: false as const, error: "Invite code was not found." };
    const decision = canRedeemInvite(me.role, rows[0].role);
    if (!decision.ok) return decision;
    await sql`
      update memberships set role = ${decision.role}
      where workspace_id = ${WS} and user_id = ${context.userId} and role <> 'owner'
    `;
    await audit(sql, context.userId, "redeem_invite", decision.role);
    return { ok: true as const, role: decision.role };
  });

export const analytics = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    const me = await ensure(sql, context.userId);
    if (me.role === "guest") return { ok: false as const, error: "Guests cannot view analytics." };
    if (!isStaff(me.role)) return { ok: false as const, error: "Only managers can view analytics." };
    const messages = await sql<{ n: number }>`select count(*)::int as n from messages where workspace_id = ${WS} and deleted = false`;
    const users = await sql<{ n: number }>`select count(*)::int as n from memberships where workspace_id = ${WS}`;
    const convos = await sql<{ n: number }>`select count(*)::int as n from conversations where workspace_id = ${WS} and archived = false`;
    const byChannel = await sql<{ name: string; n: number }>`
      select c.name, count(m.id)::int as n
      from channels c left join messages m on m.channel_id = c.id and m.deleted = false
      where c.workspace_id = ${WS} group by c.name order by n desc
    `;
    const wf = await sql<{ status: string; n: number }>`select status, count(*)::int as n from workflow_runs where workspace_id = ${WS} group by status`;
    const trend = await sql<{ day: string; n: number }>`
      select to_char(created_at, 'YYYY-MM-DD') as day, count(*)::int as n
      from messages where workspace_id = ${WS} and created_at > now() - interval '7 days' and deleted = false
      group by 1 order by 1
    `;
    const openTasks = await sql<{ n: number }>`select count(*)::int as n from tasks where workspace_id = ${WS} and status = 'open'`;
    const pendingReminders = await sql<{ n: number }>`select count(*)::int as n from reminders where workspace_id = ${WS} and done = false`;
    const botRuns = await sql<{ n: number }>`select count(*)::int as n from bot_logs where workspace_id = ${WS}`;
    return {
      ok: true as const,
      totalMessages: messages[0]?.n ?? 0,
      activeUsers: users[0]?.n ?? 0,
      conversations: convos[0]?.n ?? 0,
      byChannel,
      workflowRuns: wf,
      trend,
      openTasks: openTasks[0]?.n ?? 0,
      pendingReminders: pendingReminders[0]?.n ?? 0,
      botRuns: botRuns[0]?.n ?? 0,
      note: "Counts are from this workspace database. They are not sample charts.",
    };
  });

export const listFiles = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    await ensure(sql, context.userId);
    const rows = await sql.query<{ id: string; attachment_name: string; created_at: unknown; channel_id: string | null; conversation_id: string | null }>(
      `select m.id, m.attachment_name, m.created_at, m.channel_id, m.conversation_id
       from messages m
       where m.workspace_id = $2 and m.deleted = false and m.attachment_name is not null
         and ${VISIBLE_MESSAGE_SQL}
       order by m.created_at desc
       limit 40`,
      [context.userId, WS],
    );
    return rows.map((r) => ({
      id: r.id, name: r.attachment_name, createdAt: iso(r.created_at), channelId: r.channel_id ?? "", conversationId: r.conversation_id ?? "",
    }));
  });

export const fileData = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ id: z.string().min(1).max(80) }).parse(input))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await ensure(sql, context.userId);
    const rows = await sql<{ attachment_name: string | null; attachment_data: string | null; channel_id: string | null; conversation_id: string | null }>`
      select attachment_name, attachment_data, channel_id, conversation_id from messages
      where id = ${data.id} and workspace_id = ${WS} and deleted = false
    `;
    const row = rows[0];
    if (!row) return { ok: false as const, error: "File not found." };
    if (!row.channel_id && !row.conversation_id) return { ok: false as const, error: "File not found." };
    if (row.channel_id) await assertChannel(sql, context.userId, row.channel_id);
    if (row.conversation_id) await assertConvo(sql, context.userId, row.conversation_id);
    const pointer = remoteFileId(row.attachment_data);
    if (pointer) {
      if (!storageConfigured()) return { ok: false as const, error: storageSetupMessage() };
      const files = await sql<{ object_key: string | null; name: string; content_type: string; inline_data: string | null }>`
        select object_key, name, content_type, inline_data from stored_files
        where id = ${pointer}
      `;
      if (files[0]?.inline_data?.startsWith("data:")) {
        return { ok: true as const, name: files[0].name || row.attachment_name || "file", data: files[0].inline_data };
      }
      if (!files[0]?.object_key) return { ok: false as const, error: "Stored file is missing. Older database copies are unchanged." };
      try {
        const url = await signedGetUrl(files[0].object_key, files[0].name, files[0].content_type || "application/octet-stream", 300);
        return { ok: true as const, name: files[0].name, data: url };
      } catch (err) {
        return { ok: false as const, error: err instanceof Error ? err.message : "Could not open the file." };
      }
    }
    if (!row.attachment_data) return { ok: false as const, error: "File not found." };
    if (row.attachment_data.startsWith("data:")) {
      return { ok: true as const, name: row.attachment_name ?? "file", data: row.attachment_data };
    }
    return { ok: false as const, error: "File not found." };
  });

export const relocateFiles = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({
    dryRun: z.boolean().optional(),
    cleanup: z.boolean().optional(),
  }).parse(input ?? {}))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const me = await ensure(sql, context.userId);
    if (!isStaff(me.role)) return { ok: false as const, error: "Only managers can move files to R2." };
    const waitingRows = await sql<{ n: number }>`
      select count(*)::int as n from stored_files where storage = 'database' and inline_data like 'data:%'
    `;
    const looseRows = await sql<{ n: number }>`
      select count(*)::int as n from messages
      where workspace_id = ${WS} and deleted = false and attachment_data like 'data:%'
    `;
    const keptRows = await sql<{ n: number }>`
      select count(*)::int as n from stored_files
      where storage = 'r2' and inline_data like 'data:%' and object_key is not null
    `;
    const waiting = (waitingRows[0]?.n ?? 0) + (looseRows[0]?.n ?? 0);
    const kept = keptRows[0]?.n ?? 0;
    if (data.dryRun) {
      const note = storageConfigured()
        ? `Dry run. ${waiting} database file${waiting === 1 ? "" : "s"} can be copied to R2. ${kept} copied file${kept === 1 ? "" : "s"} still keep the old database bytes until you approve cleanup. Nothing was uploaded or deleted.`
        : `Dry run. ${waiting} database file${waiting === 1 ? "" : "s"} are waiting, but R2 is not configured, so nothing can be copied yet. Nothing was uploaded or deleted.`;
      return { ok: true as const, moved: 0, failed: 0, waiting, kept, note };
    }
    if (!storageConfigured()) return { ok: false as const, error: storageSetupMessage() };
    if (data.cleanup) {
      const rows = await sql<{ id: string; object_key: string | null }>`
        select id, object_key from stored_files
        where storage = 'r2' and inline_data like 'data:%' and object_key is not null
        order by created_at asc
        limit 20
      `;
      let cleared = 0;
      let failed = 0;
      for (const row of rows) {
        if (!row.object_key) { failed += 1; continue; }
        const present = await storedObjectExists(row.object_key).catch(() => false);
        if (!present) { failed += 1; continue; }
        await sql`
          update stored_files set inline_data = null
          where id = ${row.id} and storage = 'r2' and object_key = ${row.object_key}
        `;
        cleared += 1;
      }
      const note = `Cleanup checked ${rows.length} copied file${rows.length === 1 ? "" : "s"}. Removed the old database bytes for ${cleared}. ${failed} were left in the database because R2 could not be confirmed. Run again if more remain.`;
      await audit(sql, context.userId, "relocate_files_cleanup", note);
      return { ok: true as const, moved: cleared, failed, waiting, kept, note };
    }
    const rows = await sql<{ id: string; message_id: string | null; name: string; content_type: string; inline_data: string | null }>`
      select id, message_id, name, content_type, inline_data from stored_files
      where storage = 'database' and inline_data like 'data:%'
      order by created_at asc
      limit 20
    `;
    let moved = 0;
    let failed = 0;
    for (const row of rows) {
      const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(row.inline_data ?? "");
      if (!match) { failed += 1; continue; }
      const bytes = Buffer.from(match[2] ?? "", "base64");
      const allowed = allowFile(match[1] ?? row.content_type, bytes.length, true);
      if (!allowed.ok || !matchesDeclaredType(allowed.type, bytes.subarray(0, 32))) { failed += 1; continue; }
      let key = "";
      try {
        key = objectKeyFor(row.id);
        await putObject(key, bytes, allowed.type);
        const confirmed = await confirmObject(key, allowed.type, bytes.length);
        if (!confirmed.ok) { failed += 1; continue; }
      } catch {
        failed += 1;
        continue;
      }
      await sql`
        update stored_files
        set storage = 'r2', object_key = ${key}, content_type = ${allowed.type}, size_bytes = ${bytes.length}, status = 'ready'
        where id = ${row.id} and storage = 'database'
      `;
      if (row.message_id && row.message_id !== "pending") {
        await sql`
          update messages set attachment_data = ${remotePointer(row.id)}
          where id = ${row.message_id} and workspace_id = ${WS} and attachment_data like 'data:%'
        `;
      }
      moved += 1;
    }
    const loose = await sql<{ id: string; attachment_name: string | null; attachment_data: string }>`
      select id, attachment_name, attachment_data from messages
      where workspace_id = ${WS} and deleted = false and attachment_data like 'data:%'
      order by created_at asc
      limit 20
    `;
    for (const row of loose) {
      const already = await sql<{ id: string }>`
        select id from stored_files
        where message_id = ${row.id} and storage = 'r2' and object_key is not null and status = 'ready'
        limit 1
      `;
      if (already[0]) {
        await sql`
          update messages set attachment_data = ${remotePointer(already[0].id)}
          where id = ${row.id} and workspace_id = ${WS} and attachment_data like 'data:%'
        `;
        moved += 1;
        continue;
      }
      const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(row.attachment_data);
      if (!match) { failed += 1; continue; }
      const bytes = Buffer.from(match[2] ?? "", "base64");
      const allowed = allowFile(match[1] ?? "", bytes.length, true);
      if (!allowed.ok || !matchesDeclaredType(allowed.type, bytes.subarray(0, 32))) { failed += 1; continue; }
      const fileId = nid("file");
      let key = "";
      try {
        key = objectKeyFor(fileId);
        await putObject(key, bytes, allowed.type);
        const confirmed = await confirmObject(key, allowed.type, bytes.length);
        if (!confirmed.ok) { failed += 1; continue; }
        await sql`
          insert into stored_files (id, message_id, name, content_type, size_bytes, storage, object_key, inline_data, created_by, status)
          values (${fileId}, ${row.id}, ${row.attachment_name || "file"}, ${allowed.type}, ${bytes.length}, ${"r2"}, ${key}, ${row.attachment_data}, ${context.userId}, ${"ready"})
        `;
        await sql`
          update messages set attachment_data = ${remotePointer(fileId)}
          where id = ${row.id} and workspace_id = ${WS} and attachment_data like 'data:%'
        `;
        moved += 1;
      } catch {
        if (key) {
          try { await removeObject(key); } catch { /* retry can upload the same message again */ }
        }
        failed += 1;
      }
    }
    const note = moved || failed
      ? `Copied ${moved} database file${moved === 1 ? "" : "s"} to R2 and left the old bytes in the database. ${failed} could not be copied. Run this again if more remain. Approve cleanup only after downloads work.`
      : "No database files are waiting to copy. Existing messages still open the way they were saved.";
    await audit(sql, context.userId, "relocate_files", note);
    return { ok: true as const, moved, failed, waiting, kept, note };
  });

export const testIntegration = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ provider: z.string().max(40) }).parse(input))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const me = await ensure(sql, context.userId);
    if (!isStaff(me.role)) return { ok: false as const, error: "Only managers can test integrations." };
    if (!PROVIDERS.some(([id]) => id === data.provider)) return { ok: false as const, error: "Unknown provider." };
    const probe = await probeProvider(data.provider);
    await sql`
      update integrations set status = ${probe.status}, note = ${probe.note}
      where workspace_id = ${WS} and provider = ${data.provider}
    `;
    await audit(sql, context.userId, "test_integration", `${data.provider}: ${probe.status}`);
    return { ok: true as const, configured: probe.status !== "not_configured", note: probe.note };
  });

export const listAudit = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    const me = await ensure(sql, context.userId);
    if (!isAdmin(me.role)) return { ok: false as const, error: "Administrators only." };
    const rows = await sql<{ action: string; detail: string; actor_id: string; created_at: unknown }>`
      select action, detail, actor_id, created_at from audit_logs where workspace_id = ${WS} order by created_at desc limit 40
    `;
    const names = await namesFor(sql, rows.map((r) => r.actor_id));
    return {
      ok: true as const,
      rows: rows.map((r) => ({ action: r.action, detail: r.detail, actor: names.get(r.actor_id) ?? "Member", createdAt: iso(r.created_at) })),
    };
  });

export const setConversationFlags = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({
    id: z.string().min(1).max(80),
    archived: z.boolean().optional(),
    muted: z.boolean().optional(),
  }).parse(input))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const me = await ensure(sql, context.userId);
    await assertConvo(sql, context.userId, data.id);
    if (data.archived !== undefined && !isStaff(me.role)) {
      return { ok: false as const, error: "Only managers can archive a conversation for everyone." };
    }
    if (data.muted !== undefined) {
      await sql`update conversation_members set muted = ${data.muted} where conversation_id = ${data.id} and user_id = ${context.userId}`;
    }
    if (data.archived !== undefined) await sql`update conversations set archived = ${data.archived} where id = ${data.id}`;
    return { ok: true as const };
  });

export const setAiSettings = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ enabled: z.boolean(), requireApproval: z.boolean() }).parse(input))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const me = await ensure(sql, context.userId);
    if (!isStaff(me.role)) return { ok: false as const, error: "Only managers can change AI settings." };
    await writeAiSettings(sql, data.enabled, data.requireApproval);
    await audit(sql, context.userId, "ai_settings", `enabled=${data.enabled} approval=${data.requireApproval}`);
    return { ok: true as const };
  });

export const approveDraft = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ id: z.string().min(1).max(80) }).parse(input))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const me = await ensure(sql, context.userId);
    if (!isStaff(me.role)) return { ok: false as const, error: "Only managers can approve drafts." };
    const rows = await sql<{ target_kind: string; target_id: string; body: string; status: string }>`
      select target_kind, target_id, body, status from ai_drafts where id = ${data.id} and workspace_id = ${WS}
    `;
    const draft = rows[0];
    if (!draft || draft.status !== "pending") return { ok: false as const, error: "That draft is no longer pending." };
    if (draft.target_kind === "channel") await assertChannel(sql, context.userId, draft.target_id);
    else await assertConvo(sql, context.userId, draft.target_id);
    const loc = draft.target_kind === "channel" ? { channelId: draft.target_id } : { conversationId: draft.target_id };
    await postBot(sql, loc, draft.body, "bot_support");
    await sql`update ai_drafts set status = 'approved' where id = ${data.id} and status = 'pending'`;
    await audit(sql, context.userId, "approve_draft", data.id);
    return { ok: true as const };
  });

export const rejectDraft = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ id: z.string().min(1).max(80) }).parse(input))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const me = await ensure(sql, context.userId);
    if (!isStaff(me.role)) return { ok: false as const, error: "Only managers can reject drafts." };
    const updated = await sql<{ id: string }>`
      update ai_drafts set status = 'rejected' where id = ${data.id} and workspace_id = ${WS} and status = 'pending'
      returning id
    `;
    if (!updated[0]) return { ok: false as const, error: "That draft is no longer pending." };
    await audit(sql, context.userId, "reject_draft", data.id);
    return { ok: true as const };
  });

export const registerTelegramHook = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    const me = await ensure(sql, context.userId);
    if (!isStaff(me.role)) return { ok: false as const, error: "Only managers can register the Telegram webhook." };
    const result = await registerTelegramWebhook();
    const note = result.ok ? result.note : result.error;
    const status = result.ok ? "operational" : note.startsWith("Set TELEGRAM") ? "not_configured" : "error";
    await sql`
      update integrations set status = ${status}, note = ${note}
      where workspace_id = ${WS} and provider = 'telegram'
    `;
    await audit(sql, context.userId, "telegram_webhook", result.ok ? "accepted" : "rejected");
    return result.ok ? { ok: true as const, note } : { ok: false as const, error: note };
  });

