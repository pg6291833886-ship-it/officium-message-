-- Role lookups used on every request. Does not change existing rows.
create index if not exists memberships_role_idx on memberships (workspace_id, role);

-- Sidebar and analytics read recent messages by workspace. Does not change rows.
create index if not exists messages_ws_created_idx on messages (workspace_id, created_at desc);

-- Unread badge. Partial so read notifications stay out of the index.
create index if not exists notifications_unread_idx on notifications (user_id) where read = false;
