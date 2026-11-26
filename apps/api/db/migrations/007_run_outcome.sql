-- Keep what a run produced, so a retried client message can be answered from the stored result.
alter table agent_runs
  add column sources jsonb not null default '[]'::jsonb,
  add column escalation_ticket_id text,
  add column pending_action_id text;
