// Shared bits for the /api/mail routes: auth, JSON helpers, and the shape of
// a request sent to the admin's browser (internal fields left out).

import { createHash, timingSafeEqual } from 'node:crypto';
import { requireAdmin, jsonError } from '../adminSession.js';
import { gmailThreadUrl } from './templates.js';
import { getMailStore, mailConfig } from './runtime.js';

export const noStore = { 'Cache-Control': 'no-store' };
export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...noStore } });
export { jsonError };

// The Supabase cron job authenticates with MAIL_CRON_SECRET.
export function cronAuthorized(request) {
  const secret = process.env.MAIL_CRON_SECRET;
  const header = request.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!secret || !token) return false;
  const a = createHash('sha256').update(token).digest();
  const b = createHash('sha256').update(secret).digest();
  return timingSafeEqual(a, b);
}

// Admin session required, and the mail database must be reachable.
// Returns { store } or { response }.
export function adminStore(request) {
  const denied = requireAdmin(request);
  if (denied) return { response: denied };
  const store = getMailStore();
  if (!store) return { response: jsonError(503, 'no_db', 'The server database key (SUPABASE_SERVICE_ROLE_KEY) is not set.') };
  return { store };
}

const MESSAGE_FIELDS = ['id', 'from_name', 'from_email', 'received_at', 'subject', 'body_text', 'attachment_count'];

export function publicRequest(r, messages = null) {
  const out = {
    id: r.id,
    status: r.status,
    kind: r.kind,
    from_name: r.from_name,
    from_email: r.from_email,
    reply_address: r.reply_address,
    subject: r.subject,
    first_message_at: r.first_message_at,
    last_message_at: r.last_message_at,
    message_count: r.message_count,
    needs_attention: r.needs_attention,
    ai_status: r.ai_status,
    ai_summary: r.ai_summary,
    ai_fields: r.ai_fields || {},
    ai_error: r.ai_status === 'failed' ? r.ai_error : '',
    ai_at: r.ai_at,
    geo: r.geo || null,
    auto_reply_status: r.auto_reply_status,
    auto_reply_error: r.auto_reply_error,
    auto_replied_at: r.auto_replied_at,
    family_id: r.family_id,
    approved_family: r.approved_family || null,
    decided_at: r.decided_at,
    approval_email_status: r.approval_email_status,
    approval_email_error: r.approval_email_error,
    approval_email_sent_at: r.approval_email_sent_at,
    gmail_error: r.gmail_error,
    gmail_url: gmailThreadUrl(r.gmail_thrid, mailConfig().user)
  };
  if (messages) {
    out.messages = messages
      .filter(m => !m.automated_reason)
      .map(m => Object.fromEntries(MESSAGE_FIELDS.map(k => [k, m[k]])));
  }
  return out;
}

export function syncStatus(settings) {
  const cfg = mailConfig();
  return {
    mode: settings?.mode || 'off',
    last_sync_at: settings?.last_sync_at || null,
    last_sync_ok_at: settings?.last_sync_ok_at || null,
    last_sync_error: settings?.last_sync_error || '',
    gmail_user: cfg.user,
    has_gmail: cfg.hasGmail,
    has_ai: cfg.hasAi,
    dry_run: cfg.dryRun,
    fake: cfg.fake
  };
}
