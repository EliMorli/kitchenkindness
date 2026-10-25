// Mail settings for the admin: mode (off / shadow / live), auto-reply
// options, the two email templates, and a "send a test to myself" action.

import { adminStore, json, jsonError, syncStatus } from '../../../../lib/mail/api';
import { DEFAULT_TEMPLATES, TEMPLATE_HELP } from '../../../../lib/mail/config';
import { firstName, formatDays, render } from '../../../../lib/mail/templates';
import { getMailAdapters, mailConfig } from '../../../../lib/mail/runtime';
import { forgetAccessTokens } from '../../../../lib/mail/google';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PUBLIC_FIELDS = [
  'mode', 'auto_reply_enabled', 'auto_reply_scope', 'auto_reply_since', 'auto_reply_body', 'approval_body', 'no_reply_senders'
];
const pickPublic = s => Object.fromEntries(PUBLIC_FIELDS.map(k => [k, s?.[k] ?? null]));

export async function GET(request) {
  const { store, response } = adminStore(request);
  if (response) return response;
  const settings = await store.getSettings();
  return json({ settings: pickPublic(settings), defaults: DEFAULT_TEMPLATES, help: TEMPLATE_HELP, sync: syncStatus(settings) });
}

export async function PUT(request) {
  const { store, response } = adminStore(request);
  if (response) return response;
  let body = {};
  try {
    body = await request.json();
  } catch {
    return jsonError(400, 'bad_json', 'Bad request.');
  }
  const current = await store.getSettings();
  const patch = {};
  if (body.mode !== undefined) {
    if (!['off', 'shadow', 'live'].includes(body.mode)) return jsonError(400, 'bad_mode', 'Unknown mode.');
    patch.mode = body.mode;
    // Going live: only emails from now on get automatic replies.
    if (body.mode === 'live' && current?.mode !== 'live') patch.auto_reply_since = new Date().toISOString();
  }
  if (body.auto_reply_enabled !== undefined) patch.auto_reply_enabled = !!body.auto_reply_enabled;
  if (body.auto_reply_scope !== undefined) {
    if (!['all', 'requests'].includes(body.auto_reply_scope)) return jsonError(400, 'bad_scope', 'Unknown option.');
    patch.auto_reply_scope = body.auto_reply_scope;
  }
  for (const key of ['auto_reply_body', 'approval_body', 'no_reply_senders']) {
    if (body[key] !== undefined) patch[key] = String(body[key]).slice(0, 4000);
  }
  const updated = Object.keys(patch).length ? await store.updateSettings(patch) : current;
  return json({ ok: true, settings: pickPublic(updated), sync: syncStatus(updated) });
}

// { action: 'test_email', which: 'auto_reply' | 'approval' } -> sent only to the kitchen's own address.
export async function POST(request) {
  const { store, response } = adminStore(request);
  if (response) return response;
  const cfg = mailConfig();
  let body = {};
  try {
    body = await request.json();
  } catch {
    return jsonError(400, 'bad_json', 'Bad request.');
  }
  if (body.action !== 'test_email') return jsonError(400, 'bad_action', 'Unknown action.');
  const settings = await store.getSettings();
  const approval = body.which === 'approval';
  const text = approval
    ? render(settings?.approval_body || DEFAULT_TEMPLATES.approval_body, {
        name: firstName('Sample Person'),
        address: '12345 Sample St #7, Valley Village',
        days: formatDays(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday']),
        family_id: 999
      })
    : render(settings?.auto_reply_body || DEFAULT_TEMPLATES.auto_reply_body, { name: firstName('Sample Person') });
  const adapters = await getMailAdapters(store);
  if (adapters.error) return jsonError(503, 'no_gmail', adapters.error);
  const { smtp, user } = adapters;
  try {
    await smtp.send({
      to: user,
      subject: approval ? 'TEST: approval email' : 'TEST: automatic reply',
      text,
      auto: !approval
    });
    return json({ ok: true, to: user, dryRun: cfg.dryRun });
  } catch (err) {
    if (err?.code === 'EAUTH' || err?.code === 'EOAUTH2') forgetAccessTokens();
    return jsonError(502, 'send_failed', err?.code === 'EAUTH' || err?.code === 'EOAUTH2' ? 'Gmail refused the login. Connect Gmail again in Settings.' : 'Sending failed.');
  } finally {
    smtp.close?.();
  }
}
