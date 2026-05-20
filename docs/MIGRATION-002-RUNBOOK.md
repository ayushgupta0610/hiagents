# Migration 002 Runbook — Multi-tenant SaaS

This migration is **non-reversible** automatically. Test on a Supabase branch first.

## Prerequisites
- Existing `001_init.sql` migration applied
- Existing data is single-tenant (1 oauth_tokens row, N kb_documents, N kb_chunks, N messages)

## Steps

1. **Snapshot the database** in Supabase dashboard (Database → Backups → "Take backup")
2. **Test on a branch first**:
   - Supabase dashboard → Branching → Create branch → "migration-002-test"
   - Run migration SQL in the branch's SQL editor
   - Verify: `select count(*) from tenants;` returns 1, `select count(*) from memberships;` returns 1
   - Verify: every existing `kb_documents` / `kb_chunks` / `messages` / `oauth_tokens` row has a non-null `tenant_id` matching the default tenant
   - Verify: `select * from match_kb_chunks(...)` with the default tenant id returns expected results
3. **If branch test passes**, merge the branch (or copy SQL into prod and run)
4. **Verify in prod**: same checks as step 2
5. **Update the app** (subsequent tasks in this plan) so it knows about the new schema

## Rollback (if migration fails mid-way)

The migration is wrapped in `BEGIN; ... COMMIT;` — if any statement fails, the whole transaction rolls back. Inspect the error and re-run after fixing.

If the migration committed but the app then breaks, you can:
- Restore from the snapshot taken in step 1
- Or run a custom reverse migration (not provided — the migration drops the singleton id from oauth_tokens, which is non-trivial to restore)
