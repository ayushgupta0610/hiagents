import { describe, it, expect, vi } from 'vitest';
import { classifyWith } from '../../src/pipeline/classifier.js';

describe('classifyWith', () => {
  it('returns "client_query" when LLM responds CLIENT_QUERY', async () => {
    const result = await classifyWith(async () => 'CLIENT_QUERY', {
      from: 'lead@x.com',
      subject: 'pricing',
      bodyText: 'how much?',
    });
    expect(result).toBe('client_query');
  });

  it('returns "other" when LLM responds OTHER', async () => {
    const result = await classifyWith(async () => 'OTHER', {
      from: 'noreply@x.com',
      subject: 'Your receipt',
      bodyText: '...',
    });
    expect(result).toBe('other');
  });

  it('treats unknown LLM output as "other" (safe default)', async () => {
    const result = await classifyWith(async () => 'maybe?', {
      from: 'x@y.com',
      subject: 's',
      bodyText: 'b',
    });
    expect(result).toBe('other');
  });

  it('is tolerant of whitespace and case', async () => {
    const result = await classifyWith(async () => '  client_query  ', {
      from: 'x@y.com',
      subject: 's',
      bodyText: 'b',
    });
    expect(result).toBe('client_query');
  });

  it('passes the email fields into the prompt', async () => {
    const spy = vi.fn(async () => 'CLIENT_QUERY');
    await classifyWith(spy, { from: 'lead@x.com', subject: 'demo', bodyText: 'can I see a demo?' });
    const call = spy.mock.calls[0] as [string];
    const prompt = call[0];
    expect(prompt).toContain('lead@x.com');
    expect(prompt).toContain('demo');
    expect(prompt).toContain('can I see a demo?');
  });
});
