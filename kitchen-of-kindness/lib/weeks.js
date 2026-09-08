// Helpers for "special week" volunteer sign-ups (holiday prep weeks).

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "2026-09-06" → local-midnight Date (no UTC shift).
export function parseDate(dateStr) {
  if (!dateStr) return null;
  const [y, m, d] = String(dateStr).split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

export function toDateStr(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function todayStr() {
  return toDateStr(new Date());
}

export function dayName(dateStr) {
  const d = parseDate(dateStr);
  return d ? DAY_NAMES[d.getDay()] : '';
}

export function shortDate(dateStr) {
  const d = parseDate(dateStr);
  return d ? `${MONTH_NAMES[d.getMonth()]} ${d.getDate()}` : '';
}

export function longDate(dateStr) {
  const d = parseDate(dateStr);
  return d ? `${DAY_NAMES[d.getDay()]}, ${MONTH_NAMES[d.getMonth()]} ${d.getDate()}` : '';
}

// Active (non-cancelled) sign-ups for a day.
export function activeSignups(day) {
  return (day.signups || []).filter(s => !s.cancelled_at);
}

// null when unlimited, otherwise remaining spots (never below 0).
export function spotsLeft(day) {
  if (day.capacity == null) return null;
  return Math.max(0, day.capacity - activeSignups(day).length);
}

export function isFull(day) {
  const left = spotsLeft(day);
  return left !== null && left <= 0;
}

// Slug from a title + start year, e.g. "Sukkot Prep" + 2026 → "sukkot-prep-2026".
export function slugify(title, dateStr) {
  const base = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const year = parseDate(dateStr)?.getFullYear();
  return year && !base.endsWith(String(year)) ? `${base}-${year}` : base;
}

// Every date from start to end inclusive.
export function dateRange(startStr, endStr) {
  const out = [];
  const start = parseDate(startStr);
  const end = parseDate(endStr);
  if (!start || !end) return out;
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    out.push(toDateStr(d));
  }
  return out;
}

// Load a week with its days and sign-ups in one shape:
// { ...week, days: [{ ...day, signups: [...] }] } sorted by date.
export async function loadWeek(supabase, slug) {
  const { data: week, error } = await supabase
    .from('volunteer_weeks')
    .select('*')
    .eq('slug', slug)
    .maybeSingle();
  if (error) throw error;
  if (!week) return null;
  const days = await loadDaysForWeek(supabase, week.id);
  return { ...week, days };
}

export async function loadDaysForWeek(supabase, weekId) {
  const { data: days, error: dErr } = await supabase
    .from('volunteer_week_days')
    .select('*')
    .eq('week_id', weekId)
    .order('date', { ascending: true });
  if (dErr) throw dErr;
  const dayIds = (days || []).map(d => d.id);
  let signups = [];
  if (dayIds.length) {
    const { data: s, error: sErr } = await supabase
      .from('volunteer_week_signups')
      .select('*')
      .in('day_id', dayIds)
      .order('created_at', { ascending: true });
    if (sErr) throw sErr;
    signups = s || [];
  }
  return (days || []).map(d => ({
    ...d,
    signups: signups.filter(s => s.day_id === d.id)
  }));
}

// ---- Special orders (extra deliveries attached to a special week) ----

export async function loadOrdersForWeek(supabase, weekId) {
  const { data, error } = await supabase
    .from('volunteer_week_orders')
    .select('*')
    .eq('week_id', weekId)
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true });
  if (error) throw error;
  return data || [];
}

// Active weeks whose date range includes `dateStr`, each with the orders that
// apply on that date (delivery_date NULL = every day of the week).
export async function loadSpecialOrdersForDate(supabase, dateStr) {
  if (!supabase || !dateStr) return [];
  const { data: weeks, error } = await supabase
    .from('volunteer_weeks')
    .select('*')
    .eq('active', true)
    .lte('start_date', dateStr)
    .gte('end_date', dateStr)
    .order('start_date', { ascending: true });
  if (error) throw error;
  if (!weeks?.length) return [];
  const { data: orders, error: oErr } = await supabase
    .from('volunteer_week_orders')
    .select('*')
    .in('week_id', weeks.map(w => w.id))
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true });
  if (oErr) throw oErr;
  return weeks
    .map(w => ({
      ...w,
      orders: (orders || []).filter(o => o.week_id === w.id && (!o.delivery_date || o.delivery_date === dateStr))
    }))
    .filter(w => w.orders.length > 0);
}

// Display name for a special order: "#412" when linked to a family, else its label.
export function orderTitle(order) {
  return order.family_id != null ? `#${order.family_id}` : (order.label || 'Special order');
}
