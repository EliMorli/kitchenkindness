import { NextResponse } from 'next/server';
import {
  SESSION_COOKIE, adminConfigured, checkPassword, isAdminRequest, jsonError, sameOrigin,
  sessionCookieOptions, signSession
} from '../../../../lib/adminSession';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const noStore = { 'Cache-Control': 'no-store' };

// Log in: { password } -> sets the httpOnly session cookie.
export async function POST(request) {
  if (!adminConfigured()) return jsonError(503, 'not_configured', 'Admin login is not set up on the server yet.');
  if (!sameOrigin(request)) return jsonError(403, 'forbidden', 'Request not allowed.');
  let password = '';
  try {
    ({ password } = await request.json());
  } catch {
    // fall through: empty password fails below
  }
  if (!checkPassword(password)) {
    await new Promise(r => setTimeout(r, 800)); // slow down guessing
    return jsonError(401, 'wrong_password', 'Incorrect admin password.');
  }
  const res = NextResponse.json({ ok: true }, { headers: noStore });
  res.cookies.set(SESSION_COOKIE, signSession(), sessionCookieOptions());
  return res;
}

// Is this browser logged in on the server?
export async function GET(request) {
  return NextResponse.json(
    { configured: adminConfigured(), authenticated: isAdminRequest(request) },
    { headers: noStore }
  );
}

// Log out (the Mail tab's "Lock" button).
export async function DELETE(request) {
  if (!sameOrigin(request)) return jsonError(403, 'forbidden', 'Request not allowed.');
  const res = NextResponse.json({ ok: true }, { headers: noStore });
  res.cookies.set(SESSION_COOKIE, '', { ...sessionCookieOptions(), maxAge: 0 });
  return res;
}
