-- =========================================================
-- Migration 003: Inbox watermark
-- - Adds connected_at to oauth_tokens so the poller only
--   processes mail received AFTER mailbox connect / reconnect.
-- - The poller appends `after:<unix>` to the Gmail query,
--   so existing backlog never gets auto-replied.
-- - Backfills existing rows to now() — on first deploy of
--   this code, every tenant starts from a clean watermark.
-- =========================================================

begin;

alter table oauth_tokens
  add column connected_at timestamptz not null default now();

commit;
