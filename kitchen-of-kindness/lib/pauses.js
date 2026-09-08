// Temporary family pauses. A pause skips one weekday (kind 'day') or the
// Saturday bag (kind 'saturday') for every date in [start_date, end_date],
// leaving the family's normal delivery_days / saturday_meals untouched so the
// schedule resumes by itself.

import { DAY_NAMES, parseDate, toDateStr, todayStr } from './weeks';

// Next calendar date (today counts) that falls on the given weekday name.
export function nextDateForDay(dayName, from = new Date()) {
  const target = DAY_NAMES.indexOf(dayName);
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  while (d.getDay() !== target) d.setDate(d.getDate() + 1);
  return toDateStr(d);
}

// Pause window covering the next `weeks` occurrences of a weekday. The
// Saturday bag is packed on Thursday, so it uses Thursday as its anchor.
export function pauseWindow(kind, dayName, weeks) {
  const anchor = kind === 'saturday' ? 'Thursday' : dayName;
  const start = nextDateForDay(anchor);
  const end = parseDate(start);
  end.setDate(end.getDate() + 7 * Math.max(1, weeks) - 1);
  return { start_date: start, end_date: toDateStr(end) };
}

const covers = (pause, dateStr) => pause.start_date <= dateStr && dateStr <= pause.end_date;

// Is this family's regular delivery paused on a given date?
export function isDayPaused(family, dateStr) {
  const dayName = DAY_NAMES[parseDate(dateStr).getDay()];
  return (family.pauses || []).some(p => p.kind === 'day' && p.day_name === dayName && covers(p, dateStr));
}

// Is this family's Saturday bag paused for the Thursday on a given date?
export function isSaturdayPaused(family, dateStr) {
  return (family.pauses || []).some(p => p.kind === 'saturday' && covers(p, dateStr));
}

// Pauses that are still relevant (end today or later), for display.
export function activePauses(family) {
  const today = todayStr();
  return (family.pauses || []).filter(p => p.end_date >= today);
}

export function describePause(p) {
  const what = p.kind === 'saturday' ? 'Saturday meals' : p.day_name;
  return `${what} off ${p.start_date === p.end_date ? 'on' : 'through'} ${p.end_date}`;
}

// Load current/future pauses and attach them to each family as `pauses`
// (keyed by the family number). Past pauses are ignored.
export async function attachPauses(supabase, families) {
  if (!supabase || !families.length) return families.map(f => ({ ...f, pauses: [] }));
  const { data, error } = await supabase
    .from('family_pauses')
    .select('*')
    .gte('end_date', todayStr());
  if (error) throw error;
  const byFamily = new Map();
  (data || []).forEach(p => {
    if (!byFamily.has(p.family_id)) byFamily.set(p.family_id, []);
    byFamily.get(p.family_id).push(p);
  });
  return families.map(f => ({ ...f, pauses: byFamily.get(f.family_id) || [] }));
}
