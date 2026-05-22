import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '../config.js';

// AES-256-GCM at-rest encryption for OAuth tokens.
//
// Format: "v1:" + base64(iv || authTag || ciphertext)
//   - v1 prefix lets us rotate algorithms without ambiguity
//   - 12-byte iv (random per encrypt — AES-GCM requirement: never reuse a
//     (key, iv) pair, or the keystream leaks and forgeries become possible)
//   - 16-byte auth tag (GCM default; rejects any byte-flip on decrypt)
//
// TOKEN_ENCRYPTION_KEY is base64-encoded 32 bytes (validated by config.ts to
// be ≥40 chars; base64(32 bytes) = 44 chars). Anything else throws on first
// use rather than producing a weak key.

const VERSION_PREFIX = 'v1:';
const IV_BYTES = 12;
const TAG_BYTES = 16;

let cachedKey: Buffer | null = null;
function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const decoded = Buffer.from(env.TOKEN_ENCRYPTION_KEY, 'base64');
  if (decoded.length !== 32) {
    throw new Error(
      `TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes (got ${decoded.length}). ` +
        `Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
    );
  }
  cachedKey = decoded;
  return cachedKey;
}

export function encryptToken(plaintext: string): string {
  if (typeof plaintext !== 'string') {
    throw new Error('encryptToken: plaintext must be a string');
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return VERSION_PREFIX + Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

export function decryptToken(payload: string): string {
  if (typeof payload !== 'string' || !payload) {
    throw new Error('decryptToken: payload must be a non-empty string');
  }
  if (!payload.startsWith(VERSION_PREFIX)) {
    // Backward compat: payload is unencrypted (rows written before this
    // module landed). Return as-is so existing tenants keep working until
    // the first refresh-token rotation re-saves them encrypted.
    return payload;
  }
  const buf = Buffer.from(payload.slice(VERSION_PREFIX.length), 'base64');
  if (buf.length < IV_BYTES + TAG_BYTES + 1) {
    throw new Error('decryptToken: payload too short to be valid');
  }
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = buf.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', getKey(), iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf-8');
}

// Transparent helpers for fields that may or may not be present. Tokens
// stored in oauth_tokens are non-null, but we keep this null-tolerant for
// any future optional columns.
export function maybeEncrypt(plaintext: string | null | undefined): string | null {
  if (plaintext == null) return null;
  return encryptToken(plaintext);
}

export function maybeDecrypt(payload: string | null | undefined): string | null {
  if (payload == null) return null;
  return decryptToken(payload);
}
