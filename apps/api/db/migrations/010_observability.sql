-- Phase 7: observability. Reuses trace_events (lifecycle events), tool_executions, retrieval_results, llm_calls and the
-- Phase 6 voice tables; these are the new pieces. Diagnostic data only: nothing here is read by business logic, and rows
-- older than TELEMETRY_RETENTION_DAYS are purged. Prompt/argument content is sanitized BEFORE it is inserted.
create table trace_spans (
  span_id text primary key,
  trace_id text not null,
  parent_span_id text,
  run_id text,
  session_id text,
  voice_session_id text,
  name text not null,
  category text not null,                    -- agent | llm | tool | rag | guardrail | voice | db
  started_at timestamptz not null,
  duration_ms numeric not null,
  status text not null,                      -- ok | error
  error_code text,
  attributes jsonb not null default '{}'::jsonb,
  detail jsonb,                              -- sanitized inputs/outputs for the span inspector
  created_at timestamptz not null default now()
);
create index trace_spans_trace_idx on trace_spans (trace_id, started_at);
create index trace_spans_run_idx on trace_spans (run_id, started_at);
create index trace_spans_session_idx on trace_spans (session_id, started_at desc);
create index trace_spans_voice_idx on trace_spans (voice_session_id, started_at);

create table model_invocations (
  id text primary key,                       -- also the de-duplication key for usage
  run_id text,
  session_id text,
  trace_id text,
  span_id text,
  purpose text not null,                     -- decision | evidence_check | summary
  provider text not null,
  model text not null,
  prompt_version text,
  started_at timestamptz not null,
  duration_ms numeric not null,
  finish_reason text,
  status text not null,                      -- ok | error
  error_code text,
  usage jsonb not null,                      -- normalized usage (see usage-normalizer.ts)
  usage_source text not null,                -- provider_reported | estimated | unavailable
  estimated_cost_usd numeric,                -- NULL means unavailable, never 0
  cost_status text not null,                 -- ok | unavailable
  cost_note text,
  pricing_version text,
  pricing_snapshot jsonb,                    -- the exact rates used, so the estimate stays reproducible
  system_prompt text,
  messages jsonb,
  tools jsonb,
  output jsonb,
  created_at timestamptz not null default now()
);
create index model_invocations_run_idx on model_invocations (run_id, started_at);
create index model_invocations_session_idx on model_invocations (session_id, started_at);

create table model_pricing (
  model text not null,
  effective_from date not null,
  effective_until date,
  currency text not null default 'USD',
  rates jsonb not null,
  source_url text not null,
  verified_on date,
  primary key (model, effective_from)
);

create table error_events (
  id bigserial primary key,
  trace_id text,
  span_id text,
  run_id text,
  session_id text,
  category text not null,                    -- provider | rate_limit | timeout | validation | authorization | retrieval | voice | guardrail | budget | business_rule | internal
  kind text not null,                        -- infrastructure | business_rule | guardrail
  code text,
  message text,
  occurred_at timestamptz not null default now()
);
create index error_events_run_idx on error_events (run_id, occurred_at);

-- Unknown pricing must read as "unavailable", never as zero.
alter table voice_usage alter column estimated_cost_usd drop not null;
alter table voice_usage alter column estimated_cost_usd drop default;
