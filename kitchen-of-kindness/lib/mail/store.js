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
    messagesForMany: ids =>
      ids.length ? db.select('mail_messages', { in: { request_id: ids }, order: ['received_at', true] }) : Promise.resolve([]),

    // Conditional update: `where` adds equality / in-list conditions.
    updateRequest: (id, patch, where = {}) =>
      db.update('mail_requests', patch, { eq: { id, ...(where.eq || {}) }, in: where.in }).then(one),

    // Has this address had an auto-reply (or a claimed one) since `since`?
    async repliedRecently(address, since) {
      if (!address) return false;
      const rows = await db.select('mail_requests', {
        eq: { reply_address: address },
        gte: { auto_reply_claimed_at: since },
        columns: 'id',
        limit: 1
      });
      return rows.length > 0;
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
      const rows = await db.select('mail_requests', { columns: 'status,needs_attention' });
      const c = { pending: 0, approved: 0, declined: 0, other: 0, attention: 0 };
      for (const r of rows) {
        if (r.status === 'new' || r.status === 'pending') c.pending += 1;
        else if (c[r.status] !== undefined) c[r.status] += 1;
        if (r.needs_attention) c.attention += 1;
      }
      return c;
    },
    approve: (id, family, sendEmail) =>
      db.rpc('mail_approve_request', { p_request_id: id, p_family: family, p_send_email: !!sendEmail })
  };
  return store;
}
