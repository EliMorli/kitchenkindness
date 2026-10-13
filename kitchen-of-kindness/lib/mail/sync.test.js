import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSync, labelTarget } from './sync.js';
import { createFakeWorld, SAMPLE_EMAILS } from './fakes.js';

const run = (w, extra = {}) =>
  runSync({ store: w.store, gmail: w.gmail, smtp: w.smtp, ai: w.ai, selfEmail: w.selfEmail, ...extra });
const rows = w => w.db.tables.mail_requests;
const byThread = (w, key) => rows(w).find(r => r.gmail_thrid === w.gmail.threadId(key));

test('first run: one reply per conversation, summaries, labels', async () => {
  const w = createFakeWorld();
  const r = await run(w);
  assert.equal(r.newRequests, 5);
  assert.equal(r.followUps, 1); // Rosa's second email
  assert.equal(r.automated, 1); // the store newsletter
  assert.equal(r.replies.sent, 5);
  assert.equal(w.smtp.outbox.length, 5);
  assert.equal(new Set(w.smtp.outbox.map(m => m.to)).size, 5);
  const rosaReply = w.smtp.outbox.find(m => m.to === 'rosa.delgado.example@gmail.com');
  assert.equal(rosaReply.subject, 'Re: Re: Comida para mi familia'.replace('Re: Re:', 'Re:'));
  assert.ok(rosaReply.inReplyTo && rosaReply.references.includes(rosaReply.inReplyTo));
  assert.ok(rosaReply.text.startsWith('Hi Rosa,'));
  assert.equal(rosaReply.auto, true);

  assert.equal(byThread(w, 't1').status, 'pending');
  assert.equal(byThread(w, 't1').message_count, 2);
  assert.equal(byThread(w, 't4').status, 'other');
  assert.equal(byThread(w, 't6').ai_fields.flags.includes('instructions_to_ai'), true);
  // Requests left the inbox into Pending; the volunteer email stayed in the inbox.
  const labelsOf = key => [...w.gmail.labels.get(w.gmail.threadId(key))];
  assert.ok(labelsOf('t2').includes('Kitchen Requests/Pending'));
  assert.ok(!labelsOf('t2').includes('\\Inbox'));
  assert.ok(labelsOf('t4').includes('\\Inbox'));
  assert.ok(labelsOf('t5').includes('\\Inbox'));
  assert.ok(!labelsOf('t5').includes('Kitchen Requests/Pending'));
  // Nothing is left marked to fix.
  assert.ok(rows(w).every(x => !x.gmail_dirty));
});

test('a second run does nothing new (no repeat replies or summaries)', async () => {
  const w = createFakeWorld();
  await run(w);
  const calls = w.ai.calls;
  const r = await run(w);
  assert.equal(r.read, 0);
  assert.equal(w.smtp.outbox.length, 5);
  assert.equal(w.ai.calls, calls);
});

test('approval: family created once, approval email threaded, labels move', async () => {
  const w = createFakeWorld();
  await run(w);
  const req = byThread(w, 't2');
  const fam = { address: '14520 Burbank Blvd, Sherman Oaks, CA 91403', unit: '', contact: '818-555-0199', people_count: 1,
    delivery_days: ['Monday', 'Wednesday', 'Thursday'], instructions: 'Hand to resident', notes: 'Diabetic', latitude: null, longitude: null };
  const id1 = await w.store.approve(req.id, fam, true);
  const id2 = await w.store.approve(req.id, fam, true); // double tap
  assert.equal(id1, id2);
  assert.equal(w.db.tables.families.length, 1);
  const r = await run(w);
  assert.equal(r.approvals.sent, 1);
  const mail = w.smtp.outbox.at(-1);
  assert.equal(mail.to, 'dana.weiss@example-clinic.org');
  assert.match(mail.text, /14520 Burbank Blvd/);
  assert.match(mail.text, /Monday, Wednesday and Thursday/);
  assert.equal(mail.auto, false);
  const labels = [...w.gmail.labels.get(req.gmail_thrid)];
  assert.ok(labels.includes('Kitchen Requests/Approved'));
  assert.ok(!labels.includes('Kitchen Requests/Pending'));
  assert.ok(w.gmail.seenThreads.has(req.gmail_thrid));
  // A later email in that conversation needs attention and goes back to the inbox, no auto-reply.
  w.gmail.deliver({ thread: 't2', from: '"Dana Weiss, LCSW" <dana.weiss@example-clinic.org>', subject: 'Re: Referral', body: 'He moved.', replyTo: 0 });
  const sentBefore = w.smtp.outbox.length;
  await run(w);
  const after = byThread(w, 't2');
  assert.equal(after.needs_attention, true);
  assert.equal(after.status, 'approved');
  assert.equal(w.smtp.outbox.length, sentBefore);
  assert.ok(w.gmail.labels.get(req.gmail_thrid).has('\\Inbox'));
});

test('no auto-reply: unverified sender, repeat sender, backlog, never-reply list', async () => {
  const w = createFakeWorld({ emails: [] });
  w.gmail.deliver({ thread: 'u1', from: 'Spoof <boss@bank.example>', subject: 'Help', body: 'food please', verified: false });
  w.gmail.deliver({ thread: 'u2', from: 'Ana <ana@example.com>', subject: 'Food', body: 'food please' });
  w.gmail.deliver({ thread: 'u3', from: 'Ana <ana@example.com>', subject: 'Food again', body: 'food please' });
  w.gmail.deliver({ thread: 'u4', from: 'Old <old@example.com>', subject: 'Old', body: 'food please', minutesAgo: 60 * 24 * 6 });
  w.gmail.deliver({ thread: 'u5', from: 'Partner <p@partner.example>', subject: 'Hi', body: 'hello' });
  await w.store.updateSettings({ auto_reply_since: new Date(Date.now() - 86_400_000).toISOString(), no_reply_senders: '@partner.example' });
  await run(w);
  const st = key => byThread(w, key).auto_reply_status;
  assert.equal(st('u1'), 'not_needed');
  assert.equal(st('u2'), 'sent');
  assert.equal(st('u3'), 'not_needed');
  assert.equal(st('u4'), 'not_needed');
  assert.equal(st('u5'), 'not_needed');
  assert.equal(w.smtp.outbox.length, 1);
  // The same sender in a later run is still within 7 days.
  w.gmail.deliver({ thread: 'u6', from: 'Ana <ana@example.com>', subject: 'Third', body: 'food please' });
  await run(w);
  assert.equal(st('u6'), 'not_needed');
});

test('sending failures: clear failures retry then stop; unclear ones never resend', async () => {
  const w = createFakeWorld({ emails: [] });
  w.gmail.deliver({ thread: 'a', from: 'A <a@example.com>', subject: 'A', body: 'food please' });
  w.smtp.fail = Object.assign(new Error('auth'), { code: 'EAUTH' });
  await run(w);
  assert.equal(byThread(w, 'a').auto_reply_status, 'due');
  await run(w);
  await run(w);
  assert.equal(byThread(w, 'a').auto_reply_status, 'failed');
  assert.equal(byThread(w, 'a').auto_reply_attempts, 3);

  const w2 = createFakeWorld({ emails: [] });
  w2.gmail.deliver({ thread: 'b', from: 'B <b@example.com>', subject: 'B', body: 'food please' });
  w2.smtp.fail = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
  await run(w2);
  assert.equal(byThread(w2, 'b').auto_reply_status, 'unknown');
  w2.smtp.fail = null;
  await run(w2);
  assert.equal(w2.smtp.outbox.length, 0);
});

test('a run that died mid-send is reconciled from Sent Mail, never sent twice', async () => {
  const w = createFakeWorld({ emails: [] });
  w.gmail.deliver({ thread: 'c', from: 'C <c@example.com>', subject: 'C', body: 'food please' });
  w.gmail.deliver({ thread: 'd', from: 'D <d@example.com>', subject: 'D', body: 'food please' });
  await w.store.updateSettings({ mode: 'shadow' });
  await run(w); // creates the requests without replying
  const old = new Date(Date.now() - 11 * 60_000).toISOString();
  const c = byThread(w, 'c');
  const d = byThread(w, 'd');
  await w.store.updateRequest(c.id, { auto_reply_status: 'claimed', auto_reply_claimed_at: old, auto_reply_message_id: '<sent@x>' });
  await w.store.updateRequest(d.id, { auto_reply_status: 'claimed', auto_reply_claimed_at: old, auto_reply_message_id: '<lost@x>' });
  w.gmail.sent.push({ messageId: '<sent@x>' });
  await w.store.updateSettings({ mode: 'live' });
  await run(w);
  assert.equal(byThread(w, 'c').auto_reply_status, 'sent');
  assert.equal(byThread(w, 'd').auto_reply_status, 'unknown');
  assert.equal(w.smtp.outbox.length, 0);
});

test('lock: a second run while one is going does nothing', async () => {
  const w = createFakeWorld();
  assert.equal(await w.store.tryLock('other-run', 75), true);
  const r = await run(w);
  assert.equal(r.locked, true);
  assert.equal(w.smtp.outbox.length, 0);
});

test('an admin decision made while Claude is working wins', async () => {
  const w = createFakeWorld({ emails: [] });
  w.gmail.deliver({ thread: 'e', from: 'E <e@example.com>', subject: 'E', body: 'food please' });
  const realAi = w.ai;
  w.ai = async msgs => {
    const req = byThread(w, 'e');
    await w.store.updateRequest(req.id, { status: 'declined', decided_at: new Date().toISOString(), gmail_dirty: true });
    return realAi(msgs);
  };
  await run(w);
  assert.equal(byThread(w, 'e').status, 'declined');
});

test('shadow mode reads and summarizes but sends and labels nothing', async () => {
  const w = createFakeWorld({ mode: 'shadow' });
  const r = await run(w);
  assert.equal(r.newRequests, 5);
  assert.equal(w.smtp.outbox.length, 0);
  assert.ok(rows(w).every(x => x.auto_reply_status === 'skipped'));
  assert.ok(rows(w).filter(x => x.status === 'pending').length >= 4);
  assert.ok(![...w.gmail.labels.values()].some(s => [...s].some(l => l.startsWith('Kitchen'))));
});

test('mode off: nothing happens', async () => {
  const w = createFakeWorld({ mode: 'off' });
  const r = await run(w);
  assert.equal(r.skipped, 'off');
  assert.equal(rows(w).length, 0);
});

test('changed UIDVALIDITY re-reads without duplicates', async () => {
  const w = createFakeWorld();
  await run(w);
  const count = rows(w).length;
  const msgs = w.db.tables.mail_messages.length;
  w.gmail.state.uidValidity = '9999';
  await run(w);
  assert.equal(rows(w).length, count);
  assert.equal(w.db.tables.mail_messages.length, msgs);
  assert.equal(w.smtp.outbox.length, 5);
});

test('reply scope "requests": non-requests get no reply', async () => {
  const w = createFakeWorld();
  await w.store.updateSettings({ auto_reply_scope: 'requests' });
  await run(w);
  assert.equal(byThread(w, 't4').auto_reply_status, 'not_needed');
  assert.equal(byThread(w, 't2').auto_reply_status, 'sent');
  assert.equal(w.smtp.outbox.length, 4);
});

test('Claude failing three times still puts the request in front of the admin', async () => {
  const w = createFakeWorld({ emails: [] });
  w.gmail.deliver({ thread: 'f', from: 'F <f@example.com>', subject: 'F', body: 'food please' });
  w.ai.fail = new Error('overloaded');
  await run(w);
  await run(w);
  assert.equal(byThread(w, 'f').status, 'new');
  await run(w);
  const f = byThread(w, 'f');
  assert.equal(f.status, 'pending');
  assert.equal(f.ai_status, 'failed');
  assert.equal(f.kind, 'unknown');
  // Unknown kind stays in the inbox until someone decides.
  assert.ok(w.gmail.labels.get(f.gmail_thrid).has('\\Inbox'));
});

test('label targets', () => {
  assert.deepEqual(labelTarget({ status: 'pending', kind: 'request' }), { label: 'pending', inInbox: false, seen: false });
  assert.deepEqual(labelTarget({ status: 'other', kind: 'other' }), { label: 'none', inInbox: true, seen: false });
  assert.deepEqual(labelTarget({ status: 'declined', kind: 'request' }), { label: 'declined', inInbox: false, seen: true });
  assert.deepEqual(labelTarget({ status: 'approved', kind: 'request', needs_attention: true }), { label: 'approved', inInbox: true, seen: false });
  assert.equal(SAMPLE_EMAILS.length, 7);
});
