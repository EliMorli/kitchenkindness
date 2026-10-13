// One mail sync run. All outside parts (store, Gmail, SMTP, Claude) are passed
// in, so tests can use fakes. Order of a run (slow Claude work goes last so it
// can never hold up replies, labels or approval emails):
//   A. read new INBOX messages -> requests (one per Gmail conversation)
//   B. send due auto-replies (claim -> send -> record, never twice)
//   D. Gmail labels (Pending / Approved / Declined, archive from the inbox)
//   E. send due approval emails
//   C. Claude summaries, then B and D again for what they changed
// Shadow mode runs A and C only. A dry run (MAIL_DRY_RUN) also skips B, D and
// E, and leaves every queued email and label change for the real sync.

import { simpleParser } from 'mailparser';
import { DEFAULT_TEMPLATES, LABELS, LIMITS } from './config.js';
import {
  authPass, automatedReason, bodyText, cleanBody, dbText, firstAddress, onNoReplyList, parseNoReplyList,
  replyKey, replyRecipient, suppressesAutoReply
} from './filters.js';
import { firstName, formatDays, newMessageId, render, replySubject, threadHeaders } from './templates.js';
import { sanitizeAiFields } from './fields.js';
import { UNDECIDED } from './store.js';
import { classifySmtpError, describeSmtpError } from './smtp.js';
import { describeImapError } from './gmail.js';

const DAY_MS = 86_400_000;
const MAX_AUTO_SUMMARIES = 8; // re-summarize follow-ups up to this many emails
const POISON_RETRIES = 3; // an email that can't be saved this many times is skipped

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
const refList = v => (Array.isArray(v) ? v : String(v || '').split(/\s+/)).map(s => s.trim()).filter(Boolean);

export async function runSync({
  store, gmail, smtp, ai, selfEmail = '', dryRun = false, now = () => new Date(),
  deadlineMs = LIMITS.runDeadlineMs, holder = `run-${Math.random().toString(36).slice(2)}`
}) {
  const startedAt = now().getTime();
  const timeLeft = () => deadlineMs - (now().getTime() - startedAt);
  const iso = () => now().toISOString();

  const settings = await store.getSettings();
  if (!settings) throw new Error('mail_settings row missing');
  const mode = settings.mode;
  const report = {
    mode, dryRun, read: 0, newRequests: 0, followUps: 0, automated: 0, skippedUnreadable: 0, more: false,
    replies: { sent: 0, failed: 0, unknown: 0 }, approvals: { sent: 0, failed: 0, unknown: 0 },
    ai: { done: 0, failed: 0, skipped: '' }, labels: { applied: 0, missing: 0 }, errors: []
  };
  if (mode === 'off') return { ...report, skipped: 'off' };
  if (!(await store.tryLock(holder, LIMITS.lockSeconds))) return { ...report, locked: true };

  const live = mode === 'live';
  const acting = live && !dryRun; // allowed to send email and change Gmail
  const noReplyList = parseNoReplyList(settings.no_reply_senders);
  let imapOk = false;
  let smtpBlocked = false;
  let fatal = '';
  let finished = false;

  const cooldownSince = () => new Date(now().getTime() - LIMITS.replyCooldownDays * DAY_MS).toISOString();

  // ---------- A. read ----------
  const autoReplyDecision = async ({ parsed, key, received, authOk, dueThisRun }) => {
    if (!live) return { status: 'skipped', note: 'Shadow mode' };
    if (!settings.auto_reply_enabled) return { status: 'not_needed', note: 'Auto-reply is off' };
    if (settings.auto_reply_since && new Date(received) < new Date(settings.auto_reply_since)) {
      return { status: 'not_needed', note: 'Arrived before auto-replies were turned on' };
    }
    if (!key) return { status: 'not_needed', note: 'No reply address' };
    if (!authOk) return { status: 'not_needed', note: 'Sender not verified by Gmail (no auto-reply)' };
    if (suppressesAutoReply(parsed)) return { status: 'not_needed', note: 'Sender asked for no automatic replies' };
    if (onNoReplyList(key, noReplyList)) return { status: 'not_needed', note: 'On the never-auto-reply list' };
    if (dueThisRun.has(key)) return { status: 'not_needed', note: 'Already replying to this sender' };
    if (await store.repliedRecently(key, cooldownSince())) {
      return { status: 'not_needed', note: 'Auto-replied to this sender in the last 7 days' };
    }
    dueThisRun.add(key);
    return { status: settings.auto_reply_scope === 'requests' ? 'wait_ai' : 'due', note: '' };
  };

  // Attach a new email to an existing request. The message row goes in first,
  // so a retried failure can never count the same email twice.
  async function addFollowUp(req, row, received) {
    const inserted = await store.insertMessage({ ...row, request_id: req.id });
    if (!inserted) return;
    const count = (req.message_count || 1) + 1;
    const decided = req.status === 'approved' || req.status === 'declined';
    const adminOther = req.status === 'other' && req.kind_set_by === 'admin';
    const patch = {
      last_message_at: later(req.last_message_at, received),
      message_count: count,
      // The new email sits in the inbox, unread, until relabelled.
      gmail_in_inbox: true,
      gmail_seen: false,
      gmail_dirty: true
    };
    if (decided || adminOther || count > MAX_AUTO_SUMMARIES) patch.needs_attention = true;
    else Object.assign(patch, { ai_status: 'due', ai_attempts: 0 });
    await store.updateRequest(req.id, patch);
    report.followUps += 1;
  }

  async function ingest(m, dueThisRun) {
    const parsed = await simpleParser(m.source, { skipImageLinks: true, skipTextLinks: true, skipTextToHtml: true });
    const from = firstAddress(parsed.from);
    const reason = automatedReason(parsed, selfEmail);
    const received = m.internalDate.toISOString();
    const refs = refList(parsed.references).map(r => dbText(r, 300));
    const inReplyTo = dbText(parsed.inReplyTo, 300);
    const row = {
      gmail_msgid: m.emailId,
      gmail_thrid: m.threadId,
      inbox_uid: m.uid,
      message_id_header: dbText(parsed.messageId, 300),
      in_reply_to: inReplyTo,
      references_header: dbText(refs.join(' '), 4000),
      from_name: from.name,
      from_email: from.email,
      reply_to_email: firstAddress(parsed.replyTo).email,
      subject: dbText(parsed.subject, 300),
      received_at: received,
      auth_pass: authPass(parsed),
      attachment_count: (parsed.attachments || []).length
    };
    if (reason) {
      await store.insertMessage({ ...row, automated_reason: reason, body_text: '' });
      report.automated += 1;
      return;
    }
    const message = { ...row, automated_reason: '', body_text: cleanBody(bodyText(parsed)) };
    let req = await store.requestByThread(m.threadId);
    // A reply Gmail filed as a new conversation still belongs to its request.
    if (!req) req = await store.requestForReplyIds([inReplyTo, ...refs]);
    if (req) {
      await addFollowUp(req, message, received);
      return;
    }
    const replyAddress = replyRecipient(parsed);
    const key = replyKey(replyAddress);
    const auto = await autoReplyDecision({ parsed, key, received, authOk: row.auth_pass, dueThisRun });
    req = await store.insertRequest({
      gmail_thrid: m.threadId,
      status: 'new',
      kind: 'unknown',
      from_name: row.from_name,
      from_email: row.from_email,
      reply_address: replyAddress,
      reply_key: key,
      subject: row.subject,
      first_message_at: received,
      last_message_at: received,
      message_count: 1,
      ai_status: 'due',
      auto_reply_status: auto.status,
      auto_reply_error: auto.note,
      gmail_dirty: true
    });
    await store.insertMessage({ ...message, request_id: req.id });
    report.newRequests += 1;
  }

  // An email that keeps failing to save (after POISON_RETRIES runs) is
  // recorded as unreadable and skipped, so it can't block the inbox.
  async function skipUnreadable(m) {
    let who = '';
    try {
      const parsed = await simpleParser(m.source);
      const f = firstAddress(parsed.from);
      who = f.email || f.name;
    } catch {
      // ignore
    }
    await store.insertMessage({
      gmail_msgid: m.emailId,
      gmail_thrid: m.threadId,
      inbox_uid: m.uid,
      from_email: dbText(who, 320),
      received_at: m.internalDate.toISOString(),
      automated_reason: 'unreadable',
      body_text: ''
    });
    report.skippedUnreadable += 1;
    report.errors.push(
      `One email${who ? ` from ${who}` : ''} (${m.internalDate.toDateString()}) couldn't be read and was skipped. It is still in Gmail.`
    );
  }

  async function phaseRead() {
    const storedLastUid = settings.inbox_last_uid == null ? null : Number(settings.inbox_last_uid);
    const since = new Date(now().getTime() - LIMITS.firstRunDays * DAY_MS);
    const res = await gmail.readInbox({ storedValidity: settings.inbox_uidvalidity, storedLastUid, since });
    const known = await store.knownMessageIds(res.messages.map(m => m.emailId));
    const dueThisRun = new Set();
    let lastOk = null;
    let complete = true;
    let fail = { uid: settings.inbox_fail_uid == null ? null : Number(settings.inbox_fail_uid), count: settings.inbox_fail_count || 0 };
    for (const m of res.messages) {
      if (timeLeft() < 15_000) {
        complete = false;
        break;
      }
      try {
        if (!known.has(m.emailId)) {
          await ingest(m, dueThisRun);
          report.read += 1;
        }
        lastOk = m.uid;
        if (fail.uid === m.uid) fail = { uid: null, count: 0 };
      } catch (err) {
        const count = fail.uid === m.uid ? fail.count + 1 : 1;
        fail = { uid: m.uid, count };
        if (count >= POISON_RETRIES) {
          try {
            await skipUnreadable(m);
            lastOk = m.uid;
            fail = { uid: null, count: 0 };
            continue;
          } catch {
            // the database itself is failing: stop and retry next run
          }
        }
        complete = false;
        report.errors.push('Could not save an incoming email; it will be retried.');
        break;
      }
    }
    const sameValidity = settings.inbox_uidvalidity === res.validity;
    const cursor = complete ? res.lastUid : lastOk ?? (sameValidity ? storedLastUid : null);
    await store.updateSettings({
      inbox_uidvalidity: res.validity,
      inbox_last_uid: cursor,
      inbox_fail_uid: fail.uid,
      inbox_fail_count: fail.count
    });
    report.more = res.more || !complete;
  }

  // ---------- B / E. sending ----------
  // Re-checked at send time: settings may have changed since the email
  // arrived, and another request from the same sender may have been answered.
  async function autoReplyBlocked(r) {
    if (r.auto_reply_forced) return '';
    if (!settings.auto_reply_enabled) return 'Auto-reply is off';
    if (onNoReplyList(r.reply_key || r.reply_address, noReplyList)) return 'On the never-auto-reply list';
    if (await store.repliedRecently(r.reply_key, cooldownSince(), r.id)) return 'Auto-replied to this sender in the last 7 days';
    return '';
  }

  async function sendOne(r, prefix) {
    const cfg = SEND[prefix];
    if (prefix === 'auto_reply') {
      const blocked = await autoReplyBlocked(r);
      if (blocked) {
        await store.updateRequest(r.id, { auto_reply_status: 'not_needed', auto_reply_error: blocked }, { eq: { auto_reply_status: 'due' } });
        return;
      }
    }
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
    const msgs = (await store.messagesFor(r.id)).filter(m => !m.automated_reason);
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
        subject: replySubject(parent?.subject ?? r.subject),
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
      if (classifySmtpError(err) === 'definite') {
        const attempts = claimed[`${prefix}_attempts`] || 1;
        const status = attempts >= LIMITS.sendAttempts ? 'failed' : 'due';
        await store.updateRequest(
          r.id,
          { [`${prefix}_status`]: status, [`${prefix}_error`]: describeSmtpError(err) },
          { eq: { [`${prefix}_status`]: 'claimed' } }
        );
        tally.failed += 1;
      } else {
        // It may have gone out: stay "claimed"; a later run checks Sent Mail
        // before trying again.
        await store.updateRequest(
          r.id,
          { [`${prefix}_error`]: 'Checking whether it went out…' },
          { eq: { [`${prefix}_status`]: 'claimed' } }
        );
        tally.unknown += 1;
      }
      if (err?.code === 'EAUTH') {
        smtpBlocked = true;
        report.errors.push(describeSmtpError(err));
      }
    }
  }

  // A claim older than 10 minutes: a send that may or may not have gone out.
  // Found in Sent Mail -> sent. Not there -> it didn't go out: try again
  // (up to the attempt limit), then leave it to the admin.
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
      const attempts = r[`${prefix}_attempts`] || 1;
      const patch = found
        ? { [`${prefix}_status`]: 'sent', [SEND[prefix].sentAt]: r[`${prefix}_claimed_at`], [`${prefix}_error`]: '' }
        : attempts < LIMITS.sendAttempts
          ? { [`${prefix}_status`]: 'due', [`${prefix}_error`]: 'Retrying: the last try did not go out.' }
          : { [`${prefix}_status`]: 'unknown', [`${prefix}_error`]: 'Could not confirm this email went out. Check Sent Mail.' };
      await store.updateRequest(r.id, patch, { eq: { [`${prefix}_status`]: 'claimed' } });
    }
  }

  async function phaseSend(prefix) {
    if (imapOk) await reconcileClaims(prefix);
    for (const r of await store.listByField(`${prefix}_status`, 'due', { limit: LIMITS.sendsPerRun })) {
      if (smtpBlocked || timeLeft() < 8000) {
        report.more = true;
        break;
      }
      await sendOne(r, prefix);
    }
  }

  // ---------- C. Claude ----------
  async function summarize(r) {
    // Count the attempt first: a run killed mid-call still uses one up.
    const attempts = (r.ai_attempts || 0) + 1;
    const marked = await store.updateRequest(r.id, { ai_attempts: attempts }, { eq: { ai_status: 'due' }, in: { status: UNDECIDED } });
    if (!marked) return;
    const fail = async message => {
      const patch = { ai_error: String(message || 'Summary failed').slice(0, 200) };
      if (attempts >= LIMITS.aiAttempts) {
        patch.ai_status = 'failed';
        if (r.status === 'new') patch.status = 'pending';
        if (r.auto_reply_status === 'wait_ai') patch.auto_reply_status = 'due';
        patch.gmail_dirty = true;
      }
      await store.updateRequest(r.id, patch, { in: { status: UNDECIDED } });
      report.ai.failed += 1;
    };
    const msgs = (await store.messagesFor(r.id)).filter(m => !m.automated_reason);
    if (!msgs.length) return fail('No email text was saved for this request.');
    const timeoutMs = Math.min(25_000, timeLeft() - 10_000);
    if (timeoutMs < 8_000) {
      await store.updateRequest(r.id, { ai_attempts: attempts - 1 }, { in: { status: UNDECIDED } });
      report.more = true;
      return;
    }
    let out;
    try {
      out = await ai(
        msgs.map(m => ({ from_name: m.from_name, from_email: m.from_email, received_at: m.received_at, subject: m.subject, body_text: m.body_text })),
        { timeoutMs }
      );
    } catch (err) {
      return fail(err?.message);
    }
    const fields = sanitizeAiFields(out.fields, { fromName: r.from_name });
    const summary = {
      ai_summary: fields.summary, ai_fields: fields, ai_model: dbText(out.model, 80), ai_status: 'done', ai_error: '', ai_at: iso(),
      gmail_dirty: true
    };
    let { status, kind } = r;
    if (r.kind_set_by !== 'admin' && (status === 'new' || kind !== 'request')) {
      kind = fields.kind;
      status = fields.kind === 'request' ? 'pending' : 'other';
    }
    const patch = { ...summary, kind, status };
    if (r.auto_reply_status === 'wait_ai') patch.auto_reply_status = kind === 'request' ? 'due' : 'not_needed';
    // Only if nobody changed it meanwhile; otherwise keep their choice and
    // just store the summary.
    const done = await store.updateRequest(r.id, patch, { eq: { status: r.status, kind: r.kind } });
    if (!done) await store.updateRequest(r.id, summary, { in: { status: UNDECIDED } });
    report.ai.done += 1;
  }

  async function phaseAi() {
    if (!ai) {
      report.ai.skipped = 'No Claude API key';
      return;
    }
    const due = await store.listAiDue(LIMITS.aiPerRun);
    let next = 0;
    const worker = async () => {
      while (next < due.length && timeLeft() > 18_000) await summarize(due[next++]);
    };
    await Promise.all(Array.from({ length: LIMITS.aiConcurrency }, worker));
    if (next < due.length) report.more = true;
  }

  // ---------- D. labels ----------
  async function phaseLabels() {
    if (!settings.labels_ready) {
      await gmail.ensureLabels();
      await store.updateSettings({ labels_ready: true });
      settings.labels_ready = true;
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

  const safely = async (fn, describe = describeImapError) => {
    try {
      await fn();
    } catch (err) {
      report.errors.push(describe(err));
    }
  };

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
    if (acting) {
      await phaseSend('auto_reply');
      if (imapOk) await safely(phaseLabels);
      await phaseSend('approval_email');
    }
    await phaseAi();
    if (acting) {
      // What Claude just sorted: requests leave the inbox; "requests only"
      // replies go out.
      if (settings.auto_reply_scope === 'requests') await phaseSend('auto_reply');
      if (imapOk) await safely(phaseLabels);
    }
    finished = true;
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
      ...(fatal || !finished ? {} : { last_sync_ok_at: done }),
      last_sync_error: report.errors[0] || (finished ? '' : 'The mail check stopped partway. It will try again.')
    });
    await store.releaseLock(holder);
  }
  return report;
}
