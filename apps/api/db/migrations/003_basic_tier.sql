alter table subscriptions drop constraint if exists subscriptions_tier_check;
alter table subscriptions add constraint subscriptions_tier_check
  check (tier in ('free','basic','pro','enterprise'));
