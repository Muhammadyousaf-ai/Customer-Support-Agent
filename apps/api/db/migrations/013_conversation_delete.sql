-- A customer can delete a conversation from their list. Soft delete: messages, runs, audit and tickets stay for support and
-- observability; the conversation just disappears for the customer and its tokens stop working.
alter table sessions add column if not exists deleted_at timestamptz;
create index if not exists sessions_user_live_idx on sessions (user_id, created_at desc) where deleted_at is null;
