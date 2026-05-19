const AUTO_PATTERNS: ReadonlyArray<[string, RegExp]> = [
  ['auto-submitted', /^(auto-replied|auto-generated|auto-notified)/i],
  ['x-autoreply', /.+/i],
  ['x-autorespond', /.+/i],
  ['precedence', /^(bulk|list|junk)$/i],
  ['list-unsubscribe', /.+/i],
  ['list-id', /.+/i],
];

function lowercaseKeys(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  return out;
}

export function isAutoOrBulk(headers: Record<string, string>): boolean {
  const lower = lowercaseKeys(headers);
  return AUTO_PATTERNS.some(([key, pattern]) => {
    const value = lower[key];
    return typeof value === 'string' && pattern.test(value);
  });
}

export const OUTGOING_LOOP_HEADERS: Record<string, string> = {
  'Auto-Submitted': 'auto-replied',
  'X-Autoreply': 'inbox-ai',
};
