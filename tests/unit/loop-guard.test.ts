import { describe, it, expect } from 'vitest';
import { isAutoOrBulk, isSystemSender } from '../../src/pipeline/loop-guard.js';

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

describe('isSystemSender', () => {
  it('flags mailer-daemon', () => {
    expect(isSystemSender('mailer-daemon@gmail.com')).toBe(true);
    expect(isSystemSender('MAILER-DAEMON@google.com')).toBe(true);
  });
  it('flags noreply / no-reply / donotreply / do-not-reply', () => {
    expect(isSystemSender('noreply@example.com')).toBe(true);
    expect(isSystemSender('no-reply@example.com')).toBe(true);
    expect(isSystemSender('donotreply@example.com')).toBe(true);
    expect(isSystemSender('do-not-reply@example.com')).toBe(true);
    expect(isSystemSender('"Notifications" <notifications@example.com>')).toBe(true);
  });
  it('flags postmaster, bounces, abuse', () => {
    expect(isSystemSender('postmaster@gmail.com')).toBe(true);
    expect(isSystemSender('bounces@news.example.com')).toBe(true);
    expect(isSystemSender('bounce-1234@example.com')).toBe(true);
    expect(isSystemSender('abuse@example.com')).toBe(true);
  });
  it('flags mailer infrastructure domains', () => {
    expect(isSystemSender('hello@bounces.example.com')).toBe(true);
    expect(isSystemSender('hello@mailer.example.com')).toBe(true);
  });
  it('handles angle-bracket From format', () => {
    expect(isSystemSender('Mail Delivery <mailer-daemon@gmail.com>')).toBe(true);
  });
  it('returns false for ordinary humans', () => {
    expect(isSystemSender('alice@example.com')).toBe(false);
    expect(isSystemSender('Bob Smith <bob@acme.com>')).toBe(false);
    expect(isSystemSender('client@inbox-ai.dev')).toBe(false);
  });
  it('returns false on malformed input', () => {
    expect(isSystemSender('')).toBe(false);
    expect(isSystemSender('@example.com')).toBe(false);
    expect(isSystemSender('not-an-email')).toBe(false);
  });
});
