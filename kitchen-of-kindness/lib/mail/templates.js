// Email text and threading helpers.

import { DAYS } from './config.js';

export function render(template, vars) {
  return String(template || '').replace(/\{(\w+)\}/g, (m, key) => (key in vars ? String(vars[key] ?? '') : m));
}

// "Re: <their subject>" so Gmail keeps the reply in the same conversation
// (Gmail also matches on subject). An empty subject stays empty: "Re:".
export function replySubject(subject) {
  const s = String(subject || '').replace(/\s+/g, ' ').trim();
  if (!s) return 'Re:';
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

const splitRefs = v =>
  (Array.isArray(v) ? v : String(v || '').split(/\s+/)).map(s => s.trim()).filter(Boolean);

// In-Reply-To / References for a reply to `parent` (a mail_messages row), so
// Gmail keeps it in the same conversation.
export function threadHeaders(parent) {
  const id = String(parent?.message_id_header || '').trim();
  if (!id) return {};
  const refs = [...splitRefs(parent.references_header), id];
  return { inReplyTo: id, references: [...new Set(refs)].slice(-20).join(' ') };
}

export function firstName(name) {
  const clean = String(name || '')
    .replace(/["'<>()]/g, ' ')
    .replace(/@.*/, '')
    .trim();
  const first = clean.split(/[\s,]+/)[0] || '';
  // Plain letters only (no dots), so a "name" can't look like a link.
  if (!/^[\p{L}][\p{L}'-]{0,30}$/u.test(first)) return 'there';
  return first.charAt(0).toUpperCase() + first.slice(1);
}

export function formatDays(days) {
  const list = DAYS.filter(d => (days || []).includes(d));
  if (list.length === DAYS.length) return 'Sunday through Thursday';
  if (list.length === 0) return 'our delivery days';
  if (list.length === 1) return list[0];
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

// Gmail's web link for a conversation (X-GM-THRID is decimal; the URL uses hex).
export function gmailThreadUrl(thrid, user) {
  try {
    const hex = BigInt(String(thrid)).toString(16);
    return `https://mail.google.com/mail/?authuser=${encodeURIComponent(user || '')}#all/${hex}`;
  } catch {
    return 'https://mail.google.com/mail/';
  }
}

export function newMessageId(kind, requestId) {
  const rand = Math.random().toString(36).slice(2, 10);
  return `<kok-${kind}-${requestId}-${Date.now().toString(36)}-${rand}@kitchenofkindness.app>`;
}
