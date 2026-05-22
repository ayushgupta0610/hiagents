import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Agent, setGlobalDispatcher } from 'undici';
import { env } from '../config.js';

// Cap the number of concurrent HTTPS connections to PostgREST. Supabase's
// supabase-js client doesn't pool PG connections itself (PostgREST proxies
// per-request through pgbouncer), so what we actually need to cap is
// outbound HTTPS sockets to Supabase. Without a cap, a burst of 100
// parallel tenant queries opens 100 sockets — Supabase free tier has a
// 60-connection pgbouncer pool, paid pro has ~200; either is easy to
// exhaust during a poll tick at scale.
//
// 32 leaves headroom for user requests in the same process. Tuneable via
// SUPABASE_MAX_SOCKETS env if you upsize the pgbouncer pool.
const MAX_SOCKETS = Number(process.env.SUPABASE_MAX_SOCKETS ?? 32);
setGlobalDispatcher(
  new Agent({
    connections: MAX_SOCKETS,
    pipelining: 1,
    keepAliveTimeout: 30_000,
    keepAliveMaxTimeout: 60_000,
  }),
);

let client: SupabaseClient | null = null;

export function db(): SupabaseClient {
  if (!client) {
    client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}
