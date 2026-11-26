-- Phase 3: transactional business schema. Replaces the Phase 1 placeholder tables (no production data yet).
drop table if exists agent_checkpoints, usage_metrics, trace_events, tool_executions, agent_runs, messages,
  escalation_tickets, refunds, payments, contracts, subscriptions, sessions, customers cascade;

create sequence if not exists refund_seq;
create sequence if not exists ticket_seq;

create table customers (
  id text primary key check (id ~ '^CUST-[0-9]{3,}$'),
  email text not null,
  name text not null,
  display_name text not null,
  status text not null check (status in ('active','expired','suspended')),
  timezone text not null default 'UTC',
  language text not null default 'en',
  notification_preferences jsonb not null default '{"email":true,"sms":false,"marketing":false}'::jsonb,
  billing_email text,
  verification_code_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index customers_email_key on customers (lower(email));

create table subscriptions (
  id text primary key,
  customer_id text not null unique references customers(id),
  tier text not null check (tier in ('free','basic','pro','enterprise')),
  billing_period text not null check (billing_period in ('monthly','annual')),
  status text not null check (status in ('active','expired','suspended','cancelled')),
  monthly_price_cents int not null check (monthly_price_cents >= 0),
  currency text not null default 'USD',
  started_at timestamptz not null
);

create table contracts (
  id text primary key,
  customer_id text not null references customers(id),
  subscription_id text not null references subscriptions(id),
  type text not null check (type in ('monthly','annual','custom')),
  status text not null check (status in ('active','expired','suspended')),
  start_date date not null,
  end_date date not null,
  auto_renew boolean not null default true
);

-- Money is integer minor units (cents). The check constraint keeps refunds financially consistent even if
-- application code is wrong or requests race.
create table payments (
  id text primary key,
  customer_id text not null references customers(id),
  subscription_id text references subscriptions(id),
  amount_cents int not null check (amount_cents > 0),
  currency text not null default 'USD',
  status text not null check (status in ('succeeded','failed','pending')),
  paid_at timestamptz not null,
  refunded_cents int not null default 0,
  constraint refunded_within_amount check (refunded_cents >= 0 and refunded_cents <= amount_cents)
);
create index payments_customer_idx on payments (customer_id, paid_at desc);

create table sessions (
  id text primary key,
  customer_id text references customers(id),
  identity_verified boolean not null default false,
  verified_at timestamptz,
  verify_attempts int not null default 0,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table messages (
  id bigserial primary key,
  session_id text not null references sessions(id),
  role text not null,
  mode text not null,
  content text not null,
  created_at timestamptz not null default now()
);

create table agent_runs (
  id text primary key,
  session_id text not null references sessions(id),
  status text not null,
  mode text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

-- Only full refunds are supported (see refund policy), so at most one refund exists per payment. The unique
-- constraint on payment_id makes a duplicate refund impossible at the database level.
create table refunds (
  id text primary key default ('REF-' || lpad(nextval('refund_seq')::text, 3, '0')),
  payment_id text not null unique references payments(id),
  customer_id text not null references customers(id),
  amount_cents int not null check (amount_cents > 0),
  currency text not null default 'USD',
  status text not null default 'completed',
  simulated boolean not null default true,
  idempotency_key text not null unique,
  session_id text references sessions(id),
  run_id text references agent_runs(id),
  created_at timestamptz not null default now()
);

create table escalation_tickets (
  id text primary key default ('TKT-' || lpad(nextval('ticket_seq')::text, 3, '0')),
  session_id text not null references sessions(id),
  run_id text references agent_runs(id),
  customer_id text references customers(id),
  category text not null,
  priority text not null check (priority in ('low','normal','high','urgent')),
  reason text not null,
  summary text not null,
  inquiry text,
  policy_references jsonb not null default '[]'::jsonb,
  completed_tool_executions jsonb not null default '[]'::jsonb,
  status text not null default 'open',
  idempotency_key text not null unique,
  created_at timestamptz not null default now()
);

create table tool_executions (
  id uuid primary key,
  run_id text not null references agent_runs(id),
  session_id text not null references sessions(id),
  tool_call_id text not null,
  tool text not null,
  tool_type text,
  args jsonb,
  result jsonb,
  status text not null check (status in ('success','failed')),
  error_code text,
  attempts int not null default 1,
  duration_ms int,
  idempotency_key text,
  created_at timestamptz not null default now()
);
create index tool_executions_run_idx on tool_executions (run_id, created_at);

create table audit_logs (
  id bigserial primary key,
  session_id text,
  customer_id text,
  actor text not null,
  action text not null,
  entity_type text not null,
  entity_id text not null,
  previous_value jsonb,
  new_value jsonb,
  created_at timestamptz not null default now()
);
create index audit_logs_entity_idx on audit_logs (entity_type, entity_id);

create table trace_events (
  id bigserial primary key,
  run_id text not null references agent_runs(id),
  seq int not null,
  type text not null,
  data jsonb,
  created_at timestamptz not null default now()
);

create table usage_metrics (
  run_id text primary key references agent_runs(id),
  input_tokens int default 0,
  output_tokens int default 0,
  embedding_tokens int default 0,
  audio_seconds real default 0,
  est_cost_usd numeric(10,6) default 0,
  total_latency_ms int,
  first_token_ms int
);

create table agent_checkpoints (
  session_id text primary key references sessions(id),
  state jsonb not null,
  updated_at timestamptz not null default now()
);
