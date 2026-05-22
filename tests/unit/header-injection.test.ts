import { describe, it, expect } from 'vitest';
import { sanitizeHeader, sanitizeMessageId } from '../../src/providers/gmail.js';

describe('sanitizeHeader', () => {
  it('passes through ordinary values unchanged', () => {
    expect(sanitizeHeader('alice@example.com')).toBe('alice@example.com');
    expect(sanitizeHeader('Re: your order #1234')).toBe('Re: your order #1234');
  });

  it('strips CRLF (the actual header-injection vector)', () => {
    expect(sanitizeHeader('foo\r\nBcc: attacker@evil.com')).toBe(
      'foo Bcc: attacker@evil.com',
    );
  });

  it('strips bare LF and bare CR', () => {
    expect(sanitizeHeader('foo\nBcc: x@y.com')).toBe('foo Bcc: x@y.com');
    expect(sanitizeHeader('foo\rBcc: x@y.com')).toBe('foo Bcc: x@y.com');
  });

  it('strips NUL bytes', () => {
    expect(sanitizeHeader('foo\0bar')).toBe('foo bar');
  });

  it('collapses runs of whitespace produced by stripping', () => {
    expect(sanitizeHeader('foo\r\n\r\n\r\nBcc: x')).toBe('foo Bcc: x');
  });

  it('caps length at maxLen', () => {
    const long = 'a'.repeat(2000);
    expect(sanitizeHeader(long, 500)).toHaveLength(500);
  });

  it('handles empty / whitespace-only input', () => {
    expect(sanitizeHeader('')).toBe('');
    expect(sanitizeHeader('   ')).toBe('');
    expect(sanitizeHeader('\r\n')).toBe('');
  });
});

describe('sanitizeMessageId', () => {
  it('accepts a well-formed <local@host> id', () => {
    expect(sanitizeMessageId('<abc123@mail.example.com>', 'fallback')).toBe(
      '<abc123@mail.example.com>',
    );
  });

  it('falls back when input is missing', () => {
    expect(sanitizeMessageId(undefined, 'GMAILID')).toBe('<GMAILID>');
  });

  it('falls back when input has no angle brackets', () => {
    expect(sanitizeMessageId('abc123@mail.example.com', 'GMAILID')).toBe('<GMAILID>');
  });

  it('falls back on CRLF-injected msg-id (refuses to echo into header)', () => {
    expect(sanitizeMessageId('<abc@host>\r\nBcc: attacker@evil', 'SAFE')).toBe('<SAFE>');
  });

  it('falls back when input has internal whitespace', () => {
    expect(sanitizeMessageId('<abc abc@host>', 'SAFE')).toBe('<SAFE>');
  });

  it('falls back when input has no @', () => {
    expect(sanitizeMessageId('<nodomain>', 'SAFE')).toBe('<SAFE>');
  });
});
