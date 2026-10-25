// Google sends the admin back here after "Connect Gmail". Saves the account
// (refresh token encrypted, in the private mail_google table) and returns to
// the admin page. Connecting a different account than before turns mail
// checking Off and starts that inbox fresh, so a personal inbox connected by
// mistake is never answered from.

import { NextResponse } from 'next/server';
import { adminConfigured, isAdminRequest, readCookie } from '../../../../../lib/adminSession';
import {
  OAUTH_COOKIE, decryptToken, encryptToken, exchangeCode, forgetAccessTokens, googleClient, redirectUri, revoke
} from '../../../../../lib/mail/google';
import { getMailStore, mailConfig } from '../../../../../lib/mail/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request) {
  const url = new URL(request.url);
  const back = query => {
    const res = NextResponse.redirect(new URL(`/admin?${query}`, request.url));
    res.cookies.set(OAUTH_COOKIE, '', { path: '/api/mail/google', maxAge: 0 });
    res.headers.set('Cache-Control', 'no-store');
    return res;
  };
  const fail = reason => back(`mail=error&reason=${encodeURIComponent(reason)}`);
  if (!adminConfigured() || !isAdminRequest(request)) return fail('login');
  if (url.searchParams.get('error')) return fail(url.searchParams.get('error') === 'access_denied' ? 'denied' : 'google');
  const [state, verifier] = String(readCookie(request, OAUTH_COOKIE) || '').split('.');
  if (!state || !verifier || state !== url.searchParams.get('state')) return fail('expired');
  const client = googleClient();
  if (!client) return fail('not_configured');
  const store = getMailStore();
  if (!store) return fail('no_db');

  let account;
  try {
    account = await exchangeCode({ client, code: url.searchParams.get('code'), verifier, redirect: redirectUri(request) });
  } catch (err) {
    return fail(err.code || 'google');
  }
  const settings = await store.getSettings();
  const previous = settings?.gmail_account || mailConfig().user;
  const old = await store.getGoogle();
  const oldToken = old?.refresh_token_enc ? decryptToken(old.refresh_token_enc) : null;
  await store.saveGoogle({
    email: account.email,
    refresh_token_enc: encryptToken(account.refreshToken),
    scope: account.scope,
    connected_at: new Date().toISOString()
  });
  const switched = !!previous && previous !== account.email;
  await store.updateSettings({
    gmail_account: account.email,
    gmail_auth_error: '',
    last_sync_error: '',
    ...(switched
      ? { mode: 'off', inbox_uidvalidity: null, inbox_last_uid: null, inbox_fail_uid: null, inbox_fail_count: 0, inbox_fail_since: null, labels_ready: false }
      : {})
  });
  forgetAccessTokens();
  if (oldToken && oldToken !== account.refreshToken) await revoke(oldToken);
  return back(`mail=connected${switched ? '&switched=1' : ''}`);
}
