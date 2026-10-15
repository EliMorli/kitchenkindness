// Server-side admin session for the API routes (the Mail tab).
//
// The password lives only on the server (ADMIN_PASSWORD). Logging in sets an
// httpOnly cookie signed with ADMIN_SESSION_SECRET; the token also binds a hash
// of the password, so changing the password logs every browser out.
// Plain node:crypto, no Next imports, so it can be unit-tested.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'kok_admin';
export const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60;

const sha256 = s => createHash('sha256').update(String(s)).digest();
const passwordTag = pw => sha256(pw).toString('hex').slice(0, 16);
const mac = (env, exp) =>
  createHmac('sha256', env.ADMIN_SESSION_SECRET).update(`v1.${exp}.${passwordTag(env.ADMIN_PASSWORD)}`).digest();

export const adminConfigured = (env = process.env) => !!(env.ADMIN_PASSWORD && env.ADMIN_SESSION_SECRET);

export function checkPassword(input, env = process.env) {
  if (!env.ADMIN_PASSWORD || typeof input !== 'string' || !input) return false;
  return timingSafeEqual(sha256(input), sha256(env.ADMIN_PASSWORD));
}

export function signSession(now = Date.now(), env = process.env) {
  const exp = now + SESSION_MAX_AGE_S * 1000;
  return `v1.${exp}.${mac(env, exp).toString('base64url')}`;
}

export function verifySession(token, now = Date.now(), env = process.env) {
  if (!adminConfigured(env) || typeof token !== 'string') return false;
  const m = /^v1\.(\d{10,16})\.([A-Za-z0-9_-]{20,64})$/.exec(token);
  if (!m) return false;
  const exp = Number(m[1]);
  if (!(exp > now)) return false;
  const expected = mac(env, exp);
  const got = Buffer.from(m[2], 'base64url');
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export function readCookie(request, name = SESSION_COOKIE) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

// Requests that change something must come from this site (CSRF guard).
export function sameOrigin(request) {
  if (request.headers.get('sec-fetch-site') === 'cross-site') return false;
  const origin = request.headers.get('origin');
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(request.url).host || new URL(origin).host === request.headers.get('host');
  } catch {
    return false;
  }
}

export const isAdminRequest = (request, env = process.env) => verifySession(readCookie(request), Date.now(), env);

// Returns null when allowed, or a Response to send back.
export function requireAdmin(request, env = process.env) {
  if (!adminConfigured(env)) return jsonError(503, 'not_configured', 'Admin login is not set up on the server yet.');
  if (!isAdminRequest(request, env)) return jsonError(401, 'unauthorized', 'Please log in again.');
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && !sameOrigin(request)) {
    return jsonError(403, 'forbidden', 'Request not allowed.');
  }
  return null;
}

export function jsonError(status, code, message) {
  return new Response(JSON.stringify({ error: code, message }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

export function sessionCookieOptions(env = process.env) {
  return {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/api',
    maxAge: SESSION_MAX_AGE_S
  };
}
