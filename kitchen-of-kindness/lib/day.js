// One delivery day, computed once and shared by the kitchen table, the
// WhatsApp copy text, and the Kitchen Live page.
//
// `families` must already carry their pauses (see attachPauses in
// lib/pauses.js); `specialWeeks` is what loadSpecialOrdersForDate returns.

import { computeGroups, isPickup } from './groups';
import { isDayPaused, isSaturdayPaused } from './pauses';
import { DAY_NAMES, parseDate, toDateStr } from './weeks';

export const KITCHEN_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'];

// Today, or the next Sunday when today is Friday/Saturday (the kitchen is
// closed then). Local time, never UTC.
export function defaultKitchenDate(now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  while (d.getDay() > 4) d.setDate(d.getDate() + 1);
  return toDateStr(d);
}

// Previous/next kitchen day (skips Friday and Saturday).
export function stepKitchenDate(dateStr, direction) {
  const d = parseDate(dateStr);
  do {
    d.setDate(d.getDate() + direction);
  } while (d.getDay() > 4);
  return toDateStr(d);
}

// Families cooking or delivering on `dateStr`, with deliversToday / satToday
// flags and the day's proximity group, sorted by group then family number
// (the kitchen table's order).
export function familiesForDate(families, dateStr) {
  const dayName = DAY_NAMES[parseDate(dateStr).getDay()];
  const isThursday = dayName === 'Thursday';
  const list = families
    .map(f => {
      const inDays = !f.delivery_days || f.delivery_days.includes(dayName);
      const deliversToday = inDays && !isDayPaused(f, dateStr);
      const satToday = isThursday && !!f.saturday_meals && !isSaturdayPaused(f, dateStr);
      return { ...f, deliversToday, satToday };
    })
    .filter(f => f.deliversToday || f.satToday);
  const groups = computeGroups(list);
  return list
    .map(f => ({ ...f, group: groups.get(f.family_id) ?? null }))
    .sort((a, b) => {
      const ag = a.group ?? Infinity;
      const bg = b.group ?? Infinity;
      if (ag !== bg) return ag - bg;
      return Number(a.family_id) - Number(b.family_id);
    });
}

// Numbered groups in ascending order (Map keeps insertion order, and the
// input is already sorted by group), plus pickup and ungrouped families.
export function partitionFamilies(fams) {
  const grouped = new Map();
  const pickups = [];
  const ungrouped = [];
  fams.forEach(f => {
    if (f.group != null) {
      if (!grouped.has(f.group)) grouped.set(f.group, []);
      grouped.get(f.group).push(f);
    } else if (isPickup(f)) {
      pickups.push(f);
    } else {
      ungrouped.push(f);
    }
  });
  return { grouped, pickups, ungrouped };
}

const sumPeople = list => list.reduce((sum, x) => sum + (x.people_count || 0), 0);

export function buildDay(families, specialWeeks, dateStr) {
  const dayName = DAY_NAMES[parseDate(dateStr).getDay()];
  const isThursday = dayName === 'Thursday';
  const fams = familiesForDate(families, dateStr);
  const { grouped, pickups, ungrouped } = partitionFamilies(fams);
  const weeks = specialWeeks || [];
  const specialOrders = weeks.flatMap(w =>
    w.orders.map(o => ({ ...o, weekTitle: `${w.emoji} ${w.title}` }))
  );
  const regularBags = fams.filter(f => f.deliversToday).length;
  const satBags = fams.filter(f => f.satToday).length;
  return {
    dateStr,
    dayName,
    isThursday,
    families: fams,
    grouped,
    pickups,
    ungrouped,
    specialWeeks: weeks,
    specialOrders,
    totals: {
      families: fams.length,
      people: sumPeople(fams),
      thuPeople: sumPeople(fams.filter(f => f.deliversToday)),
      satPeople: sumPeople(fams.filter(f => f.satToday)),
      regularBags,
      satBags,
      specialBoxes: specialOrders.length,
      specialPeople: sumPeople(specialOrders),
      bags: regularBags + satBags + specialOrders.length,
      groups: grouped.size
    }
  };
}
