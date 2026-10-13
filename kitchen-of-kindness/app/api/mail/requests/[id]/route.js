// One request: GET it with its emails; POST an admin action.
//   approve   { family, sendEmail }  -> creates the family (one transaction)
//   decline                          -> filed, no email
//   reopen                           -> declined back to pending
//   reclassify { kind: 'request' | 'other' }
//   resend    { which: 'auto_reply' | 'approval_email' }  (failed / unknown only)
//   save_geo  { geo: { address, formatted_address, lat, lng, status } }
//   handled                          -> clears "needs attention"
//   summarize                        -> Claude reads the conversation again
// Gmail labels and emails follow on the next sync.
//
// Shadow mode and a dry-run server (MAIL_DRY_RUN, e.g. a developer's copy
// on the real database) only practise decisions: nothing is changed.

import { adminStore, json, jsonError, publicRequest } from '../../../../../lib/mail/api';
import { UNDECIDED } from '../../../../../lib/mail/store';
import { validateFamilyPayload } from '../../../../../lib/mail/fields';
import { mailConfig } from '../../../../../lib/mail/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function load(params) {
  const { id } = await params;
  const n = Number(id);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function GET(request, { params }) {
  const { store, response } = adminStore(request);
  if (response) return response;
  const id = await load(params);
  const r = id && (await store.getRequest(id));
  if (!r) return jsonError(404, 'not_found', 'Request not found.');
  return json({ request: publicRequest(r, await store.messagesFor(id)) });
}

const conflict = () => jsonError(409, 'changed', 'This request was already handled. Refresh the list.');

export async function POST(request, { params }) {
  const { store, response } = adminStore(request);
  if (response) return response;
  const id = await load(params);
  const r = id && (await store.getRequest(id));
  if (!r) return jsonError(404, 'not_found', 'Request not found.');
  let body = {};
  try {
    body = await request.json();
  } catch {
    return jsonError(400, 'bad_json', 'Bad request.');
  }
  const now = new Date().toISOString();
  const done = updated => (updated ? json({ ok: true, request: publicRequest(updated) }) : conflict());
  // Practice (shadow mode or a dry-run server): decisions are tried out but
  // nothing is changed.
  const settings = await store.getSettings();
  const shadow = settings?.mode === 'shadow';
  const dryRun = mailConfig().dryRun;
  const practice = shadow || dryRun ? { ok: true, shadow, dryRun: dryRun && !shadow } : null;
  const DECISIONS = ['approve', 'decline', 'reopen', 'reclassify', 'handled', 'resend'];
  // A "requests only" auto-reply still waiting for the summary is settled by
  // the admin's decision.
  const settleWaitAi = async (status, error) => {
    await store.updateRequest(id, { auto_reply_status: status, auto_reply_error: error }, { eq: { auto_reply_status: 'wait_ai' } });
  };

  if (practice && DECISIONS.includes(body.action) && body.action !== 'approve') return json(practice);

  switch (body.action) {
    case 'approve': {
      const names = [r.from_name, r.ai_fields?.requester_name].filter(Boolean);
      const v = validateFamilyPayload(body.family || {}, { names });
      if (!v.ok) return json({ error: 'invalid', errors: v.errors }, 400);
      if (practice) return json({ ...practice, family: v.family });
      // A family number clash (someone added a family by hand at the same
      // moment) is retried; a second tap on the same request returns the
      // same family.
      for (let attempt = 1; ; attempt += 1) {
        try {
          const familyId = await store.approve(id, v.family, body.sendEmail !== false);
          const updated = await store.getRequest(id);
          return json({ ok: true, family_id: familyId, request: publicRequest(updated) });
        } catch (err) {
          if (err.code === '23505' && attempt < 3) continue;
          if (/request_is_/.test(err.message)) return conflict();
          console.error('approve failed:', err.code || 'error');
          return jsonError(500, 'approve_failed', 'Could not add the family. Try again.');
        }
      }
    }
    case 'decline': {
      const updated = await store.updateRequest(
        id,
        {
          status: 'declined', kind: r.kind === 'unknown' ? 'request' : r.kind, kind_set_by: 'admin', decided_at: now,
          needs_attention: false, attention_note: '', gmail_dirty: true
        },
        { in: { status: UNDECIDED } }
      );
      if (updated) await settleWaitAi('not_needed', 'Declined');
      return done(updated);
    }
    case 'reopen':
      return done(
        await store.updateRequest(
          id,
          { status: 'pending', kind: 'request', kind_set_by: 'admin', decided_at: null, gmail_dirty: true },
          { eq: { status: 'declined' } }
        )
      );
    case 'reclassify': {
      const toRequest = body.kind === 'request';
      const updated = await store.updateRequest(
        id,
        toRequest
          ? { kind: 'request', kind_set_by: 'admin', status: 'pending', gmail_dirty: true }
          : { kind: 'other', kind_set_by: 'admin', status: 'other', gmail_dirty: true },
        { in: { status: UNDECIDED } }
      );
      if (updated) await settleWaitAi(toRequest ? 'due' : 'not_needed', toRequest ? '' : 'Not a request');
      return done(updated);
    }
    case 'resend': {
      const prefix = body.which === 'approval_email' ? 'approval_email' : 'auto_reply';
      if (!['failed', 'unknown'].includes(r[`${prefix}_status`])) return conflict();
      return done(
        await store.updateRequest(
          id,
          {
            [`${prefix}_status`]: 'due',
            [`${prefix}_attempts`]: 0,
            [`${prefix}_error`]: '',
            ...(prefix === 'auto_reply' ? { auto_reply_forced: true } : {})
          },
          { in: { [`${prefix}_status`]: ['failed', 'unknown'] } }
        )
      );
    }
    case 'save_geo': {
      const g = body.geo || {};
      const lat = Number(g.lat);
      const lng = Number(g.lng);
      const ok = g.status === 'found' && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
      const geo = {
        address: String(g.address || '').slice(0, 200),
        status: ok ? 'found' : 'not_found',
        formatted_address: ok ? String(g.formatted_address || '').slice(0, 200) : '',
        lat: ok ? lat : null,
        lng: ok ? lng : null,
        at: now
      };
      return done(await store.updateRequest(id, { geo }));
    }
    case 'handled':
      return done(await store.updateRequest(id, { needs_attention: false, attention_note: '', gmail_dirty: true }));
    case 'summarize':
      // Costs one Claude call; only for requests not decided yet.
      return done(
        await store.updateRequest(
          id,
          { ai_status: 'due', ai_attempts: 0, ai_error: '', needs_attention: false, attention_note: '', gmail_dirty: true },
          { in: { status: UNDECIDED } }
        )
      );
    default:
      return jsonError(400, 'bad_action', 'Unknown action.');
  }
}
