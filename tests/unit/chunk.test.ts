import { describe, it, expect } from 'vitest';
import { chunkText } from '../../src/kb/chunk.js';

describe('chunkText', () => {
  it('returns one chunk for short text', () => {
    const chunks = chunkText('hello world', { chunkSize: 100, overlap: 0 });
    expect(chunks).toEqual(['hello world']);
  });

  it('splits long text into multiple chunks of approx chunkSize', () => {
    const text = 'a'.repeat(2500);
    const chunks = chunkText(text, { chunkSize: 1000, overlap: 0 });
    expect(chunks.length).toBe(3);
    expect(chunks[0].length).toBeLessThanOrEqual(1000);
  });

  it('applies overlap between chunks', () => {
    const text = 'abcdefghij'.repeat(200); // 2000 chars
    const chunks = chunkText(text, { chunkSize: 500, overlap: 100 });
    expect(chunks.length).toBeGreaterThan(1);
    // last 100 chars of chunk[0] should equal first 100 chars of chunk[1]
    const tail = chunks[0].slice(-100);
    const head = chunks[1].slice(0, 100);
    expect(head).toBe(tail);
  });

  it('prefers splitting on paragraph boundaries when present', () => {
    const text = ['para one.', 'para two.', 'para three.'].join('\n\n').padEnd(1100, ' ');
    const chunks = chunkText(text, { chunkSize: 500, overlap: 0 });
    // No chunk should start mid-paragraph if a boundary was available
    expect(chunks[0].endsWith('para two.') || chunks[0].endsWith('para one.')).toBeTruthy();
  });

  it('throws on empty input', () => {
    expect(() => chunkText('', { chunkSize: 100, overlap: 0 })).toThrow();
  });
});
