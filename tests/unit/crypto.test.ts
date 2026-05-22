import { describe, it, expect } from 'vitest';
import { encryptToken, decryptToken, maybeEncrypt, maybeDecrypt } from '../../src/lib/crypto.js';

describe('encryptToken / decryptToken', () => {
  it('round-trips a short string', () => {
    const plaintext = 'ya29.A0AfH6SMC_short_access_token';
    const enc = encryptToken(plaintext);
    expect(enc).not.toBe(plaintext);
    expect(enc.startsWith('v1:')).toBe(true);
    expect(decryptToken(enc)).toBe(plaintext);
  });

  it('round-trips a long refresh-token-shaped string', () => {
    const plaintext = '1//0' + 'a'.repeat(120);
    expect(decryptToken(encryptToken(plaintext))).toBe(plaintext);
  });

  it('round-trips unicode / multi-byte characters', () => {
    const plaintext = 'héllo · 你好 · 🔐';
    expect(decryptToken(encryptToken(plaintext))).toBe(plaintext);
  });

  it('produces a different ciphertext each call (random IV)', () => {
    const plaintext = 'same-input';
    const a = encryptToken(plaintext);
    const b = encryptToken(plaintext);
    expect(a).not.toBe(b);
    expect(decryptToken(a)).toBe(plaintext);
    expect(decryptToken(b)).toBe(plaintext);
  });

  it('returns plaintext unchanged when payload lacks the v1: prefix (legacy rows)', () => {
    // Backward compat: rows written before encryption shipped are returned as-is.
    expect(decryptToken('plain-text-legacy-token')).toBe('plain-text-legacy-token');
  });

  it('rejects a tampered ciphertext (auth tag check)', () => {
    const enc = encryptToken('original');
    // Flip the last base64 char — corrupts the ciphertext bytes
    const tampered = enc.slice(0, -2) + (enc.slice(-2) === 'AA' ? 'BB' : 'AA');
    expect(() => decryptToken(tampered)).toThrow();
  });

  it('rejects a too-short payload', () => {
    expect(() => decryptToken('v1:AAAA')).toThrow(/too short/);
  });

  it('maybeEncrypt / maybeDecrypt return null for null and undefined', () => {
    expect(maybeEncrypt(null)).toBeNull();
    expect(maybeEncrypt(undefined)).toBeNull();
    expect(maybeDecrypt(null)).toBeNull();
    expect(maybeDecrypt(undefined)).toBeNull();
  });

  it('maybeEncrypt + maybeDecrypt round-trip a non-null value', () => {
    expect(maybeDecrypt(maybeEncrypt('hello'))).toBe('hello');
  });
});
