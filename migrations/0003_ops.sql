create table if not exists app_settings (
  key text primary key,
  value text not null
);

create table if not exists jobs (
  id text primary key,
  workspace_id text not null,
  kind text not null,
  payload text not null,
  run_at timestamptz not null,
  attempts int not null default 0,
  max_attempts int not null default 3,
  status text not null default 'pending',
  last_error text not null default '',
  idempotency_key text unique,
  created_at timestamptz not null default now()
);
create index if not exists jobs_due_idx on jobs (status, run_at);

create table if not exists ai_drafts (
  id text primary key,
  workspace_id text not null,
  target_kind text not null,
  target_id text not null,
  body text not null,
  status text not null default 'pending',
  created_by text not null,
  created_at timestamptz not null default now()
);

create table if not exists provider_events (
  id text primary key,
  provider text not null,
  direction text not null,
  external_id text,
  status text not null,
  detail text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists stored_files (
  id text primary key,
  message_id text,
  name text not null,
  content_type text not null,
  size_bytes int not null,
  storage text not null,
  object_key text,
  inline_data text,
  created_by text not null,
  created_at timestamptz not null default now()
);
