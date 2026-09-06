// Display-only text cleanup. The database may hold hand-typed values in any
// casing; these helpers normalize what the user sees without touching the
// stored data.

const KEEP_UPPER = new Set(['CA', 'USA', 'N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW']);

export function formatAddress(raw, unit) {
  if (!raw) return raw;
  let s = raw
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ', ')
    .replace(/,\s*$/, '')
    .replace(/,?\s*(USA|United States)\.?$/i, '');
  s = s
    .split(' ')
    .map(word => {
      // Leave house numbers, zips, fractions ("1/2"), and "#106" tokens alone.
      if (/^\d/.test(word) || word.startsWith('#')) return word;
      const trailing = (word.match(/[.,]+$/) || [''])[0];
      const core = trailing ? word.slice(0, -trailing.length) : word;
      if (!core) return word;
      if (KEEP_UPPER.has(core.toUpperCase())) return core.toUpperCase() + trailing;
      return core[0].toUpperCase() + core.slice(1).toLowerCase() + trailing;
    })
    .join(' ');
  // Append the separate unit number to the street segment: "#127" lands
  // before the first comma so "12720 Burbank Blvd, Valley Village, CA"
  // becomes "12720 Burbank Blvd #127, Valley Village, CA".
  const u = unit == null ? '' : String(unit).trim().replace(/^#/, '');
  if (u) {
    const parts = s.split(',');
    parts[0] = `${parts[0]} #${u}`;
    s = parts.join(',');
  }
  return s;
}

// Best-effort neighborhood/city for compact lists ("12413 Sylvan St, Los
// Angeles CA 91606" → "Los Angeles"). Empty string when the address has no
// area segment to extract.
export function addressArea(raw) {
  if (!raw) return '';
  const parts = formatAddress(raw).split(',').map(p => p.trim());
  for (let i = 1; i < parts.length; i++) {
    const cleaned = parts[i]
      .replace(/\b(CA|California)\b\.?/gi, '')
      .replace(/\b\d{5}(-\d{4})?\b/g, '')
      .trim();
    if (cleaned) return cleaned;
  }
  return '';
}

export function formatNote(raw) {
  if (!raw) return raw;
  const s = raw.trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
