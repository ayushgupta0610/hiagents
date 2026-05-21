import { db } from '../src/db/client.js';

const tables = ['tenants', 'memberships', 'audit_log', 'llm_usage'];
for (const t of tables) {
  const { error } = await db().from(t).select('id', { count: 'exact', head: true });
  console.log(t + ':', error ? 'MISSING — ' + error.message : 'ok');
}
const { data: tenants } = await db()
  .from('tenants')
  .select('id, name, slug, onboarding_completed_at, created_by_email')
  .limit(5);
console.log('---tenants---');
console.log(tenants ?? '(none / table missing)');
