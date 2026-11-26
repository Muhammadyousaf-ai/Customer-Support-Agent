-- Phase 9: accounts + RBAC, human support tickets, handover, knowledge-base management.
create extension if not exists pgcrypto;

create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  password_hash text,                                  -- null until an invited staff member sets a password
  role text not null check (role in ('admin','staff','customer')),
  status text not null check (status in ('pending_verification','invited','active','suspended')),
  display_name text not null,
  email_verified_at timestamptz,
  customer_id text references customers(id),           -- optional link to the mock business customer
  failed_logins int not null default 0,
  locked_until timestamptz,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_login_at timestamptz
);
create unique index users_email_key on users (lower(email));

create table staff_profiles (
  user_id uuid primary key references users(id) on delete cascade,
  available boolean not null default true,             -- eligible for automatic assignment
  max_active_tickets int not null default 10,
  updated_at timestamptz not null default now()
);

-- Refresh sessions: opaque rotating tokens, stored hashed. A family is every token descended from one login.
create table auth_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  family_id uuid not null,
  refresh_hash text not null unique,
  replaced_by uuid,
  user_agent text,
  ip text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_reason text
);
create index auth_sessions_user_idx on auth_sessions (user_id) where revoked_at is null;
create index auth_sessions_family_idx on auth_sessions (family_id);

create table auth_tokens (                              -- email verification, password reset, staff invitation
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  purpose text not null check (purpose in ('verify_email','reset_password','invite')),
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table email_outbox (                             -- what would be sent; a mail provider drains it (none is configured)
  id bigserial primary key,
  to_address text not null,
  subject text not null,
  body text not null,
  purpose text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create table app_settings (
  key text primary key,
  value jsonb not null,
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);
insert into app_settings (key, value) values ('assignment_mode', '"manual"'::jsonb);

-- Sessions belong to an account when the customer is signed in; anonymous demo sessions keep working.
alter table sessions add column user_id uuid references users(id);
alter table sessions add column handover_mode text not null default 'AI_ACTIVE' check (handover_mode in ('AI_ACTIVE','WAITING_FOR_STAFF','HUMAN_ACTIVE'));
create index sessions_user_idx on sessions (user_id, created_at desc);
alter table messages add column author text not null default 'ai' check (author in ('ai','customer','staff'));
alter table messages add column author_user_id uuid references users(id);

-- The existing AI escalation ticket becomes the support ticket.
alter table escalation_tickets
  add column user_id uuid references users(id),
  add column subject text,
  add column ai_summary text,
  add column source text not null default 'ai_chat' check (source in ('ai_chat','ai_voice','manual')),
  add column assigned_staff_id uuid references users(id),
  add column assigned_at timestamptz,
  add column first_response_at timestamptz,
  add column resolved_at timestamptz,
  add column resolution text,
  add column updated_at timestamptz not null default now();
alter table escalation_tickets add constraint escalation_tickets_status_check check (status in ('open','assigned','in_progress','waiting_customer','pending_review','resolved','closed'));
create index escalation_tickets_assignee_idx on escalation_tickets (assigned_staff_id, status);
create index escalation_tickets_user_idx on escalation_tickets (user_id);
create index escalation_tickets_status_idx on escalation_tickets (status, created_at);

create table ticket_assignments (
  id bigserial primary key,
  ticket_id text not null references escalation_tickets(id) on delete cascade,
  staff_id uuid references users(id),                   -- null = unassigned
  assigned_by uuid references users(id),                -- null = automatic
  method text not null check (method in ('self','manual','reassign','round_robin','workload','unassign')),
  created_at timestamptz not null default now()
);
create index ticket_assignments_ticket_idx on ticket_assignments (ticket_id, id);

create table ticket_messages (                          -- the human conversation: customer <-> staff
  id bigserial primary key,
  ticket_id text not null references escalation_tickets(id) on delete cascade,
  author_kind text not null check (author_kind in ('customer','staff','system')),
  author_user_id uuid references users(id),
  body text not null,
  created_at timestamptz not null default now()
);
create index ticket_messages_ticket_idx on ticket_messages (ticket_id, id);

create table ticket_notes (                             -- internal: never visible to customers
  id bigserial primary key,
  ticket_id text not null references escalation_tickets(id) on delete cascade,
  author_user_id uuid not null references users(id),
  body text not null,
  created_at timestamptz not null default now()
);

create table ticket_status_history (
  id bigserial primary key,
  ticket_id text not null references escalation_tickets(id) on delete cascade,
  from_status text,
  to_status text not null,
  changed_by uuid references users(id),
  note text,
  created_at timestamptz not null default now()
);

create table notifications (
  id bigserial primary key,
  user_id uuid not null references users(id) on delete cascade,
  kind text not null,
  title text not null,
  body text,
  ticket_id text,
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index notifications_user_idx on notifications (user_id, created_at desc);

alter table audit_logs add column actor_user_id uuid;
alter table audit_logs add column actor_role text;
create index audit_logs_created_idx on audit_logs (created_at desc);

-- Knowledge-base management. A "document" here is the editable source (markdown with frontmatter); publishing indexes it into
-- the existing documents/document_chunks tables that retrieval already reads. Failed indexing never touches what is published.
create table kb_documents (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  category text not null,
  status text not null default 'draft' check (status in ('draft','published','deleted')),
  published_version int,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index kb_documents_title_key on kb_documents (lower(title)) where status <> 'deleted';
create table kb_document_versions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references kb_documents(id) on delete cascade,
  version int not null,
  source text not null,
  status text not null default 'draft' check (status in ('draft','published','superseded','failed')),
  index_status text not null default 'not_indexed' check (index_status in ('not_indexed','indexed','failed')),
  index_error text,
  chunks int,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  published_at timestamptz,
  unique (document_id, version)
);

-- seedDatabase() truncates customers CASCADE to reset demo data; accounts must survive that, so the link is soft (validated in code).
alter table users drop constraint users_customer_id_fkey;
