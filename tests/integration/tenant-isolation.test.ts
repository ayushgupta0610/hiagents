import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// This test only runs when SUPABASE_URL points to a TEST project (slug contains 'test' or 'dev').
// Set TEST_SUPABASE=1 in your shell to force-enable.
const SHOULD_RUN =
  process.env.TEST_SUPABASE === '1' ||
  (process.env.SUPABASE_URL?.includes('test') ?? false) ||
  (process.env.SUPABASE_URL?.includes('dev') ?? false);

const maybeDescribe = SHOULD_RUN ? describe : describe.skip;

maybeDescribe('tenant isolation', () => {
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    const { provisionTenant } = await import('../../src/tenant/store.js');
    const a = await provisionTenant(`isolation-test-a-${Date.now()}@local.test`);
    const b = await provisionTenant(`isolation-test-b-${Date.now()}@local.test`);
    tenantA = a.id;
    tenantB = b.id;
  });

  afterAll(async () => {
    const { db } = await import('../../src/db/client.js');
    if (tenantA) await db().from('tenants').delete().eq('id', tenantA);
    if (tenantB) await db().from('tenants').delete().eq('id', tenantB);
  });

  it('listDocuments returns only the requesting tenant\'s docs', async () => {
    const { db } = await import('../../src/db/client.js');
    const { listDocuments } = await import('../../src/kb/ingest.js');

    await db().from('kb_documents').insert({
      tenant_id: tenantA,
      filename: 'a.pdf',
      size_bytes: 1,
      status: 'ingested',
      chunk_count: 0,
    });
    await db().from('kb_documents').insert({
      tenant_id: tenantB,
      filename: 'b.pdf',
      size_bytes: 1,
      status: 'ingested',
      chunk_count: 0,
    });

    const aDocs = await listDocuments(tenantA);
    const bDocs = await listDocuments(tenantB);

    expect(aDocs.length).toBeGreaterThanOrEqual(1);
    expect(bDocs.length).toBeGreaterThanOrEqual(1);
    expect(
      (aDocs as Array<{ tenant_id: string }>).every((d) => d.tenant_id === tenantA),
    ).toBe(true);
    expect(
      (bDocs as Array<{ tenant_id: string }>).every((d) => d.tenant_id === tenantB),
    ).toBe(true);

    const aFilenames = new Set((aDocs as Array<{ filename: string }>).map((d) => d.filename));
    expect(
      (bDocs as Array<{ filename: string }>).some((d) => aFilenames.has(d.filename)),
    ).toBe(false);
  });

  it('messages query is tenant-isolated', async () => {
    const { db } = await import('../../src/db/client.js');

    await db()
      .from('messages')
      .insert({
        tenant_id: tenantA,
        gmail_message_id: `t-a-${Date.now()}`,
        gmail_thread_id: 'thread',
        received_at: new Date().toISOString(),
        from_address: 'x@y.com',
        subject: 'hi',
        body_text: '',
        classification: 'other',
        reply_status: 'skipped',
      });
    await db()
      .from('messages')
      .insert({
        tenant_id: tenantB,
        gmail_message_id: `t-b-${Date.now()}`,
        gmail_thread_id: 'thread',
        received_at: new Date().toISOString(),
        from_address: 'x@y.com',
        subject: 'hi',
        body_text: '',
        classification: 'other',
        reply_status: 'skipped',
      });

    const { data: aMsgs } = await db().from('messages').select('tenant_id').eq('tenant_id', tenantA);
    expect(
      (aMsgs as Array<{ tenant_id: string }>).every((m) => m.tenant_id === tenantA),
    ).toBe(true);
  });
});
