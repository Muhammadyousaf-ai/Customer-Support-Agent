-- Phase 5: conversation titles, a session-wide monotonic event sequence (for SSE replay), and structured
-- display fields for confirmation cards.
alter table sessions add column title text;

alter table trace_events add column session_seq bigint;
create unique index trace_events_session_seq_key on trace_events (session_id, session_seq) where session_seq is not null;

alter table pending_actions add column display jsonb not null default '{}'::jsonb;
