// Gmail over IMAP (imapflow) with an app password. Server only.
//
// - Reads new INBOX messages without marking them read (BODY.PEEK).
// - Gmail message/thread ids (X-GM-MSGID / X-GM-THRID) are kept as strings:
//   they are 64-bit and don't fit in a JS number.
// - Labels are set per conversation in "All Mail" with X-GM-LABELS, so
//   follow-ups and our own replies are covered too. Removing \Inbox archives.
// - Never runs IMAP commands inside a fetch loop (imapflow deadlocks); uses
//   fetchAll. Logging is off so no personal data reaches the server logs.

import { ImapFlow } from 'imapflow';
import { LABEL_ROOT, LABELS, LIMITS } from './config.js';

// Which INBOX UIDs to read, given the saved cursor. Pure, for tests.
// IMAP "N:*" always returns the newest message even when N is past the end,
// so results are filtered to UIDs above the cursor.
export function planUidRead({ storedValidity, storedLastUid, validity, uidNext }) {
  const cursor = storedValidity === validity && Number.isInteger(storedLastUid) ? storedLastUid : null;
  if (cursor === null) return { mode: 'since', cursor: null };
  if (uidNext - 1 <= cursor) return { mode: 'none', cursor };
  return { mode: 'range', cursor, range: `${cursor + 1}:*` };
}

export function createGmail({ user, pass }) {
  let client = null;
  let allMailPath = '[Gmail]/All Mail';

  const gmail = {
    async connect() {
      client = new ImapFlow({
        host: 'imap.gmail.com',
        port: 993,
        secure: true,
        auth: { user, pass: String(pass || '').replace(/\s+/g, '') },
        logger: false,
        emitLogs: false,
        connectionTimeout: 15_000,
        greetingTimeout: 10_000,
        socketTimeout: 40_000
      });
      client.on('error', () => {}); // a dropped socket must not crash the function
      await client.connect();
      const list = await client.list();
      const all = list.find(m => m.specialUse === '\\All');
      if (all) allMailPath = all.path;
    },

    async close() {
      if (!client) return;
      try {
        await client.logout();
      } catch {
        client.close();
      }
      client = null;
    },

    // Returns { validity, messages: [{uid, emailId, threadId, internalDate, source}], lastUid, more }
    async readInbox({ storedValidity, storedLastUid, since, limit = LIMITS.messagesPerRun }) {
      const lock = await client.getMailboxLock('INBOX', { readOnly: true });
      try {
        const mb = client.mailbox;
        const validity = String(mb.uidValidity);
        const plan = planUidRead({ storedValidity, storedLastUid, validity, uidNext: mb.uidNext });
        let uids = [];
        if (plan.mode === 'since') uids = (await client.search({ since }, { uid: true })) || [];
        else if (plan.mode === 'range') {
          uids = ((await client.search({ uid: plan.range }, { uid: true })) || []).filter(u => u > plan.cursor);
        }
        uids.sort((a, b) => a - b);
        const batch = uids.slice(0, limit);
        const fetched = batch.length
          ? await client.fetchAll(
              batch,
              { uid: true, internalDate: true, threadId: true, source: { maxLength: LIMITS.sourceBytes } },
              { uid: true }
            )
          : [];
        const messages = fetched
          .filter(m => m.emailId && m.threadId)
          .map(m => ({
            uid: m.uid,
            emailId: String(m.emailId),
            threadId: String(m.threadId),
            internalDate: m.internalDate ? new Date(m.internalDate) : new Date(),
            source: m.source
          }));
        const lastUid = batch.length ? batch[batch.length - 1] : plan.cursor ?? Math.max(0, mb.uidNext - 1);
        return { validity, messages, lastUid, more: uids.length > batch.length };
      } finally {
        lock.release();
      }
    },

    async ensureLabels() {
      const existing = new Set((await client.list()).map(m => m.path));
      for (const path of [LABEL_ROOT, LABELS.pending, LABELS.approved, LABELS.declined]) {
        if (!existing.has(path)) await client.mailboxCreate(path);
      }
    },

    // change: { add: [labels], remove: [labels], seen: bool }. Labels may
    // include '\\Inbox'. Returns { found }.
    async setThreadState(threadId, { add = [], remove = [], seen = false }) {
      const lock = await client.getMailboxLock(allMailPath);
      try {
        const uids = (await client.search({ threadId }, { uid: true })) || [];
        if (!uids.length) return { found: false };
        if (add.length) await client.messageFlagsAdd(uids, add, { uid: true, useLabels: true });
        if (remove.length) await client.messageFlagsRemove(uids, remove, { uid: true, useLabels: true });
        if (seen) await client.messageFlagsAdd(uids, ['\\Seen'], { uid: true });
        return { found: true };
      } finally {
        lock.release();
      }
    },

    // Did a message with this Message-ID reach Sent Mail? (stuck-send check)
    async sentHasMessageId(messageId) {
      const id = String(messageId || '').replace(/[<>\s]/g, '');
      if (!id) return false;
      const lock = await client.getMailboxLock(allMailPath, { readOnly: true });
      try {
        const uids = (await client.search({ gmraw: `rfc822msgid:${id}` }, { uid: true })) || [];
        return uids.length > 0;
      } finally {
        lock.release();
      }
    }
  };
  return gmail;
}

// A short, personal-data-free description of an IMAP failure.
export function describeImapError(err) {
  if (!err) return '';
  if (err.authenticationFailed || /AUTHENTICATIONFAILED|Invalid credentials/i.test(String(err.responseText || err.message))) {
    return 'Gmail login failed. Check GMAIL_USER and the app password.';
  }
  if (/web login required|WEBALERT/i.test(String(err.responseText || err.message))) {
    return 'Google blocked the sign-in. Open Gmail in a browser, confirm it was you, then try again.';
  }
  if (err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET' || err.code === 'ENOTFOUND') {
    return 'Could not reach Gmail (network). It will retry on the next check.';
  }
  return `Gmail error${err.code ? ` (${err.code})` : ''}.`;
}
