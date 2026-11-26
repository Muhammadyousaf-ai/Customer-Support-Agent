-- Phase 6: live voice. Voice reuses sessions, messages, agent_runs, trace_events and llm usage; only the
-- voice-specific connection, turn and function-call records are new. Raw audio is never stored.
create table voice_sessions (
  id text primary key,
  session_id text not null references sessions(id),
  model text not null,
  voice text,
  status text not null check (status in ('connecting','connected','reconnecting','ended','failed')),
  ticket_hash text,
  ticket_expires_at timestamptz,
  ticket_used_at timestamptz,
  provider_session_id text,
  resumption_handle text,
  end_reason text,
  started_at timestamptz not null default now(),
  connected_at timestamptz,
  ended_at timestamptz
);
create index voice_sessions_session_idx on voice_sessions (session_id, started_at desc);
-- At most one live voice session per application session (database guarantee, like agent_runs).
create unique index voice_sessions_one_active on voice_sessions (session_id) where status in ('connecting','connected','reconnecting');

create table voice_turns (
  id text primary key,                      -- logical turn id, also the agent clientMessageId
  voice_session_id text not null references voice_sessions(id),
  session_id text not null references sessions(id),
  run_id text references agent_runs(id),
  user_transcript text not null default '',
  assistant_spoken text not null default '',   -- what the provider actually said (transcription)
  assistant_canonical text,                    -- the verified backend answer
  interrupted boolean not null default false,
  grounding_status text not null default 'pending' check (grounding_status in ('pending','verified','corrected','blocked','not_required')),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index voice_turns_session_idx on voice_turns (voice_session_id, created_at);

create table voice_function_calls (
  id bigserial primary key,
  voice_session_id text not null references voice_sessions(id),
  provider_call_id text not null,
  turn_id text references voice_turns(id),
  name text not null,
  status text not null check (status in ('running','completed','failed','cancelled')),
  run_id text references agent_runs(id),
  duplicate_count int not null default 0,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (voice_session_id, provider_call_id)
);

create table voice_events (
  id bigserial primary key,
  voice_session_id text not null references voice_sessions(id),
  type text not null,
  payload jsonb not null default '{}'::jsonb,        -- sanitized: no audio, no codes
  created_at timestamptz not null default now()
);
create index voice_events_session_idx on voice_events (voice_session_id, id);

create table voice_usage (
  voice_session_id text primary key references voice_sessions(id),
  audio_input_seconds numeric not null default 0,
  audio_output_seconds numeric not null default 0,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  audio_input_tokens bigint not null default 0,
  audio_output_tokens bigint not null default 0,
  estimated_cost_usd numeric not null default 0,
  pricing_model text,
  pricing_effective_date text,
  metrics jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table messages add column voice_turn_id text references voice_turns(id);
alter table messages add column interruption jsonb;
alter table agent_runs add column voice_turn_id text references voice_turns(id);
