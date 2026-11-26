-- A paused graph thread that can no longer be resumed (e.g. after a crash) is abandoned by bumping the generation.
alter table sessions add column thread_gen int not null default 0;

-- One row per model call: the prompt trace and usage record. Prompt text is only stored when TRACE_PROMPTS=true.
create table llm_calls (
  id bigserial primary key,
  run_id text not null references agent_runs(id),
  session_id text not null,
  purpose text not null,
  model text not null,
  latency_ms int,
  input_tokens int,
  output_tokens int,
  decision text,
  error_code text,
  prompt text,
  created_at timestamptz not null default now()
);
create index llm_calls_run_idx on llm_calls (run_id, id);
