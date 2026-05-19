import { describe, it, expect } from 'vitest';
import { ownerHasReplied } from '../../src/pipeline/thread-guard.js';

const OWNER = 'ayush@aiagencycorp.com';

describe('ownerHasReplied', () => {
  it('returns false when thread has only inbound messages', () => {
    const thread = [
      { from: 'client@x.com', gmailMessageId: 'm1' },
      { from: 'client@x.com', gmailMessageId: 'm2' },
    ];
    expect(ownerHasReplied(thread, OWNER, new Set())).toBe(false);
  });

  it('returns false when all owner-sent messages are tracked (bot-sent)', () => {
    const thread = [
      { from: 'client@x.com', gmailMessageId: 'm1' },
      { from: OWNER, gmailMessageId: 'bot-1' },
    ];
    expect(ownerHasReplied(thread, OWNER, new Set(['bot-1']))).toBe(false);
  });

  it('returns true when owner sent a message the bot did not send', () => {
    const thread = [
      { from: 'client@x.com', gmailMessageId: 'm1' },
      { from: OWNER, gmailMessageId: 'human-1' },
    ];
    expect(ownerHasReplied(thread, OWNER, new Set(['bot-1']))).toBe(true);
  });

  it('is case-insensitive on email comparison', () => {
    const thread = [{ from: 'AYUSH@AIAGENCYCORP.COM', gmailMessageId: 'human-1' }];
    expect(ownerHasReplied(thread, OWNER, new Set())).toBe(true);
  });

  it('matches owner via angle-bracket From format', () => {
    const thread = [{ from: 'Ayush Gupta <ayush@aiagencycorp.com>', gmailMessageId: 'h' }];
    expect(ownerHasReplied(thread, OWNER, new Set())).toBe(true);
  });
});
