// Which incoming emails are automated (no reply, not a request), whether the
// sender was verified by Gmail, and cleaning the text we keep.
// Pure functions over a mailparser result, so they can be unit-tested.

import { LIMITS } from './config.js';

// All values of one header, from the raw header lines (unfolded).
export function headerValues(parsed, name) {
  const want = name.toLowerCase();
  return (parsed?.headerLines || [])
    .filter(h => h.key === want)
    .map(h => {
      const line = String(h.line || '');
      const i = line.indexOf(':');
      return (i >= 0 ? line.slice(i + 1) : line).replace(/\r?\n[ \t]+/g, ' ').trim();
    });
}
export const headerValue = (parsed, name) => headerValues(parsed, name)[0] || '';

export const firstAddress = field => {
  const v = field?.value?.[0];
  return { email: String(v?.address || '').trim().toLowerCase(), name: String(v?.name || '').trim() };
};

const NO_REPLY_LOCAL = /^(no-?reply|do-?not-?reply|donotreply|noreply|mailer-daemon|postmaster|bounces?|notifications?|alerts?|news(letter)?)([+._-].*)?$/i;

// Returns '' for a person, or a short reason the email is automated.
export function automatedReason(parsed, selfEmail = '') {
  const from = firstAddress(parsed?.from);
  if (!from.email) return 'no-sender';
  if (selfEmail && from.email === selfEmail.toLowerCase()) return 'self';
  const autoSubmitted = headerValue(parsed, 'auto-submitted').toLowerCase();
  if (autoSubmitted && autoSubmitted !== 'no') return 'auto-submitted';
  const precedence = headerValue(parsed, 'precedence').toLowerCase();
  if (['bulk', 'junk', 'list', 'auto_reply'].includes(precedence)) return 'bulk';
  if (headerValue(parsed, 'list-id') || headerValue(parsed, 'list-unsubscribe')) return 'mailing-list';
  if (headerValue(parsed, 'x-autoreply') || headerValue(parsed, 'x-autorespond')) return 'auto-reply';
  if (headerValue(parsed, 'return-path') === '<>') return 'bounce';
  if (/multipart\/report/i.test(headerValue(parsed, 'content-type'))) return 'report';
  const local = from.email.split('@')[0];
  if (NO_REPLY_LOCAL.test(local)) return 'no-reply-sender';
  return '';
}

// Gmail stamps its own Authentication-Results on top; a sender can't fake
// that one. Count the sender as verified if SPF or DKIM passed there.
export function authPass(parsed) {
  const results = headerValues(parsed, 'authentication-results');
  const google = results.find(v => /^mx\.google\.com\b/i.test(v));
  if (!google) return false;
  return /\b(dkim|spf)=pass\b/i.test(google);
}

// The sender asked for no automatic replies (RFC 3834 / Outlook header).
export function suppressesAutoReply(parsed) {
  return /\b(all|autoreply|oof)\b/i.test(headerValue(parsed, 'x-auto-response-suppress'));
}

// Plain text we keep: no quoted earlier replies, no signatures' long tails,
// capped length.
export function cleanBody(text) {
  let t = String(text || '').replace(/\r\n?/g, '\n');
  const cut = [
    /^On .{0,200}wrote:\s*$/m,
    /^-{2,}\s*Original Message\s*-{2,}/im,
    /^_{5,}\s*$/m,
    /^From: .+\nSent: /m,
    /^El .{0,200}escribió:\s*$/m
  ];
  for (const re of cut) {
    const m = re.exec(t);
    if (m && m.index > 0) t = t.slice(0, m.index);
  }
  t = t
    .split('\n')
    .filter(line => !/^\s*>/.test(line))
    .join('\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (t.length > LIMITS.bodyChars) t = `${t.slice(0, LIMITS.bodyChars)}\n[…message shortened]`;
  return t;
}

// "a@x.org, b@y.com" or one per line -> Set of lower-case addresses/domains.
export function parseNoReplyList(text) {
  return new Set(
    String(text || '')
      .split(/[\s,;]+/)
      .map(s => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

export function onNoReplyList(email, list) {
  const e = String(email || '').toLowerCase();
  if (!e) return false;
  const domain = e.split('@')[1] || '';
  return list.has(e) || list.has(domain) || list.has(`@${domain}`);
}
