import type { SupabaseClient } from '@supabase/supabase-js';

export function tenantScoped(supabase: SupabaseClient, tenantId: string) {
  return {
    from(table: string) {
      const builder = supabase.from(table) as unknown as Record<string, unknown>;
      const inject = { tenant_id: tenantId };

      return {
        select(...args: unknown[]) {
          const q = (builder.select as (...a: unknown[]) => { eq: (k: string, v: unknown) => unknown })(...args);
          return (q.eq as (k: string, v: unknown) => unknown)('tenant_id', tenantId);
        },
        insert(payload: Record<string, unknown> | Record<string, unknown>[]) {
          const enriched = Array.isArray(payload)
            ? payload.map((row) => ({ ...row, ...inject }))
            : { ...payload, ...inject };
          return (builder.insert as (p: typeof enriched) => unknown)(enriched);
        },
        update(payload: Record<string, unknown>) {
          const q = (builder.update as (p: typeof payload) => { eq: (k: string, v: unknown) => unknown })(payload);
          return q.eq('tenant_id', tenantId);
        },
        delete() {
          const q = (builder.delete as () => { eq: (k: string, v: unknown) => unknown })();
          return q.eq('tenant_id', tenantId);
        },
        upsert(payload: Record<string, unknown> | Record<string, unknown>[], opts?: unknown) {
          const enriched = Array.isArray(payload)
            ? payload.map((row) => ({ ...row, ...inject }))
            : { ...payload, ...inject };
          return (builder.upsert as (p: typeof enriched, o?: unknown) => unknown)(enriched, opts);
        },
      };
    },
  };
}
