import { describe, it, expect } from 'vitest';
import { isAutoOrBulk } from '../../src/pipeline/loop-guard.js';

describe('isAutoOrBulk', () => {
  it('returns false for ordinary mail', () => {
    expect(isAutoOrBulk({ from: 'alice@example.com', subject: 'Hi' })).toBe(false);
  });

  it('detects Auto-Submitted: auto-replied', () => {
    expect(isAutoOrBulk({ 'auto-submitted': 'auto-replied' })).toBe(true);
  });

  it('detects Auto-Submitted: auto-generated', () => {
    expect(isAutoOrBulk({ 'auto-submitted': 'auto-generated' })).toBe(true);
  });

  it('ignores Auto-Submitted: no', () => {
    expect(isAutoOrBulk({ 'auto-submitted': 'no' })).toBe(false);
  });

  it('detects X-Autoreply', () => {
    expect(isAutoOrBulk({ 'x-autoreply': 'yes' })).toBe(true);
  });

  it('detects Precedence: bulk', () => {
    expect(isAutoOrBulk({ precedence: 'bulk' })).toBe(true);
  });

  it('detects Precedence: list', () => {
    expect(isAutoOrBulk({ precedence: 'list' })).toBe(true);
  });

  it('detects List-Unsubscribe (newsletter)', () => {
    expect(isAutoOrBulk({ 'list-unsubscribe': '<mailto:unsub@x.com>' })).toBe(true);
  });

  it('is case-insensitive on header names', () => {
    expect(isAutoOrBulk({ 'Auto-Submitted': 'auto-replied' } as Record<string, string>)).toBe(true);
  });
});
