// Temporary family pauses. A pause skips one weekday (kind 'day') or the
// Saturday bag (kind 'saturday') for every date in [start_date, end_date],
// leaving the family's normal delivery_days / saturday_meals untouched so the
// schedule resumes by itself.

import { DAY_NAMES, parseDate, toDateStr, todayStr, shortDate } from './weeks';

// Next calendar date on the given weekday name, counting `from` itself.
export function nextDateForDay(dayName, from = new Date()) {
  const target = DAY_NAMES.indexOf(dayName);
  if (target < 0) throw new Error(`Unknown day name: ${dayName}`);
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  for (let i = 0; i < 7 && d.getDay() !== target; i++) d.setDate(d.getDate() + 1);
  return toDateStr(d);
}

// The Saturday bag is packed on Thursday, so Saturday pauses anchor on Thursday.
export const anchorDayFor = (kind, dayName) => (kind === 'saturday' ? 'Thursday' : dayName);

// Pause window covering the next `weeks` occurrences of the anchor weekday.
// With skipThisWeek, an occurrence that falls on today is not counted (use it
// when the family calls after today's run already went out).
export function pauseWindow(kind, dayName, weeks, skipThisWeek = false) {
  const from = new Date();
  if (skipThisWeek) from.setDate(from.getDate() + 1);
  const start = nextDateForDay(anchorDayFor(kind, dayName), from);
  const end = parseDate(start);
  end.setDate(end.getDate() + 7 * Math.max(1, weeks) - 1);
  return { start_date: start, end_date: toDateStr(end) };
}

// Delivery dates a pause actually skips (Saturdays for 'saturday' pauses).
export function pauseOccurrences(p) {
  const out = [];
  const shift = p.kind === 'saturday' ? 2 : 0;
  for (let d = parseDate(p.start_date); toDateStr(d) <= p.end_date; d.setDate(d.getDate() + 7)) {
    const occ = new Date(d);
    occ.setDate(occ.getDate() + shift);
    out.push(toDateStr(occ));
  }
  return out;
}

const covers = (pause, dateStr) => pause.start_date <= dateStr && dateStr <= pause.end_date;

// Is this family's regular delivery paused on a given date (YYYY-MM-DD)?
export function isDayPaused(family, dateStr) {
  const d = parseDate(dateStr);
  if (!d) return false;
  const norm = toDateStr(d);
  const dayName = DAY_NAMES[d.getDay()];
  return (family.pauses || []).some(p => p.kind === 'day' && p.day_name === dayName && covers(p, norm));
}

// Is this family's Saturday bag paused for the Thursday on a given date?
export function isSaturdayPaused(family, dateStr) {
  const d = parseDate(dateStr);
  if (!d) return false;
  const norm = toDateStr(d);
  return (family.pauses || []).some(p => p.kind === 'saturday' && covers(p, norm));
}

// Pauses that still skip something today or later, and still apply to the
// family's current schedule (so a stale row can't show a no-op Resume button).
export function activePauses(family) {
  const today = todayStr();
  return (family.pauses || []).filter(p => {
    const occ = pauseOccurrences(p);
    if (!occ.length || occ[occ.length - 1] < today) return false;
    if (p.kind === 'saturday') return !!family.saturday_meals;
    return !family.delivery_days || family.delivery_days.includes(p.day_name);
  });
}

export function describePause(p) {
  const what = p.kind === 'saturday' ? 'Saturday meals' : p.day_name;
  const occ = pauseOccurrences(p);
  if (!occ.length) return `${what} off`;
  const first = shortDate(occ[0]);
  const last = shortDate(occ[occ.length - 1]);
  return occ.length === 1 ? `${what} off ${first}` : `${what} off ${first} – ${last}`;
}

// Load pauses and attach them to each family as `pauses` (keyed by the family
// number). Non-fatal: if the query fails, families come back with no pauses
// and the error is logged, so a pause outage never blanks the family list.
export async function attachPauses(supabase, families) {
  const plain = families.map(f => ({ ...f, pauses: [] }));
  if (!supabase || !families.length) return plain;
  try {
    const { data, error } = await supabase.from('family_pauses').select('*');
    if (error) throw error;
    const byFamily = new Map();
    (data || []).forEach(p => {
      if (!byFamily.has(p.family_id)) byFamily.set(p.family_id, []);
      byFamily.get(p.family_id).push(p);
    });
    return families.map(f => ({ ...f, pauses: byFamily.get(f.family_id) || [] }));
  } catch (e) {
    console.error('family_pauses unavailable — treating as no pauses:', e);
    return plain;
  }
}
