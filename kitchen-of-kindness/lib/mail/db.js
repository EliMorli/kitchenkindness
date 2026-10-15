// Minimal data operations the mail code needs, on top of the server-side
// (service role) Supabase client. memoryDb.js implements the same five
// functions in memory for tests and local fake mode.
//
// Filters: { eq: {col: value|null}, neq: {}, in: {col: [..]}, gte: {}, lt: {},
//            order: [col, ascending], limit: n, columns: 'a,b' }

function applyFilters(q, f = {}) {
  for (const [k, v] of Object.entries(f.eq || {})) q = v === null ? q.is(k, null) : q.eq(k, v);
  for (const [k, v] of Object.entries(f.neq || {})) q = q.neq(k, v);
  for (const [k, v] of Object.entries(f.in || {})) q = q.in(k, v);
  for (const [k, v] of Object.entries(f.gte || {})) q = q.gte(k, v);
  for (const [k, v] of Object.entries(f.lt || {})) q = q.lt(k, v);
  return q;
}

const fail = (error, what) => {
  const e = new Error(`${what} failed: ${error.message}`);
  e.code = error.code;
  throw e;
};

export function createSupabaseDb(client) {
  return {
    async select(table, f = {}) {
      let q = applyFilters(client.from(table).select(f.columns || '*'), f);
      if (f.order) q = q.order(f.order[0], { ascending: f.order[1] !== false });
      if (f.limit) q = q.limit(f.limit);
      const { data, error } = await q;
      if (error) fail(error, `select ${table}`);
      return data || [];
    },
    async insert(table, row, { onConflictIgnore } = {}) {
      const q = onConflictIgnore
        ? client.from(table).upsert(row, { onConflict: onConflictIgnore, ignoreDuplicates: true })
        : client.from(table).insert(row);
      const { data, error } = await q.select();
      if (error) fail(error, `insert ${table}`);
      return data || [];
    },
    async update(table, patch, f = {}) {
      const { data, error } = await applyFilters(client.from(table).update(patch), f).select();
      if (error) fail(error, `update ${table}`);
      return data || [];
    },
    async rpc(name, args) {
      const { data, error } = await client.rpc(name, args);
      if (error) fail(error, name);
      return data;
    }
  };
}
