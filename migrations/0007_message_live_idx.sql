create index if not exists messages_channel_live_idx on messages (channel_id, created_at desc) where deleted = false;
create index if not exists messages_convo_live_idx on messages (conversation_id, created_at desc) where deleted = false;
