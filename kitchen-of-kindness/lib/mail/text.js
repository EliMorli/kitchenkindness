// Text safe for Postgres: no NUL or other control characters (except tab and
// newline) and no half emoji (lone surrogates). Postgres rejects both, and one
// such email would otherwise block the inbox. Cuts by characters, not UTF-16
// units, so an emoji at the cut is never split. No dependencies (also used in
// the browser).
export function dbText(value, max = Infinity) {
  let t = String(value ?? '')
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  t = typeof t.toWellFormed === 'function' ? t.toWellFormed() : t;
  if (t.length > max) t = Array.from(t).slice(0, max).join('');
  return t;
}
