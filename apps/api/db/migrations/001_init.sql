create extension if not exists vector;

create table if not exists customers (
  id text primary key,
  name text not null,
  email text unique not null,
  verification_pin text not null
);

create table if not exists subscriptions (
  id text primary key,
  customer_id text not null references customers(id),
  tier text not null check (tier in ('free','pro','enterprise')),
  billing_period text not null check (billing_period in ('monthly','annual')),
  status text not null default 'active',
  started_at timestamptz not null
);

create table if not exists contracts (
  id text primary key,
  customer_id text not null references customers(id),
  status text not null check (status in ('active','expired','cancelled')),
  start_date date not null,
  end_date date not null
);

create table if not exists payments (
  id text primary key,
  customer_id text not null references customers(id),
  amount_cents int not null,
  paid_at timestamptz not null,
  refunded boolean not null default false
);

create table if not exists refunds (
  id text primary key,
  payment_id text not null references payments(id),
  amount_cents int not null,
  idempotency_key text unique not null,
  created_at timestamptz not null default now()
);

create table if not exists sessions (
  id text primary key,
  customer_id text references customers(id),
  identity_verified boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists messages (
  id bigserial primary key,
  session_id text not null references sessions(id),
  role text not null,
  mode text not null,
  content text not null,
  created_at timestamptz not null default now()
);

create table if not exists agent_runs (
  id text primary key,
  session_id text not null references sessions(id),
  status text not null,
  mode text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create table if not exists tool_executions (
  id bigserial primary key,
  run_id text not null references agent_runs(id),
  tool text not null,
  args jsonb,
  result jsonb,
  status text not null,
  duration_ms int,
  idempotency_key text,
  created_at timestamptz not null default now()
);

create table if not exists trace_events (
  id bigserial primary key,
  run_id text not null references agent_runs(id),
  seq int not null,
  type text not null,
  data jsonb,
  created_at timestamptz not null default now()
);

create table if not exists usage_metrics (
  run_id text primary key references agent_runs(id),
  input_tokens int default 0,
  output_tokens int default 0,
  embedding_tokens int default 0,
  audio_seconds real default 0,
  est_cost_usd numeric(10,6) default 0,
  total_latency_ms int,
  first_token_ms int
);

create table if not exists escalation_tickets (
  id text primary key,
  session_id text not null references sessions(id),
  reason text not null,
  summary text not null,
  created_at timestamptz not null default now()
);

create table if not exists agent_checkpoints (
  session_id text primary key references sessions(id),
  state jsonb not null,
  updated_at timestamptz not null default now()
);
