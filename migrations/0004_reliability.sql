create unique index if not exists workflow_runs_once_idx
  on workflow_runs (workflow_id, message_id)
  where message_id is not null and message_id <> '';

create unique index if not exists provider_events_once_idx
  on provider_events (provider, direction, external_id)
  where external_id is not null and external_id <> '';
