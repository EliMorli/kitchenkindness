// Cleaning Claude's extracted fields and validating a family before it is
// created. Both `instructions` and `notes` print on delivery labels and show
// on the kitchen view, so names must never end up in them.

import { DAYS } from './config.js';
import { dbText } from './text.js';

const OTHER_TOPICS = [
  'none', 'volunteering', 'donation', 'question', 'thanks', 'update_existing',
  'vendor_or_newsletter', 'spam', 'other'
];
const MISSING = ['address', 'phone', 'people_count'];
const FLAGS = ['instructions_to_ai', 'multiple_households', 'unclear', 'outside_area', 'name_removed'];

const str = (v, max) => dbText(dbText(v).replace(/\s+/g, ' ').trim(), max);
const pick = (list, allowed) => [...new Set((Array.isArray(list) ? list : []).filter(x => allowed.includes(x)))];

const NAME_STOPWORDS = new Set([
  'the', 'and', 'for', 'family', 'mrs', 'miss', 'kitchen', 'kindness', 'please', 'thank', 'thanks',
  'house', 'home', 'apt', 'unit', 'door', 'leave', 'call', 'ring', 'hand', 'resident'
]);

// Lower-case words (3+ letters) from people's names, for spotting them in notes.
export function nameTokens(names) {
  const out = new Set();
  for (const n of names || []) {
    for (const w of String(n || '').split(/[^\p{L}'-]+/u)) {
      const t = w.toLowerCase().replace(/^['-]+|['-]+$/g, '');
      if (t.length >= 3 && !NAME_STOPWORDS.has(t)) out.add(t);
    }
  }
  return [...out];
}

const wordRe = t => new RegExp(`(^|[^\\p{L}])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^\\p{L}])`, 'iu');

export const findNames = (text, tokens) => tokens.filter(t => wordRe(t).test(String(text || '')));

export function stripNames(text, tokens) {
  let t = String(text || '');
  for (const tok of tokens) t = t.replace(new RegExp(wordRe(tok).source, 'giu'), '$1');
  return t.replace(/\s{2,}/g, ' ').replace(/\s+([,.;:])/g, '$1').replace(/^[\s,.;:-]+|[\s,;:-]+$/g, '').trim();
}

export function sanitizeAiFields(ai = {}, { fromName = '' } = {}) {
  let people = Number.isInteger(ai.people_count) ? ai.people_count : parseInt(ai.people_count, 10);
  if (!Number.isFinite(people) || people < 0) people = 0;
  if (people > 20) people = 20;
  const out = {
    kind: ai.kind === 'request' ? 'request' : 'other',
    other_topic: OTHER_TOPICS.includes(ai.other_topic) ? ai.other_topic : 'none',
    summary: str(ai.summary, 500),
    requester_name: str(ai.requester_name, 80),
    on_behalf_of_someone: !!ai.on_behalf_of_someone,
    phone: str(ai.phone, 40),
    address: str(ai.address, 200),
    unit: str(ai.unit, 30),
    people_count: people,
    days: DAYS.filter(d => Array.isArray(ai.days) && ai.days.includes(d)),
    delivery_instructions: str(ai.delivery_instructions, 200),
    dietary_notes: str(ai.dietary_notes, 300),
    language: str(ai.language, 30),
    urgent: !!ai.urgent,
    missing: pick(ai.missing, MISSING),
    flags: pick(ai.flags, FLAGS)
  };
  const tokens = nameTokens([out.requester_name, fromName]);
  for (const key of ['delivery_instructions', 'dietary_notes']) {
    if (findNames(out[key], tokens).length) {
      out[key] = stripNames(out[key], tokens);
      if (!out.flags.includes('name_removed')) out.flags.push('name_removed');
    }
  }
  return out;
}

// Starting values for the editable family form on a request card.
export function familyDraft(fields = {}) {
  return {
    address: fields.address || '',
    unit: fields.unit || '',
    contact: fields.phone || '',
    people_count: fields.people_count > 0 ? fields.people_count : '',
    delivery_days: fields.days?.length ? [...fields.days] : [...DAYS],
    instructions: fields.delivery_instructions || 'Leave at door',
    notes: fields.dietary_notes || '',
    saturday_meals: false
  };
}

const finite = v => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : NaN);

// Server-side (and in-card) check of the family the admin is approving.
// Returns { ok, family, errors }.
export function validateFamilyPayload(input = {}, { names = [] } = {}) {
  const errors = [];
  const family = {
    address: str(input.address, 200),
    unit: str(input.unit, 30),
    contact: str(input.contact, 40),
    people_count: Number(input.people_count),
    delivery_days: DAYS.filter(d => Array.isArray(input.delivery_days) && input.delivery_days.includes(d)),
    instructions: str(input.instructions, 200) || 'Leave at door',
    notes: str(input.notes, 300),
    saturday_meals: !!input.saturday_meals,
    latitude: finite(input.latitude),
    longitude: finite(input.longitude)
  };
  if (!family.address) errors.push('Add an address.');
  if (!Number.isInteger(family.people_count) || family.people_count < 1 || family.people_count > 20) {
    errors.push('Set the number of people (1–20).');
  }
  if (!family.delivery_days.length) errors.push('Pick at least one delivery day.');
  const tokens = nameTokens(names);
  const named = [...findNames(family.instructions, tokens), ...findNames(family.notes, tokens)];
  if (named.length) errors.push('Remove the name from the instructions/notes — they print on labels.');
  const { latitude: lat, longitude: lng } = family;
  if (Number.isNaN(lat) || Number.isNaN(lng) || (lat === null) !== (lng === null)) {
    errors.push('The map location is invalid. Re-check the address.');
  } else if (lat !== null && (Math.abs(lat) > 90 || Math.abs(lng) > 180)) {
    errors.push('The map location is invalid. Re-check the address.');
  }
  return { ok: errors.length === 0, family, errors };
}
