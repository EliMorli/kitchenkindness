// "Connect Gmail": sends the admin to Google's sign-in. The random state and
// the PKCE verifier wait in a short-lived cookie for the callback.

import { NextResponse } from 'next/server';
import { adminConfigured, isAdminRequest } from '../../../../../lib/adminSession';
import { OAUTH_COOKIE, authUrl, googleClient, newSignIn, redirectUri } from '../../../../../lib/mail/google';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request) {
  const back = reason => NextResponse.redirect(new URL(`/admin?mail=error&reason=${reason}`, request.url));
  if (!adminConfigured() || !isAdminRequest(request)) return back('login');
  const client = googleClient();
  if (!client) return back('not_configured');
  const s = newSignIn();
  const res = NextResponse.redirect(authUrl({ clientId: client.id, redirect: redirectUri(request), state: s.state, challenge: s.challenge }));
  res.cookies.set(OAUTH_COOKIE, `${s.state}.${s.verifier}`, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/api/mail/google',
    maxAge: 600
  });
  res.headers.set('Cache-Control', 'no-store');
  return res;
}
