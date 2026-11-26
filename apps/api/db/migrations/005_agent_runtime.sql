-- Phase 4: agent execution and conversation persistence.
-- LangGraph's own checkpoint tables (checkpoints, checkpoint_blobs, checkpoint_writes) are created by the
-- adapter's setup() at startup. The Phase 1 placeholder agent_checkpoints table is superseded by them.
drop table if exists agent_checkpoints;

alter table sessions
  add column token_hash text,                              -- sha256 of the bearer token handed out at creation
  add column conversation_summary text,
  add column summarized_through bigint not null default 0; -- messages.id covered by the summary

alter table messages
  add column client_message_id text,
  add column run_id text references agent_runs(id);
create unique index messages_client_id_key on messages (session_id, client_message_id) where client_message_id is not null;
create index messages_session_idx on messages (session_id, id);

alter table agent_runs alter column status set default 'running';
alter table agent_runs add constraint agent_runs_status_check check (
  status in ('running','executing_tool','awaiting_input','awaiting_confirmation','completed','escalated','cancelled','failed')
);
alter table agent_runs
  add column turn_id text,
  add column client_message_id text,
  add column error_code text,
  add column response text,
  add column metrics jsonb,
  add column cancel_requested boolean not null default false;
-- At most one actively executing run per session. Paused runs (awaiting input/confirmation) do not count.
create unique index agent_runs_one_active_per_session on agent_runs (session_id) where status in ('running','executing_tool');
create index agent_runs_session_idx on agent_runs (session_id, started_at desc);

alter table trace_events add column session_id text;
create unique index trace_events_run_seq_key on trace_events (run_id, seq);

alter table usage_metrics
  add column model text,
  add column llm_calls int default 0,
  add column tool_calls int default 0,
  add column iterations int default 0,
  add column llm_latency_ms int default 0;

create table pending_actions (
  id text primary key,
  session_id text not null references sessions(id),
  run_id text not null references agent_runs(id),
  customer_id text not null references customers(id),
  type text not null check (type in ('refund','account_update')),
  tool text not null,
  arguments jsonb not null,
  arguments_hash text not null,
  amount_cents int,
  currency text,
  summary text not null,
  status text not null default 'pending'
    check (status in ('pending','confirmed','declined','expired','superseded','executed','failed')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index pending_actions_session_idx on pending_actions (session_id, status);

create table retrieval_results (
  id bigserial primary key,
  run_id text not null references agent_runs(id),
  session_id text not null,
  tool_call_id text,
  query text not null,
  chunk_id text not null,
  document text not null,
  heading text not null,
  similarity real not null,
  evidence_verified boolean not null,
  created_at timestamptz not null default now()
);
create index retrieval_results_run_idx on retrieval_results (run_id);
