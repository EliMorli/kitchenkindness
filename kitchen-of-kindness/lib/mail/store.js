// Named mail operations over db.js / memoryDb.js, shared by the sync and the
// API routes. Every state change that matters is a conditional update, so two
// runs (or a run and the admin) can't both act on the same request.

export const UNDECIDED = ['new', 'pending', 'other'];

export function createStore(db) {
  const one = rows => rows[0] || null;

  const store = {
    db,
    getSettings: async () => one(await db.select('mail_settings', { eq: { id: 1 } })),
    updateSettings: patch => db.update('mail_settings', patch, { eq: { id: 1 } }).then(one),
    tryLock: (holder, seconds) => db.rpc('mail_try_lock', { p_holder: holder, p_seconds: seconds }),
    releaseLock: holder =>
      db.update('mail_settings', { sync_lock_holder: null, sync_lock_until: null }, { eq: { id: 1, sync_lock_holder: holder } }),

    async knownMessageIds(ids) {
      if (!ids.length) return new Set();
      const rows = await db.select('mail_messages', { in: { gmail_msgid: ids }, columns: 'gmail_msgid' });
      return new Set(rows.map(r => r.gmail_msgid));
    },
    requestByThread: async thrid => one(await db.select('mail_requests', { eq: { gmail_thrid: thrid } })),
    getRequest: async id => one(await db.select('mail_requests', { eq: { id } })),
    async insertRequest(row) {
      const inserted = one(await db.insert('mail_requests', row, { onConflictIgnore: 'gmail_thrid' }));
      return inserted || store.requestByThread(row.gmail_thrid);
    },
    insertMessage: row => db.insert('mail_messages', row, { onConflictIgnore: 'gmail_msgid' }).then(one),
    messagesFor: requestId => db.select('mail_messages', { eq: { request_id: requestId }, order: ['received_at', true] }),
    // How many emails are stored for a request, and the Gmail conversations
    // they are in (a reply can land in a new one).
    async messageCount(requestId) {
      return (await db.select('mail_messages', { eq: { request_id: requestId }, columns: 'id', limit: 1000 })).length;
    },
    // (Leaving out conversations that are another request's own.)
    async threadsFor(requestId) {
      const rows = await db.select('mail_messages', { eq: { request_id: requestId }, columns: 'gmail_thrid', limit: 1000 });
      const ids = [...new Set(rows.map(m => m.gmail_thrid).filter(Boolean))];
      if (!ids.length) return ids;
      const owners = await db.select('mail_requests', { in: { gmail_thrid: ids }, columns: 'id,gmail_thrid', limit: 1000 });
      const others = new Set(owners.filter(o => o.id !== requestId).map(o => o.gmail_thrid));
      return ids.filter(t => !others.has(t));
    },
    // In small batches: one Supabase response is capped at 1000 rows.
    async messagesForMany(ids) {
      const out = [];
      for (let i = 0; i < ids.length; i += 10) {
        const part = ids.slice(i, i + 10);
        out.push(...(await db.select('mail_messages', { in: { request_id: part }, order: ['received_at', true], limit: 1000 })));
      }
      return out;
    },
    // A reply that Gmail filed as a new conversation (e.g. a changed
    // subject): find the request whose emails it answers.
    // Only plain <id@host> values, and a few of them: these come from the
    // email and go into a database filter.
    async requestForReplyIds(ids) {
      const wanted = [...new Set((ids || []).filter(id => /^<[^\s"(),\\]{1,250}>$/.test(id)))].slice(-10);
      if (!wanted.length) return null;
      const msgs = await db.select('mail_messages', { in: { message_id_header: wanted }, columns: 'request_id', limit: 5 });
      const known = msgs.find(m => m.request_id);
      if (known) return store.getRequest(known.request_id);
      for (const col of ['auto_reply_message_id', 'approval_email_message_id']) {
        const r = one(await db.select('mail_requests', { in: { [col]: wanted }, limit: 1 }));
        if (r) return r;
      }
      return null;
    },

    // Conditional update: `where` adds equality / in-list conditions.
    updateRequest: (id, patch, where = {}) =>
      db.update('mail_requests', patch, { eq: { id, ...(where.eq || {}) }, in: where.in }).then(one),

    // Has this sender (reply_key) had an auto-reply (or a claimed one) since
    // `since`, on another request?
    async repliedRecently(key, since, exceptId = null) {
      if (!key) return false;
      const rows = await db.select('mail_requests', {
        eq: { reply_key: key },
        gte: { auto_reply_claimed_at: since },
        columns: 'id',
        limit: 3
      });
      return rows.some(r => r.id !== exceptId);
    },

    listByField: (field, value, { limit = 20, order = 'first_message_at' } = {}) =>
      db.select('mail_requests', { eq: { [field]: value }, order: [order, true], limit }),
    listStaleClaims: (prefix, before) =>
      db.select('mail_requests', { eq: { [`${prefix}_status`]: 'claimed' }, lt: { [`${prefix}_claimed_at`]: before }, limit: 20 }),
    listAiDue: limit =>
      db.select('mail_requests', { eq: { ai_status: 'due' }, in: { status: UNDECIDED }, order: ['last_message_at', true], limit }),
    listDirty: limit => db.select('mail_requests', { eq: { gmail_dirty: true }, order: ['updated_at', true], limit }),

    // Admin views.
    listForAdmin(view, limit = 150) {
      const f = { order: ['last_message_at', false], limit };
      if (view === 'attention') f.eq = { needs_attention: true };
      else if (view === 'pending') f.in = { status: ['new', 'pending'] };
      else f.eq = { status: view };
      return db.select('mail_requests', f);
    },
    async counts() {
      const c = await db.rpc('mail_counts', {});
      return { pending: 0, approved: 0, declined: 0, other: 0, attention: 0, badge: 0, ...(c || {}) };
    },
    approve: (id, family, sendEmail) =>
      db.rpc('mail_approve_request', { p_request_id: id, p_family: family, p_send_email: !!sendEmail })
  };
  return store;
}
