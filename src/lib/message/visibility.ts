/**
 * Messages the signed-in user may read.
 * $1 is the user id. $2 is the workspace id. The messages alias must be `m`.
 * Guests do not inherit public channels. Private channels and every conversation
 * require an explicit membership row.
 */
export const VISIBLE_MESSAGE_SQL = `
(
  (m.channel_id is not null and (
    exists (select 1 from channel_members cm where cm.channel_id = m.channel_id and cm.user_id = $1)
    or (
      exists (
        select 1 from channels c
        where c.id = m.channel_id and c.visibility = 'public' and c.workspace_id = $2 and c.archived = false
      )
      and exists (
        select 1 from memberships mb
        where mb.workspace_id = $2 and mb.user_id = $1
          and mb.role in ('owner', 'administrator', 'manager', 'member')
      )
    )
  ))
  or (
    m.conversation_id is not null and exists (
      select 1 from conversation_members mem
      where mem.conversation_id = m.conversation_id and mem.user_id = $1
    )
  )
)
`;
