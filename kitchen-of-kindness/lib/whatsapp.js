// WhatsApp-ready text for a day (see buildDay in lib/day.js). The admin
// copies it into the volunteers group chat, where volunteers say which group
// they take.

import { addressArea } from './format';
import { orderTitle } from './weeks';

const familyLine = f =>
  `${f.family_id} — ${addressArea(f.address) || '—'}${f.satToday ? ' (+Sat)' : ''}`;

function bodyLines(day) {
  const lines = [];
  for (const [g, list] of day.grouped) {
    lines.push(`*Group ${g}* (${list.length} ${list.length === 1 ? 'bag' : 'bags'})`);
    list.forEach(f => lines.push(familyLine(f)));
    lines.push('');
  }
  if (day.ungrouped.length) {
    lines.push('*Ungrouped*');
    day.ungrouped.forEach(f => lines.push(familyLine(f)));
    lines.push('');
  }
  if (day.pickups.length) {
    lines.push(`*Pickup at kitchen*: ${day.pickups.map(f => f.family_id).join(', ')}`);
    lines.push('');
  }
  day.specialWeeks.forEach(w => {
    lines.push(`*✨ ${w.emoji} ${w.title}* (${w.orders.length} ${w.orders.length === 1 ? 'box' : 'boxes'})`);
    w.orders.forEach(o =>
      lines.push(`${orderTitle(o)} — ${addressArea(o.address) || o.instructions || '—'}`)
    );
    lines.push('');
  });
  return lines;
}

const header = day => `\u{1F372} Kitchen of Kindness — ${day.dayName} deliveries`;

// Plain list: groups with family number and area.
export function buildWhatsAppList(day) {
  return [header(day), '', ...bodyLines(day)].join('\n').trim();
}

// Same list led by a link to the live claim page for the date.
export function buildChecklist(day, origin) {
  return [
    header(day),
    '',
    '✅ *Tap here to claim your bags (live list):*',
    `${origin}/?date=${day.dateStr}`,
    '',
    ...bodyLines(day)
  ].join('\n').trim();
}

// One group's lines, for re-sending a single group in the chat.
export function buildGroupText(day, groupNumber) {
  const list = day.grouped.get(groupNumber) || [];
  return [
    `*Group ${groupNumber}* (${list.length} ${list.length === 1 ? 'bag' : 'bags'})`,
    ...list.map(familyLine)
  ].join('\n');
}
