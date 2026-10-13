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

  // Unclear (e.g. a timeout mid-send): it stays claimed, nothing is resent
  // until Sent Mail has been checked.
  const w2 = createFakeWorld({ emails: [] });
  w2.gmail.deliver({ thread: 'b', from: 'B <b@example.com>', subject: 'B', body: 'food please' });
  w2.smtp.fail = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
  await run(w2);
  assert.equal(byThread(w2, 'b').auto_reply_status, 'claimed');
  w2.smtp.fail = null;
  await run(w2);
  assert.equal(w2.smtp.outbox.length, 0);
  // Ten minutes later it isn't in Sent Mail: it didn't go out, so it's sent once.
  await w2.store.updateRequest(byThread(w2, 'b').id, { auto_reply_claimed_at: new Date(Date.now() - 11 * 60_000).toISOString() });
  await run(w2);
  assert.equal(byThread(w2, 'b').auto_reply_status, 'sent');
  assert.equal(w2.smtp.outbox.length, 1);
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
  // c was in Sent Mail: marked sent, not resent. d never went out: sent once now.
  assert.equal(byThread(w, 'c').auto_reply_status, 'sent');
  assert.equal(byThread(w, 'd').auto_reply_status, 'sent');
  assert.deepEqual(w.smtp.outbox.map(m => m.to), ['d@example.com']);
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

test('an email with NUL characters is cleaned and saved (it used to block the inbox)', async () => {
  const w = createFakeWorld({ emails: [] });
  w.gmail.deliver({ thread: 'n', from: 'Ana <ana@example.com>', subject: 'x', rawSubject: '=?utf-8?Q?Need_help=00please?=', body: 'Hello=00 we need meals' });
  w.gmail.deliver({ thread: 'n2', from: 'Ben <ben@example.com>', subject: 'Later email', body: 'food please' });
  const r = await run(w);
  assert.equal(r.newRequests, 2);
  assert.equal(byThread(w, 'n').subject, 'Need helpplease');
  assert.ok(!w.db.tables.mail_messages.some(m => /\u0000/.test(m.body_text)));
});

test('an email that can never be saved is skipped after 3 tries, not blocking later mail', async () => {
  const w = createFakeWorld({ emails: [] });
  w.gmail.deliver({ thread: 'bad', from: 'Bad <bad@example.com>', subject: 'Bad', body: 'food please' });
  w.gmail.deliver({ thread: 'good', from: 'Good <good@example.com>', subject: 'Good', body: 'food please' });
  const badId = w.gmail.inbox[0].emailId;
  const insert = w.db.insert;
  w.db.insert = async (table, row, opts) => {
    if (table === 'mail_messages' && row.gmail_msgid === badId && row.automated_reason !== 'unreadable') throw new Error('boom');
    return insert(table, row, opts);
  };
  await run(w);
  await run(w);
  assert.equal(byThread(w, 'good'), undefined);
  const r = await run(w);
  assert.equal(r.skippedUnreadable, 1);
  assert.ok(byThread(w, 'good'));
  assert.ok(w.db.tables.mail_messages.some(m => m.gmail_msgid === badId && m.automated_reason === 'unreadable'));
  // The bad email's request was created before the failure; it was never counted twice.
  assert.equal(byThread(w, 'bad').message_count, 1);
});

test('replies only go to the verified sender, never to a stranger in Reply-To', async () => {
  const w = createFakeWorld({ emails: [] });
  w.gmail.deliver({ thread: 's1', from: 'Bob <bob@attacker.example>', replyTo: 'victim+1@gmail.com', subject: 'Help', body: 'food please' });
  w.gmail.deliver({ thread: 's2', from: 'Sue <sue@clinic.example>', replyTo: 'intake@clinic.example', subject: 'Referral', body: 'food please' });
  w.gmail.deliver({
    thread: 's3', from: 'Eve <eve@victim.example>', subject: 'Fake pass', body: 'food please',
    verified: 'mx.google.com; spf=fail (google.com: domain of spf=pass@victim.example does not designate) smtp.mailfrom=spf=pass@victim.example'
  });
  await run(w);
  assert.equal(byThread(w, 's1').reply_address, 'bob@attacker.example');
  assert.equal(byThread(w, 's2').reply_address, 'intake@clinic.example');
  assert.equal(byThread(w, 's3').auto_reply_status, 'not_needed');
  assert.deepEqual(w.smtp.outbox.map(m => m.to).sort(), ['bob@attacker.example', 'intake@clinic.example']);
});

test('one auto-reply per sender per week, however they write their address', async () => {
  const w = createFakeWorld({ emails: [] });
  w.gmail.deliver({ thread: 'k1', from: 'Ana <ana.lopez@gmail.com>', subject: 'One', body: 'food please' });
  await run(w);
  w.gmail.deliver({ thread: 'k2', from: 'Ana <AnaLopez+food@gmail.com>', subject: 'Two', body: 'food please' });
  await run(w);
  assert.equal(w.smtp.outbox.length, 1);
  assert.equal(byThread(w, 'k2').auto_reply_status, 'not_needed');
});

test('a reply queued before auto-replies were turned off is not sent', async () => {
  const w = createFakeWorld({ emails: [] });
  w.gmail.deliver({ thread: 'q', from: 'Q <q@example.com>', subject: 'Q', body: 'food please' });
  w.smtp.fail = Object.assign(new Error('auth'), { code: 'EAUTH' });
  await run(w);
  assert.equal(byThread(w, 'q').auto_reply_status, 'due');
  w.smtp.fail = null;
  await w.store.updateSettings({ auto_reply_enabled: false });
  await run(w);
  assert.equal(byThread(w, 'q').auto_reply_status, 'not_needed');
  assert.equal(w.smtp.outbox.length, 0);
});

test("the admin's 'not a request' survives follow-ups and Claude", async () => {
  const w = createFakeWorld();
  await run(w);
  const t2 = byThread(w, 't2');
  await w.store.updateRequest(t2.id, { kind: 'other', status: 'other', kind_set_by: 'admin', gmail_dirty: true });
  w.gmail.deliver({ thread: 't2', from: '"Dana Weiss, LCSW" <dana.weiss@example-clinic.org>', subject: 'Re: Referral', body: 'any update?', replyTo: 0 });
  await run(w);
  const after = byThread(w, 't2');
  assert.equal(after.status, 'other');
  assert.equal(after.needs_attention, true);
  assert.ok(w.gmail.labels.get(after.gmail_thrid).has('\\Inbox'));
});

test('dry run sends nothing, changes no labels, and leaves queued work for the real sync', async () => {
  const w = createFakeWorld();
  const r = await run(w, { dryRun: true });
  assert.equal(r.newRequests, 5);
  assert.equal(w.smtp.outbox.length, 0);
  assert.ok(rows(w).filter(x => x.auto_reply_status === 'due').length === 5);
  assert.ok(![...w.gmail.labels.values()].some(set => [...set].some(l => l.startsWith('Kitchen'))));
  await run(w);
  assert.equal(w.smtp.outbox.length, 5);
});

test('HTML-only emails (photo attached) keep their text', async () => {
  const w = createFakeWorld({ emails: [] });
  w.gmail.deliver({ thread: 'h', from: 'Hana <hana@example.com>', subject: 'Help', body: 'We are 3 people at 100 Main St', html: true });
  await run(w);
  const msg = w.db.tables.mail_messages.find(m => m.request_id === byThread(w, 'h').id);
  assert.match(msg.body_text, /We are 3 people at 100 Main St/);
  assert.equal(msg.attachment_count, 1);
});

test('a reply that lands in a new Gmail conversation joins its request', async () => {
  const w = createFakeWorld({ emails: [] });
  w.gmail.deliver({ thread: 'r1', from: 'Ana <ana@example.com>', subject: '', body: 'food please' });
  await run(w);
  const ack = w.smtp.outbox[0];
  assert.equal(ack.subject, 'Re:');
  w.gmail.deliver({ thread: 'r2', from: 'Ana <ana@example.com>', subject: 'Re: my address', body: '5 Oak St', inReplyTo: ack.messageId });
  const r = await run(w);
  assert.equal(r.newRequests, 0);
  assert.equal(r.followUps, 1);
  assert.equal(byThread(w, 'r1').message_count, 2);
});

test('long threads stop being re-summarized automatically', async () => {
  const w = createFakeWorld({ emails: [] });
  w.gmail.deliver({ thread: 'L', from: 'L <l@example.com>', subject: 'L', body: 'food please' });
  await run(w);
  for (let i = 0; i < 8; i++) {
    w.gmail.deliver({ thread: 'L', from: 'L <l@example.com>', subject: 'Re: L', body: `more ${i}`, replyTo: 0 });
    await run(w);
  }
  const L = byThread(w, 'L');
  assert.equal(L.message_count, 9);
  assert.equal(L.needs_attention, true);
  assert.notEqual(L.ai_status, 'due');
});

test('Claude gets a time limit inside the run budget', async () => {
  const w = createFakeWorld({ emails: [] });
  w.gmail.deliver({ thread: 'T', from: 'T <t@example.com>', subject: 'T', body: 'food please' });
  await run(w);
  assert.ok(w.ai.lastOpts.timeoutMs >= 8000 && w.ai.lastOpts.timeoutMs <= 25000);
});

test('counts stay right past 1000 requests', async () => {
  const w = createFakeWorld({ emails: [] });
  for (let i = 0; i < 1100; i++) await w.db.insert('mail_requests', { gmail_thrid: `x${i}`, status: i % 2 ? 'declined' : 'pending' });
  const c = await w.store.counts();
  assert.equal(c.pending + c.declined, 1100);
});
