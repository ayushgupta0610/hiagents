import { describe, it, expect, vi } from 'vitest';
import { tenantScoped } from '../../src/tenant/scoped.js';

describe('tenantScoped', () => {
  it('adds eq("tenant_id", id) on select queries', () => {
    const builder = { eq: vi.fn().mockReturnThis(), select: vi.fn().mockReturnThis() };
    const from = vi.fn().mockReturnValue(builder);
    const supabase = { from } as unknown as { from: typeof from };

    const scoped = tenantScoped(supabase as never, 'tenant-123');
    scoped.from('kb_documents').select('*');

    expect(from).toHaveBeenCalledWith('kb_documents');
    expect(builder.eq).toHaveBeenCalledWith('tenant_id', 'tenant-123');
  });

  it('adds tenant_id to insert payloads (object form)', () => {
    const builder = { insert: vi.fn().mockReturnThis() };
    const from = vi.fn().mockReturnValue(builder);
    const supabase = { from } as unknown as { from: typeof from };

    const scoped = tenantScoped(supabase as never, 'tenant-123');
    scoped.from('kb_documents').insert({ filename: 'a.pdf' });

    expect(builder.insert).toHaveBeenCalledWith({ filename: 'a.pdf', tenant_id: 'tenant-123' });
  });

  it('adds tenant_id to insert payloads (array form)', () => {
    const builder = { insert: vi.fn().mockReturnThis() };
    const from = vi.fn().mockReturnValue(builder);
    const supabase = { from } as unknown as { from: typeof from };

    const scoped = tenantScoped(supabase as never, 'tenant-123');
    scoped.from('kb_chunks').insert([{ chunk_index: 0 }, { chunk_index: 1 }]);

    expect(builder.insert).toHaveBeenCalledWith([
      { chunk_index: 0, tenant_id: 'tenant-123' },
      { chunk_index: 1, tenant_id: 'tenant-123' },
    ]);
  });

  it('adds eq("tenant_id", id) on update queries', () => {
    const builder = { eq: vi.fn().mockReturnThis(), update: vi.fn().mockReturnThis() };
    const from = vi.fn().mockReturnValue(builder);
    const supabase = { from } as unknown as { from: typeof from };

    const scoped = tenantScoped(supabase as never, 'tenant-123');
    scoped.from('kb_documents').update({ status: 'ingested' });

    expect(builder.update).toHaveBeenCalledWith({ status: 'ingested' });
    expect(builder.eq).toHaveBeenCalledWith('tenant_id', 'tenant-123');
  });

  it('adds eq("tenant_id", id) on delete queries', () => {
    const builder = { eq: vi.fn().mockReturnThis(), delete: vi.fn().mockReturnThis() };
    const from = vi.fn().mockReturnValue(builder);
    const supabase = { from } as unknown as { from: typeof from };

    const scoped = tenantScoped(supabase as never, 'tenant-123');
    scoped.from('kb_documents').delete();

    expect(builder.delete).toHaveBeenCalled();
    expect(builder.eq).toHaveBeenCalledWith('tenant_id', 'tenant-123');
  });
});
