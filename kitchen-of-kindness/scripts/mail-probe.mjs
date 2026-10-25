// Checks how Gmail behaves with this app's IMAP/SMTP code, using a THROWAWAY
// test Gmail account (never the kitchen's inbox). It sends one email from the
// test account to itself, then checks thread ids, labels, archiving and the
// Sent copy. Usage:
//   PROBE_USER=test.account@gmail.com PROBE_PASS='app password' node scripts/mail-probe.mjs

import { ImapFlow } from 'imapflow';
import { createGmail } from '../lib/mail/gmail.js';
import { createSmtp } from '../lib/mail/smtp.js';
import { LABELS } from '../lib/mail/config.js';
import { newMessageId } from '../lib/mail/templates.js';

const user = process.env.PROBE_USER;
const pass = process.env.PROBE_PASS;
if (!user || !pass) {
  console.error('Set PROBE_USER and PROBE_PASS (a throwaway Gmail account + its app password).');
  process.exit(1);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const smtp = createSmtp({ user, pass });
const messageId = newMessageId('probe', 0);
await smtp.send({ to: user, subject: `Probe ${new Date().toISOString()}`, text: 'Probe message.', messageId });
console.log('sent', messageId);
await sleep(8000);

const gmail = createGmail({ user, pass });
await gmail.connect();
const res = await gmail.readInbox({ storedValidity: null, storedLastUid: null, since: new Date(Date.now() - 3600_000) });
const mine = res.messages.at(-1);
console.log('inbox validity', res.validity, 'messages', res.messages.length, 'latest', mine && { emailId: mine.emailId, threadId: mine.threadId });
console.log('sent copy found by Message-ID:', await gmail.sentHasMessageId(messageId));
await gmail.ensureLabels();
if (mine) {
  console.log('label + archive:', await gmail.setThreadState(mine.threadId, { add: [LABELS.pending], remove: ['\\Inbox'] }));
  const check = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user, pass: pass.replace(/\s+/g, '') }, logger: false });
  await check.connect();
  const lock = await check.getMailboxLock(LABELS.pending);
  console.log('messages now in', LABELS.pending, ':', (await check.search({ threadId: mine.threadId }, { uid: true })).length);
  lock.release();
  await check.logout();
  console.log('move back to inbox:', await gmail.setThreadState(mine.threadId, { add: ['\\Inbox'], remove: [LABELS.pending] }));
}
await gmail.close();
smtp.close();
