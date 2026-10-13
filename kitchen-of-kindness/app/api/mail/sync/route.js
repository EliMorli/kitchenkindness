// Runs one mail sync. Called every 5 minutes by Supabase pg_cron (Bearer
// MAIL_CRON_SECRET) and by the Mail tab (admin session).

import { isAdminRequest, adminConfigured, sameOrigin } from '../../../../lib/adminSession';
import { cronAuthorized, json, jsonError } from '../../../../lib/mail/api';
import { getMailAdapters, getMailStore, mailConfig } from '../../../../lib/mail/runtime';
import { runSync } from '../../../../lib/mail/sync';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(request) {
  if (!cronAuthorized(request)) {
    if (!adminConfigured()) return jsonError(503, 'not_configured', 'Admin login is not set up on the server yet.');
    if (!isAdminRequest(request)) return jsonError(401, 'unauthorized', 'Please log in again.');
    if (!sameOrigin(request)) return jsonError(403, 'forbidden', 'Request not allowed.');
  }
  const store = getMailStore();
  if (!store) return jsonError(503, 'no_db', 'The server database key is not set.');
  if (!mailConfig().hasGmail) return jsonError(503, 'no_gmail', 'Gmail is not connected yet (GMAIL_USER / GMAIL_APP_PASSWORD).');
  try {
    const report = await runSync({ store, ...getMailAdapters() });
    return json(report);
  } catch (err) {
    // No email content in logs: just the error type.
    console.error('mail sync failed:', err?.code || err?.name || 'error');
    return jsonError(500, 'sync_failed', 'The mail check failed. It will try again in a few minutes.');
  }
}
