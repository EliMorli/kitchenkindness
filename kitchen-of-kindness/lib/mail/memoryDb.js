// In-memory stand-in for db.js: used by the tests and by local fake mode
// (MAIL_FAKE=1) so nothing touches the production database.

const DEFAULTS = {
  mail_requests: () => ({
    kind: 'unknown', kind_set_by: 'ai', status: 'new', from_name: '', from_email: '', reply_address: '', reply_key: '', subject: '',
    message_count: 1, needs_attention: false, attention_note: '', related_request_id: null, ai_status: 'due', ai_attempts: 0, ai_summary: '', ai_fields: {},
    ai_model: '', ai_error: '', ai_at: null, geo: null, auto_reply_status: 'not_needed', auto_reply_attempts: 0, auto_reply_forced: false,
    auto_reply_claimed_at: null, auto_reply_message_id: '', auto_replied_at: null, auto_reply_error: '',
    family_id: null, approved_family: null, decided_at: null, approval_email_status: 'not_needed',
    approval_email_attempts: 0, approval_email_claimed_at: null, approval_email_message_id: '',
    approval_email_sent_at: null, approval_email_error: '', gmail_label: 'none', gmail_in_inbox: true,
    gmail_seen: false, gmail_dirty: true, gmail_error: ''
  }),
  mail_messages: () => ({
    request_id: null, inbox_uid: null, message_id_header: '', in_reply_to: '', references_header: '',
    from_name: '', from_email: '', reply_to_email: '', subject: '', automated_reason: '', auth_pass: false,
    body_text: '', attachment_count: 0
  }),
  mail_settings: () => ({
    mode: 'off', auto_reply_enabled: true, auto_reply_scope: 'all', auto_reply_since: null, auto_reply_body: '',
    approval_body: '', no_reply_senders: '', inbox_uidvalidity: null, inbox_last_uid: null, inbox_fail_uid: null,
    inbox_fail_count: 0, labels_ready: false,
    sync_lock_holder: null, sync_lock_until: null, last_sync_at: null, last_sync_ok_at: null, last_sync_error: ''
  })
};

const UNIQUE = { mail_requests: 'gmail_thrid', mail_messages: 'gmail_msgid', mail_settings: 'id' };

const clone = v => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

// Postgres (through PostgREST) rejects NUL and lone surrogates in text; do the
// same here so tests catch it.
function checkText(value) {
  const json = JSON.stringify(value);
  if (/\\u0000|\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])|(?<!\\ud[89ab][0-9a-f]{2})\\ud[c-f][0-9a-f]{2}/i.test(json)) {
    const e = new Error('unsupported Unicode escape sequence');
    e.code = '22P05';
    throw e;
  }
}
const MAX_ROWS = 1000; // Supabase's default cap per response

function matches(row, f = {}) {
  for (const [k, v] of Object.entries(f.eq || {})) {
    if (v === null ? row[k] != null : row[k] !== v) return false;
  }
  for (const [k, v] of Object.entries(f.neq || {})) if (row[k] === v) return false;
  for (const [k, v] of Object.entries(f.in || {})) if (!v.includes(row[k])) return false;
  for (const [k, v] of Object.entries(f.gte || {})) if (row[k] == null || !(row[k] >= v)) return false;
  for (const [k, v] of Object.entries(f.lt || {})) if (row[k] == null || !(row[k] < v)) return false;
  return true;
}

export function createMemoryDb({ now = () => new Date(), settings = {}, familyStart = 9000 } = {}) {
  const tables = { mail_requests: [], mail_messages: [], mail_settings: [], families: [] };
  const seq = { mail_requests: 0, mail_messages: 0, families: 0 };
  const iso = () => now().toISOString();
  tables.mail_settings.push({ id: 1, ...DEFAULTS.mail_settings(), ...settings, updated_at: iso() });

  const db = {
    tables,
    async select(table, f = {}) {
      let rows = tables[table].filter(r => matches(r, f));
      if (f.order) {
        const [col, asc] = f.order;
        rows = [...rows].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc === false ? -1 : 1));
      }
      rows = rows.slice(0, Math.min(f.limit || MAX_ROWS, MAX_ROWS));
      return clone(rows);
    },
    async insert(table, row, { onConflictIgnore } = {}) {
      checkText(row);
      const key = UNIQUE[table];
      if (key && row[key] != null && tables[table].some(r => r[key] === row[key])) {
        if (onConflictIgnore) return [];
        const e = new Error(`duplicate key ${key}`);
        e.code = '23505';
        throw e;
      }
      const full = {
        ...(DEFAULTS[table] ? DEFAULTS[table]() : {}),
        ...clone(row),
        id: row.id ?? ++seq[table],
        created_at: iso(),
        updated_at: iso()
      };
      if (table === 'mail_requests') {
        full.first_message_at ??= iso();
        full.last_message_at ??= iso();
      }
      if (table === 'mail_messages') full.received_at ??= iso();
      tables[table].push(full);
      return [clone(full)];
    },
    async update(table, patch, f = {}) {
      checkText(patch);
      const out = [];
      for (const r of tables[table]) {
        if (!matches(r, f)) continue;
        Object.assign(r, clone(patch));
        if ('updated_at' in r) r.updated_at = iso();
        out.push(clone(r));
      }
      return out;
    },
    async rpc(name, args) {
      if (name === 'mail_counts') {
        const c = { pending: 0, approved: 0, declined: 0, other: 0, attention: 0, badge: 0 };
        for (const r of tables.mail_requests) {
          const open = r.status === 'new' || r.status === 'pending';
          if (open) c.pending += 1;
          else if (c[r.status] !== undefined) c[r.status] += 1;
          if (r.needs_attention) c.attention += 1;
          if (open || r.needs_attention) c.badge += 1;
        }
        return c;
      }
      if (name === 'mail_try_lock') {
        const s = tables.mail_settings[0];
        if (s.sync_lock_until && s.sync_lock_until >= iso()) return false;
        s.sync_lock_holder = args.p_holder;
        s.sync_lock_until = new Date(now().getTime() + args.p_seconds * 1000).toISOString();
        return true;
      }
      if (name === 'mail_approve_request') {
        const r = tables.mail_requests.find(x => x.id === args.p_request_id);
        if (!r) throw Object.assign(new Error('request_not_found'), { code: 'P0001' });
        if (r.status === 'approved') return r.family_id;
        if (!['pending', 'other', 'new'].includes(r.status)) {
          throw Object.assign(new Error(`request_is_${r.status}`), { code: 'P0001' });
        }
        const fam = args.p_family;
        const id = Math.max(familyStart - 1, ...tables.families.map(x => x.family_id)) + 1;
        tables.families.push({ id: ++seq.families, family_id: id, active: true, ...clone(fam) });
        Object.assign(r, {
          status: 'approved', kind: 'request', kind_set_by: 'admin', family_id: id, approved_family: clone(fam), decided_at: iso(),
          needs_attention: false, attention_note: '', gmail_dirty: true, updated_at: iso(),
          approval_email_status: args.p_send_email && r.reply_address ? 'due' : 'not_needed',
          auto_reply_status: r.auto_reply_status === 'wait_ai' ? 'not_needed' : r.auto_reply_status
        });
        return id;
      }
      throw new Error(`unknown rpc ${name}`);
    }
  };
  return db;
}
