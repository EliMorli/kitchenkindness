// One mail sync run. All outside parts (store, Gmail, SMTP, Claude) are passed
// in, so tests can use fakes. Order of a run:
//   A. read new INBOX messages -> requests (one per Gmail conversation)
//   B. send due auto-replies (claim -> send -> record, never twice)
//   C. Claude summaries
//   D. Gmail labels (Pending / Approved / Declined, archive from the inbox)
//   E. send due approval emails
// Shadow mode runs A and C only: nothing is sent and Gmail isn't changed.

import { simpleParser } from 'mailparser';
import { DEFAULT_TEMPLATES, LABELS, LIMITS } from './config.js';
import {
  authPass, automatedReason, cleanBody, firstAddress, onNoReplyList, parseNoReplyList, suppressesAutoReply
} from './filters.js';
import { firstName, formatDays, newMessageId, render, replySubject, threadHeaders } from './templates.js';
import { sanitizeAiFields } from './fields.js';
import { UNDECIDED } from './store.js';
import { classifySmtpError, describeSmtpError } from './smtp.js';
import { describeImapError } from './gmail.js';

const DAY_MS = 86_400_000;

// Where a request's conversation should sit in Gmail.
export function labelTarget(r) {
  const decided = r.status === 'approved' || r.status === 'declined';
  const label =
    r.status === 'approved' ? 'approved'
      : r.status === 'declined' ? 'declined'
        : r.status === 'pending' && r.kind === 'request' ? 'pending'
          : 'none';
  return { label, inInbox: label === 'none' || !!r.needs_attention, seen: decided && !r.needs_attention };
}

const SEND = {
  auto_reply: { sentAt: 'auto_replied_at', tag: 'ack', auto: true },
  approval_email: { sentAt: 'approval_email_sent_at', tag: 'ok', auto: false }
};

const later = (a, b) => (new Date(a) > new Date(b) ? a : b);
const shortAddress = fam => (fam ? `${fam.address || ''}${fam.unit ? ` #${fam.unit}` : ''}`.trim() : '');

export async function runSync({
  store, gmail, smtp, ai, selfEmail = '', now = () => new Date(),
  deadlineMs = LIMITS.runDeadlineMs, holder = `run-${Math.random().toString(36).slice(2)}`
}) {
  const startedAt = now().getTime();
  const timeLeft = () => deadlineMs - (now().getTime() - startedAt);
  const iso = () => now().toISOString();

  const settings = await store.getSettings();
  if (!settings) throw new Error('mail_settings row missing');
  const mode = settings.mode;
  const report = {
    mode, read: 0, newRequests: 0, followUps: 0, automated: 0, more: false,
    replies: { sent: 0, failed: 0, unknown: 0 }, approvals: { sent: 0, failed: 0, unknown: 0 },
    ai: { done: 0, failed: 0, skipped: '' }, labels: { applied: 0, missing: 0 }, errors: []
  };
  if (mode === 'off') return { ...report, skipped: 'off' };
  if (!(await store.tryLock(holder, LIMITS.lockSeconds))) return { ...report, locked: true };

  const live = mode === 'live';
  const noReplyList = parseNoReplyList(settings.no_reply_senders);
  let imapOk = false;
  let smtpBlocked = false;
  let fatal = '';

  // ---------- A. read ----------
  const autoReplyDecision = async ({ parsed, replyAddress, received, authOk, dueThisRun }) => {
    if (!live) return { status: 'skipped', note: 'Shadow mode' };
    if (!settings.auto_reply_enabled) return { status: 'not_needed', note: 'Auto-reply is off' };
    if (settings.auto_reply_since && new Date(received) < new Date(settings.auto_reply_since)) {
      return { status: 'not_needed', note: 'Arrived before auto-replies were turned on' };
    }
    if (!replyAddress) return { status: 'not_needed', note: 'No reply address' };
    if (!authOk) return { status: 'not_needed', note: 'Sender not verified by Gmail (no auto-reply)' };
    if (suppressesAutoReply(parsed)) return { status: 'not_needed', note: 'Sender asked for no automatic replies' };
    if (onNoReplyList(replyAddress, noReplyList)) return { status: 'not_needed', note: 'On the never-auto-reply list' };
    if (dueThisRun.has(replyAddress)) return { status: 'not_needed', note: 'Already replying to this sender' };
    const since = new Date(now().getTime() - LIMITS.replyCooldownDays * DAY_MS).toISOString();
    if (await store.repliedRecently(replyAddress, since)) {
      return { status: 'not_needed', note: 'Auto-replied to this sender in the last 7 days' };
    }
    dueThisRun.add(replyAddress);
    return { status: settings.auto_reply_scope === 'requests' ? 'wait_ai' : 'due', note: '' };
  };

  async function ingest(m, dueThisRun) {
    const parsed = await simpleParser(m.source, { skipImageLinks: true, skipTextLinks: true, skipTextToHtml: true });
    const from = firstAddress(parsed.from);
    const replyTo = firstAddress(parsed.replyTo);
    const reason = automatedReason(parsed, selfEmail);
    const received = m.internalDate.toISOString();
    const refs = Array.isArray(parsed.references) ? parsed.references.join(' ') : parsed.references || '';
    const base = {
      gmail_msgid: m.emailId,
      gmail_thrid: m.threadId,
      inbox_uid: m.uid,
      message_id_header: parsed.messageId || '',
      in_reply_to: parsed.inReplyTo || '',
      references_header: refs.slice(0, 4000),
      from_name: from.name.slice(0, 200),
      from_email: from.email.slice(0, 320),
      reply_to_email: replyTo.email.slice(0, 320),
      subject: String(parsed.subject || '').slice(0, 300),
      received_at: received,
      auth_pass: authPass(parsed),
      attachment_count: (parsed.attachments || []).length
    };
    if (reason) {
      await store.insertMessage({ ...base, automated_reason: reason, body_text: '' });
      report.automated += 1;
      return;
    }
    let req = await store.requestByThread(m.threadId);
    if (!req) {
      const replyAddress = (replyTo.email || from.email).toLowerCase();
      const auto = await autoReplyDecision({ parsed, replyAddress, received, authOk: base.auth_pass, dueThisRun });
      req = await store.insertRequest({
        gmail_thrid: m.threadId,
        status: 'new',
        kind: 'unknown',
        from_name: base.from_name,
        from_email: base.from_email,
        reply_address: replyAddress,
        subject: base.subject,
        first_message_at: received,
        last_message_at: received,
        message_count: 1,
        ai_status: 'due',
        auto_reply_status: auto.status,
        auto_reply_error: auto.note,
        gmail_dirty: true
      });
      report.newRequests += 1;
    } else {
      const decided = req.status === 'approved' || req.status === 'declined';
      const patch = {
        last_message_at: later(req.last_message_at, received),
        message_count: (req.message_count || 1) + 1,
        // The new message sits in the inbox without our label until relabelled.
        gmail_in_inbox: true,
        gmail_dirty: true
      };
      if (decided) patch.needs_attention = true;
      else Object.assign(patch, { ai_status: 'due', ai_attempts: 0 });
      await store.updateRequest(req.id, patch);
      report.followUps += 1;
    }
    await store.insertMessage({ ...base, request_id: req.id, automated_reason: '', body_text: cleanBody(parsed.text || '') });
  }

  async function phaseRead() {
    const storedLastUid = settings.inbox_last_uid == null ? null : Number(settings.inbox_last_uid);
    const since = new Date(now().getTime() - LIMITS.firstRunDays * DAY_MS);
    const res = await gmail.readInbox({ storedValidity: settings.inbox_uidvalidity, storedLastUid, since });
    const known = await store.knownMessageIds(res.messages.map(m => m.emailId));
    const dueThisRun = new Set();
    let lastOk = null;
    let complete = true;
    for (const m of res.messages) {
      try {
        if (!known.has(m.emailId)) {
          await ingest(m, dueThisRun);
          report.read += 1;
        }
        lastOk = m.uid;
      } catch (err) {
        complete = false;
        report.errors.push('Could not save an incoming email; it will be retried.');
        break;
      }
    }
    const sameValidity = settings.inbox_uidvalidity === res.validity;
    const cursor = complete ? res.lastUid : lastOk ?? (sameValidity ? storedLastUid : null);
    await store.updateSettings({ inbox_uidvalidity: res.validity, inbox_last_uid: cursor });
    report.more = res.more || !complete;
  }

  // ---------- B / E. sending ----------
  async function sendOne(r, prefix) {
    const cfg = SEND[prefix];
    const messageId = newMessageId(cfg.tag, r.id);
    const claimed = await store.updateRequest(
      r.id,
      {
        [`${prefix}_status`]: 'claimed',
        [`${prefix}_claimed_at`]: iso(),
        [`${prefix}_message_id`]: messageId,
        [`${prefix}_attempts`]: (r[`${prefix}_attempts`] || 0) + 1
      },
      { eq: { [`${prefix}_status`]: 'due' } }
    );
    if (!claimed) return;
    const msgs = await store.messagesFor(r.id);
    const parent = [...msgs].reverse().find(m => m.message_id_header) || msgs[msgs.length - 1] || null;
    const name = firstName(r.from_name);
    const text =
      prefix === 'auto_reply'
        ? render(settings.auto_reply_body || DEFAULT_TEMPLATES.auto_reply_body, { name })
        : render(settings.approval_body || DEFAULT_TEMPLATES.approval_body, {
            name,
            address: shortAddress(r.approved_family),
            days: formatDays(r.approved_family?.delivery_days),
            family_id: r.family_id ?? ''
          });
    const tally = prefix === 'auto_reply' ? report.replies : report.approvals;
    try {
      await smtp.send({
        to: r.reply_address,
        subject: replySubject(parent?.subject || r.subject),
        text,
        ...threadHeaders(parent),
        messageId,
        auto: cfg.auto
      });
      await store.updateRequest(
        r.id,
        { [`${prefix}_status`]: 'sent', [cfg.sentAt]: iso(), [`${prefix}_error`]: '' },
        { eq: { [`${prefix}_status`]: 'claimed' } }
      );
      tally.sent += 1;
    } catch (err) {
      const definite = classifySmtpError(err) === 'definite';
      const attempts = claimed[`${prefix}_attempts`] || 1;
      const status = !definite ? 'unknown' : attempts >= LIMITS.sendAttempts ? 'failed' : 'due';
      await store.updateRequest(
        r.id,
        { [`${prefix}_status`]: status, [`${prefix}_error`]: describeSmtpError(err) },
        { eq: { [`${prefix}_status`]: 'claimed' } }
      );
      if (status === 'unknown') tally.unknown += 1;
      else tally.failed += 1;
      if (err?.code === 'EAUTH') {
        smtpBlocked = true;
        report.errors.push(describeSmtpError(err));
      }
    }
  }

  // A claim older than 10 minutes means a run died mid-send: look for the
  // email in Sent Mail. Found -> sent; otherwise "unknown" (admin decides).
  async function reconcileClaims(prefix) {
    const before = new Date(now().getTime() - LIMITS.staleClaimMinutes * 60_000).toISOString();
    for (const r of await store.listStaleClaims(prefix, before)) {
      let found = null;
      try {
        found = await gmail.sentHasMessageId(r[`${prefix}_message_id`]);
      } catch {
        found = null;
      }
      if (found === null) continue;
      await store.updateRequest(
        r.id,
        found
          ? { [`${prefix}_status`]: 'sent', [SEND[prefix].sentAt]: r[`${prefix}_claimed_at`], [`${prefix}_error`]: '' }
          : { [`${prefix}_status`]: 'unknown', [`${prefix}_error`]: 'Not sure this email went out. Check Sent Mail.' },
        { eq: { [`${prefix}_status`]: 'claimed' } }
      );
    }
  }

  async function phaseSend(prefix) {
    if (imapOk) await reconcileClaims(prefix);
    for (const r of await store.listByField(`${prefix}_status`, 'due', { limit: LIMITS.sendsPerRun })) {
      if (smtpBlocked || timeLeft() < 8000) break;
      await sendOne(r, prefix);
    }
  }

  // ---------- C. Claude ----------
  async function summarize(r) {
    const msgs = (await store.messagesFor(r.id)).filter(m => !m.automated_reason);
    try {
      const out = await ai(
        msgs.map(m => ({
          from_name: m.from_name, from_email: m.from_email, received_at: m.received_at, subject: m.subject, body_text: m.body_text
        }))
      );
      const fields = sanitizeAiFields(out.fields, { fromName: r.from_name });
      let { status, kind } = r;
      if (status === 'new' || kind !== 'request') {
        kind = fields.kind;
        status = fields.kind === 'request' ? 'pending' : 'other';
      }
      const patch = {
        kind, status, ai_summary: fields.summary, ai_fields: fields, ai_model: out.model || '',
        ai_status: 'done', ai_error: '', ai_at: iso(), gmail_dirty: true
      };
      if (r.auto_reply_status === 'wait_ai') patch.auto_reply_status = kind === 'request' ? 'due' : 'not_needed';
      await store.updateRequest(r.id, patch, { in: { status: UNDECIDED } });
      report.ai.done += 1;
    } catch (err) {
      const attempts = (r.ai_attempts || 0) + 1;
      const patch = { ai_attempts: attempts, ai_error: String(err?.message || 'Summary failed').slice(0, 200) };
      if (attempts >= LIMITS.aiAttempts) {
        patch.ai_status = 'failed';
        if (r.status === 'new') patch.status = 'pending';
        if (r.auto_reply_status === 'wait_ai') patch.auto_reply_status = 'due';
        patch.gmail_dirty = true;
      }
      await store.updateRequest(r.id, patch, { in: { status: UNDECIDED } });
      report.ai.failed += 1;
    }
  }

  async function phaseAi() {
    if (!ai) {
      report.ai.skipped = 'No Claude API key';
      return;
    }
    const due = await store.listAiDue(LIMITS.aiPerRun);
    let next = 0;
    const worker = async () => {
      while (next < due.length && timeLeft() > 20_000) await summarize(due[next++]);
    };
    await Promise.all(Array.from({ length: LIMITS.aiConcurrency }, worker));
    if (next < due.length) report.more = true;
  }

  // ---------- D. labels ----------
  async function phaseLabels() {
    if (!settings.labels_ready) {
      await gmail.ensureLabels();
      await store.updateSettings({ labels_ready: true });
    }
    for (const r of await store.listDirty(LIMITS.labelsPerRun)) {
      if (timeLeft() < 5000) {
        report.more = true;
        break;
      }
      const t = labelTarget(r);
      const add = [];
      const remove = Object.entries(LABELS).filter(([k]) => k !== t.label).map(([, v]) => v);
      if (t.label !== 'none') add.push(LABELS[t.label]);
      if (!t.inInbox) remove.push('\\Inbox');
      else if (!r.gmail_in_inbox) add.push('\\Inbox');
      const seen = t.seen && !r.gmail_seen;
      let found = true;
      if (add.length || seen || r.gmail_label !== 'none' || !t.inInbox) {
        ({ found } = await gmail.setThreadState(r.gmail_thrid, { add, remove, seen }));
      }
      await store.updateRequest(
        r.id,
        found
          ? { gmail_label: t.label, gmail_in_inbox: t.inInbox, gmail_seen: r.gmail_seen || t.seen, gmail_dirty: false, gmail_error: '' }
          : { gmail_dirty: false, gmail_error: 'This conversation was not found in Gmail (deleted?).' },
        { eq: { status: r.status, kind: r.kind, needs_attention: r.needs_attention } }
      );
      if (found) report.labels.applied += 1;
      else report.labels.missing += 1;
    }
  }

  try {
    try {
      await gmail.connect();
      imapOk = true;
    } catch (err) {
      fatal = describeImapError(err);
      report.errors.push(fatal);
    }
    if (imapOk) {
      try {
        await phaseRead();
      } catch (err) {
        fatal = describeImapError(err);
        report.errors.push(fatal);
        imapOk = false;
      }
    }
    if (live) await phaseSend('auto_reply');
    await phaseAi();
    // Replies that waited for Claude ("requests only" scope) go out this run too.
    if (live && settings.auto_reply_scope === 'requests') await phaseSend('auto_reply');
    if (live && imapOk) {
      try {
        await phaseLabels();
      } catch (err) {
        report.errors.push(describeImapError(err));
      }
    }
    if (live) await phaseSend('approval_email');
  } finally {
    try {
      await gmail.close();
    } catch {
      // ignore
    }
    try {
      smtp?.close?.();
    } catch {
      // ignore
    }
    const done = iso();
    await store.updateSettings({
      last_sync_at: done,
      ...(fatal ? {} : { last_sync_ok_at: done }),
      last_sync_error: report.errors[0] || ''
    });
    await store.releaseLock(holder);
  }
  return report;
}
