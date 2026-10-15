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

// An Authentication-Results value as clauses of tokens (RFC 8601). Comments
// (nested, with escapes) are dropped; a quoted string stays inside its token,
// so a quoted address can't add a property or a ';'. Returns null when the
// value is malformed (an unclosed quote or comment).
export function parseAuthResults(value) {
  const s = String(value || '');
  const clauses = [[]];
  let tok = '';
  let depth = 0;
  let inQuote = false;
  const push = () => {
    if (tok) clauses[clauses.length - 1].push(tok);
    tok = '';
  };
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (inQuote) {
      if (ch === '\\') tok += s[++i] ?? '';
      else if (ch === '"') inQuote = false;
      else tok += ch;
    } else if (depth > 0) {
      // Gmail repeats the sender's envelope address in its comments; a quote
      // there could hide a ')' that ends the comment early. Don't trust it.
      if (ch === '"') return null;
      if (ch === '\\') i += 1;
      else if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
    } else if (ch === '"') inQuote = true;
    else if (ch === '(') {
      push();
      depth = 1;
    } else if (ch === ';') {
      push();
      clauses.push([]);
    } else if (/\s/.test(ch)) {
      // "key = value" is one token.
      const next = s.slice(i).search(/\S/);
      if (tok.endsWith('=') || (next >= 0 && s[i + next] === '=')) continue;
      push();
    } else tok += ch;
  }
  if (inQuote || depth > 0) return null;
  push();
  return clauses.filter(c => c.length);
}

// The domain part of a property value: after the last '@' (a quoted local
// part can contain '@' too), or the whole value.
const valueDomain = v => {
  const t = String(v || '').toLowerCase();
  return t.slice(t.lastIndexOf('@') + 1).replace(/\.$/, '');
};

// Gmail stamps its own Authentication-Results on top; a sender can't fake
// that one. Only the top header counts, and only if Gmail wrote it. The
// sender counts as verified only if a check PASSED for the From address's own
// domain (DMARC, or DKIM/SPF aligned with it).
export function authPass(parsed) {
  const top = headerValues(parsed, 'authentication-results')[0];
  const clauses = top ? parseAuthResults(top) : null;
  if (!clauses || clauses[0]?.[0]?.toLowerCase() !== 'mx.google.com') return false;
  const fromDomain = domainOf(firstAddress(parsed?.from).email);
  if (!fromDomain) return false;
  for (const [head, ...rest] of clauses.slice(1)) {
    const m = /^([a-z0-9-]+)=([a-z]+)$/i.exec(head);
    if (!m || m[2].toLowerCase() !== 'pass') continue;
    const method = m[1].toLowerCase();
    const props = {};
    let repeated = false;
    for (const t of rest) {
      const p = /^([a-z0-9-]+\.[a-z0-9-]+)=(.*)$/is.exec(t);
      if (!p) continue;
      const key = p[1].toLowerCase();
      if (key in props) repeated = true;
      props[key] = p[2];
    }
    if (repeated) continue; // ambiguous: don't trust it
    if (method === 'dmarc' && aligned(valueDomain(props['header.from']), fromDomain)) return true;
    if (method === 'dkim' && aligned(valueDomain(props['header.d'] || props['header.i']), fromDomain)) return true;
    if (method === 'spf' && aligned(valueDomain(props['smtp.mailfrom']), fromDomain)) return true;
  }
  return false;
}

// Where the approval email goes: the verified From address, or a Reply-To in
// the sender's own organisation's domain (the card shows it to the admin).
// Automatic replies always go to the From address only.
// At a shared mail provider "same domain" means nothing (anyone can have a
// gmail.com address), so there the Reply-To is ignored.
const SHARED_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'ymail.com',
  'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'gmx.net', 'mail.com',
  'zoho.com', 'yandex.com', 'comcast.net', 'att.net', 'sbcglobal.net', 'verizon.net', 'charter.net', 'cox.net'
]);

export function replyRecipient(parsed) {
  const from = firstAddress(parsed?.from).email;
  const replyTo = firstAddress(parsed?.replyTo).email;
  const domain = domainOf(from);
  if (replyTo && !SHARED_MAIL_DOMAINS.has(domain) && aligned(domainOf(replyTo), domain)) return replyTo;
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
// Each address is also kept in its sender-key form (no +tag, no Gmail dots),
// so it matches however that person writes it.
export function parseNoReplyList(text) {
  const out = new Set();
  for (const s of String(text || '').split(/[\s,;]+/)) {
    const entry = s.trim().toLowerCase();
    if (!entry) continue;
    out.add(entry);
    if (entry.indexOf('@') > 0) out.add(replyKey(entry));
  }
  return out;
}

export function onNoReplyList(email, list) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return false;
  return [e, replyKey(e)].some(a => {
    const domain = a.split('@')[1] || '';
    return list.has(a) || list.has(domain) || list.has(`@${domain}`);
  });
}
