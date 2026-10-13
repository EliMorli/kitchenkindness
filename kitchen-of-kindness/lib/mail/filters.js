// Which incoming emails are automated (no reply, not a request), whether the
// sender was verified by Gmail, and cleaning the text we keep.
// Pure functions over a mailparser result, so they can be unit-tested.

import { convert as htmlToText } from 'html-to-text';
import { LIMITS } from './config.js';
import { dbText } from './text.js';

export { dbText };

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
  return { email: dbText(v?.address, 320).trim().toLowerCase(), name: dbText(v?.name, 200).trim() };
};

const domainOf = email => String(email || '').split('@')[1]?.toLowerCase().replace(/\.$/, '') || '';
// Same organisation: equal, or one is a subdomain of the other.
const aligned = (a, b) => !!a && !!b && (a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`));

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
// that one. The sender counts as verified only if a check PASSED for the
// From address's own domain (DMARC, or DKIM/SPF aligned with it). Text inside
// comments or addresses can't fake a pass: only each clause's leading
// "method=result" token is read.
export function authPass(parsed) {
  const google = headerValues(parsed, 'authentication-results').find(v => /^mx\.google\.com\s*;/i.test(v));
  if (!google) return false;
  const fromDomain = domainOf(firstAddress(parsed?.from).email);
  if (!fromDomain) return false;
  const clauses = google
    .replace(/\([^()]*\)/g, ' ')
    .split(';')
    .slice(1)
    .map(c => c.trim())
    .filter(Boolean);
  for (const clause of clauses) {
    const m = /^([a-z]+)\s*=\s*([a-z]+)\b(.*)$/i.exec(clause);
    if (!m || m[2].toLowerCase() !== 'pass') continue;
    const method = m[1].toLowerCase();
    const props = {};
    for (const p of m[3].matchAll(/\b([a-z]+(?:\.[a-z]+)?)\s*=\s*("?)([^\s";]+)\2/gi)) props[p[1].toLowerCase()] = p[3].toLowerCase();
    if (method === 'dmarc' && aligned(props['header.from'], fromDomain)) return true;
    if (method === 'dkim') {
      const d = props['header.d'] || domainOf(props['header.i']) || String(props['header.i'] || '').replace(/^@/, '');
      if (aligned(d, fromDomain)) return true;
    }
    if (method === 'spf' && aligned(domainOf(props['smtp.mailfrom']) || props['smtp.mailfrom'], fromDomain)) return true;
  }
  return false;
}

// Where replies go: the verified From address. A Reply-To is used only when
// it is in the sender's own domain, so a stranger can't make the kitchen's
// Gmail email a third party.
export function replyRecipient(parsed) {
  const from = firstAddress(parsed?.from).email;
  const replyTo = firstAddress(parsed?.replyTo).email;
  if (replyTo && aligned(domainOf(replyTo), domainOf(from))) return replyTo;
  return from;
}

// One sender, however they write their address (plus tags, Gmail dots, case),
// for the "one automatic reply per sender per week" rule.
export function replyKey(email) {
  const e = String(email || '').trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at < 1) return e;
  let local = e.slice(0, at).split('+')[0];
  let domain = e.slice(at + 1);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return `${local}@${domain}`;
}

// The email's text: the plain part, or the HTML converted to text when the
// sender's app only sent HTML (common with photos attached).
export function bodyText(parsed) {
  if (parsed?.text && String(parsed.text).trim()) return parsed.text;
  if (!parsed?.html) return '';
  try {
    return htmlToText(String(parsed.html).slice(0, 500_000), {
      wordwrap: false,
      selectors: [
        { selector: 'img', format: 'skip' },
        { selector: 'a', options: { ignoreHref: true } }
      ]
    });
  } catch {
    return '';
  }
}

// The sender asked for no automatic replies (RFC 3834 / Outlook header).
export function suppressesAutoReply(parsed) {
  return /\b(all|autoreply|oof)\b/i.test(headerValue(parsed, 'x-auto-response-suppress'));
}

// Plain text we keep: no quoted earlier replies, no signatures' long tails,
// capped length.
export function cleanBody(text) {
  let t = dbText(text);
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
  if (t.length > LIMITS.bodyChars) t = `${dbText(t, LIMITS.bodyChars)}\n[…message shortened]`;
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
