// "Possible duplicate of #N": a request whose phone, street address or map
// spot matches a family already on the list. Runs in the browser.

import { haversineKm } from '../groups.js';

export function normalizePhone(v) {
  const digits = String(v || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
}

const ABBR = [
  [/\bstreet\b/g, 'st'], [/\bavenue\b/g, 'ave'], [/\bboulevard\b/g, 'blvd'], [/\bdrive\b/g, 'dr'],
  [/\broad\b/g, 'rd'], [/\bplace\b/g, 'pl'], [/\bcourt\b/g, 'ct'], [/\blane\b/g, 'ln'],
  [/\bterrace\b/g, 'ter'], [/\bparkway\b/g, 'pkwy'], [/\bcircle\b/g, 'cir'], [/\bhighway\b/g, 'hwy'],
  [/\bnorth\b/g, 'n'], [/\bsouth\b/g, 's'], [/\beast\b/g, 'e'], [/\bwest\b/g, 'w'],
  [/\b(apartment|apt|unit|suite|ste)\b.*$/g, ''], [/#.*$/g, '']
];

// Street line only ("12345 burbank blvd"), lower case, common words shortened.
export function normalizeAddress(v) {
  let s = String(v || '').toLowerCase().split(',')[0];
  s = s.replace(/[.]/g, '');
  for (const [re, to] of ABBR) s = s.replace(re, to);
  return s.replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

// fields: { phone, address, latitude, longitude }; families: rows from the
// families table. Returns up to 3 { family_id, active, reasons[] }.
export function findPossibleDuplicates(fields, families) {
  const phone = normalizePhone(fields?.phone);
  const street = normalizeAddress(fields?.address);
  const hasStreet = /^\d+\s+\S+/.test(street);
  const lat = Number(fields?.latitude);
  const lng = Number(fields?.longitude);
  const hasSpot = Number.isFinite(lat) && Number.isFinite(lng) && fields?.latitude != null;
  const out = [];
  for (const f of families || []) {
    const reasons = [];
    if (phone && normalizePhone(f.contact) === phone) reasons.push('phone');
    if (hasStreet && normalizeAddress(f.address) === street) reasons.push('address');
    if (hasSpot && typeof f.latitude === 'number' && typeof f.longitude === 'number') {
      const km = haversineKm({ latitude: lat, longitude: lng }, f);
      if (km < 0.025 && !reasons.includes('address')) reasons.push('nearby');
    }
    if (reasons.length) out.push({ family_id: f.family_id, active: f.active !== false, reasons });
  }
  out.sort((a, b) => b.reasons.length - a.reasons.length || Number(b.active) - Number(a.active));
  return out.slice(0, 3);
}
