-- Phase 8: the daily budget check sums today's usage on every new run, so it needs these.
create index if not exists model_invocations_started_idx on model_invocations (started_at);
create index if not exists voice_usage_updated_idx on voice_usage (updated_at);
