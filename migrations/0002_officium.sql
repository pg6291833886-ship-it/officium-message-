-- Officium Message schema. Idempotent. App tables only.

create table if not exists profiles (
  user_id text primary key,
  display_name text not null,
  email text not null default '',
  presence text not null default 'active',
  notify_pref text not null default 'all',
  created_at timestamptz not null default now()
);

create table if not exists workspaces (
  id text primary key,
  name text not null,
  slug text not null unique,
  created_by text not null,
  created_at timestamptz not null default now()
);

create table if not exists memberships (
  workspace_id text not null references workspaces(id) on delete cascade,
  user_id text not null,
  role text not null default 'member',
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table if not exists channels (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  name text not null,
  topic text not null default '',
  description text not null default '',
  visibility text not null default 'public',
  archived boolean not null default false,
  created_by text not null,
  created_at timestamptz not null default now()
);
create index if not exists channels_ws_idx on channels (workspace_id);

create table if not exists channel_members (
  channel_id text not null references channels(id) on delete cascade,
  user_id text not null,
  primary key (channel_id, user_id)
);

create table if not exists channel_reads (
  channel_id text not null references channels(id) on delete cascade,
  user_id text not null,
  last_read_at timestamptz not null default now(),
  primary key (channel_id, user_id)
);

create table if not exists conversations (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  kind text not null,
  name text not null default '',
  archived boolean not null default false,
  created_by text not null,
  created_at timestamptz not null default now()
);

create table if not exists conversation_members (
  conversation_id text not null references conversations(id) on delete cascade,
  user_id text not null,
  member_role text not null default 'member',
  muted boolean not null default false,
  last_read_at timestamptz,
  primary key (conversation_id, user_id)
);

create table if not exists messages (
  id text primary key,
  workspace_id text not null,
  channel_id text,
  conversation_id text,
  author_id text not null,
  body text not null,
  reply_to_id text,
  edited_at timestamptz,
  deleted boolean not null default false,
  pinned boolean not null default false,
  attachment_name text,
  attachment_data text,
  created_at timestamptz not null default now()
);
create index if not exists messages_channel_idx on messages (channel_id, created_at);
create index if not exists messages_convo_idx on messages (conversation_id, created_at);

create table if not exists reactions (
  message_id text not null references messages(id) on delete cascade,
  user_id text not null,
  emoji text not null,
  primary key (message_id, user_id, emoji)
);

create table if not exists thread_meta (
  target_kind text not null,
  target_id text not null,
  follow_up_on text,
  candidate_ref text,
  status text not null default 'open',
  primary key (target_kind, target_id)
);

create table if not exists labels (
  id text primary key,
  workspace_id text not null,
  target_kind text not null,
  target_id text not null,
  label text not null,
  created_by text not null,
  unique (target_kind, target_id, label)
);

create table if not exists notes (
  id text primary key,
  workspace_id text not null,
  target_kind text not null,
  target_id text not null,
  body text not null,
  author_id text not null,
  created_at timestamptz not null default now()
);

create table if not exists assignments (
  id text primary key,
  workspace_id text not null,
  target_kind text not null,
  target_id text not null,
  assignee_id text not null,
  assigned_by text not null,
  created_at timestamptz not null default now()
);

create table if not exists tasks (
  id text primary key,
  workspace_id text not null,
  title text not null,
  status text not null default 'open',
  assignee_id text,
  created_by text not null,
  source text not null default 'manual',
  created_at timestamptz not null default now()
);

create table if not exists reminders (
  id text primary key,
  workspace_id text not null,
  user_id text not null,
  body text not null,
  due_at timestamptz not null,
  done boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists workflows (
  id text primary key,
  workspace_id text not null,
  name text not null,
  description text not null default '',
  enabled boolean not null default true,
  config_json text not null,
  created_by text not null,
  last_run_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists workflow_runs (
  id text primary key,
  workflow_id text not null,
  workspace_id text not null,
  message_id text,
  status text not null,
  detail text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists workflow_runs_wf_idx on workflow_runs (workflow_id, created_at desc);

create table if not exists bots (
  id text primary key,
  workspace_id text not null,
  name text not null,
  description text not null default '',
  enabled boolean not null default true,
  system boolean not null default false,
  created_by text not null,
  created_at timestamptz not null default now()
);

create table if not exists bot_logs (
  id text primary key,
  bot_id text,
  workspace_id text not null,
  command text not null,
  result text not null,
  actor_id text not null,
  created_at timestamptz not null default now()
);

create table if not exists integrations (
  workspace_id text not null,
  provider text not null,
  status text not null default 'disconnected',
  note text not null default '',
  primary key (workspace_id, provider)
);

create table if not exists invites (
  code text primary key,
  workspace_id text not null,
  role text not null default 'member',
  created_by text not null,
  created_at timestamptz not null default now()
);

create table if not exists notifications (
  id text primary key,
  workspace_id text not null,
  user_id text not null,
  body text not null,
  read boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists notifications_user_idx on notifications (user_id, created_at desc);

create table if not exists audit_logs (
  id text primary key,
  workspace_id text not null,
  actor_id text not null,
  action text not null,
  detail text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists typing (
  user_id text primary key,
  target_key text not null,
  updated_at timestamptz not null default now()
);
