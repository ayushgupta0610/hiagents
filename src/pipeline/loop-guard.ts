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

// Senders we never reply to under any circumstances — mail servers, common
// no-reply patterns, and known auto-responder addresses. Matched case-
// insensitively against the local-part of the From address.
const SYSTEM_SENDER_LOCALPARTS: RegExp[] = [
  /^mailer-daemon$/i,
  /^postmaster$/i,
  /^no[-_]?reply$/i,
  /^do[-_]?not[-_]?reply$/i,
  /^donotreply$/i,
  /^bounces?$/i,
  /^bounce[-_].*$/i,
  /^notifications?$/i,
  /^auto[-_]?reply$/i,
  /^autoreply$/i,
  /^abuse$/i,
  /^support[-_]?bot$/i,
];

// Domains we never reply to (mailer infrastructure)
const SYSTEM_SENDER_DOMAINS: RegExp[] = [
  /^bounces?\./i,
  /^mailer\./i,
  /\.bounces?\..+$/i,
];

function extractEmail(from: string): string {
  const match = from.match(/<([^>]+)>/);
  return (match?.[1] ?? from).trim().toLowerCase();
}

/**
 * Returns true if the From address looks like a system / automated / no-reply
 * sender that we should never auto-respond to (loop / mail-server / abuse risk).
 */
export function isSystemSender(fromHeader: string): boolean {
  if (!fromHeader) return false;
  const email = extractEmail(fromHeader);
  const at = email.lastIndexOf('@');
  if (at < 1) return false;
  const localPart = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (SYSTEM_SENDER_LOCALPARTS.some((re) => re.test(localPart))) return true;
  if (SYSTEM_SENDER_DOMAINS.some((re) => re.test(domain))) return true;
  return false;
}

export const OUTGOING_LOOP_HEADERS: Record<string, string> = {
  'Auto-Submitted': 'auto-replied',
  'X-Autoreply': 'hiagents',
};
