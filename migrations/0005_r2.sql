alter table stored_files add column if not exists status text not null default 'ready';
create index if not exists stored_files_pending_idx on stored_files (status, created_at);
