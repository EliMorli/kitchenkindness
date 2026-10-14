// "Sign in with Google" for the kitchen's Gmail (server only). The admin
// connects the account once; Google gives a refresh token, kept encrypted in
// the private mail_google table. Each mail check trades it for a short-lived
// access token, which IMAP and SMTP accept instead of a password (XOAUTH2).

import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

export const GMAIL_SCOPE = 'https://mail.google.com/';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
// Holds the sign-in's state and PKCE verifier between start and callback.
export const OAUTH_COOKIE = 'kok_mail_oauth';

export const googleClient = (env = process.env) =>
  env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? { id: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET } : null;

export const redirectUri = (request, env = process.env) =>
  env.GOOGLE_REDIRECT_URI || `${new URL(request.url).origin}/api/mail/google/callback`;

export class GoogleAuthError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

const b64url = buf => Buffer.from(buf).toString('base64url');

// PKCE + state for one sign-in.
export function newSignIn() {
  const verifier = b64url(randomBytes(32));
  return { state: b64url(randomBytes(24)), verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
}

export function authUrl({ clientId, redirect, state, challenge }) {
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect,
    response_type: 'code',
    scope: `${GMAIL_SCOPE} openid email`,
    access_type: 'offline',
    prompt: 'consent', // always hand out a refresh token
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256'
  });
  return `${AUTH_URL}?${p}`;
}

async function tokenRequest(params, fetchImpl = fetch) {
  let res;
  try {
    res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(15_000)
    });
  } catch {
    throw new GoogleAuthError('network', 'Could not reach Google. Try again.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new GoogleAuthError(data.error || `http_${res.status}`, data.error_description || 'Google refused the request.');
  return data;
}

// The id_token comes straight from Google's token endpoint over TLS, so its
// claims can be read without checking the signature (OpenID Connect 3.1.3.7).
export function parseIdToken(idToken) {
  try {
    return JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

// Code -> { email, refreshToken, scope }. Throws GoogleAuthError.
export async function exchangeCode({ client, code, verifier, redirect, fetchImpl }) {
  const t = await tokenRequest(
    { code, client_id: client.id, client_secret: client.secret, redirect_uri: redirect, grant_type: 'authorization_code', code_verifier: verifier },
    fetchImpl
  );
  const claims = parseIdToken(t.id_token);
  const email = String(claims.email || '').trim().toLowerCase();
  if (!email || claims.email_verified === false) throw new GoogleAuthError('no_email', 'Google didn’t share the account’s email address.');
  // Google's consent screen lets people untick the Gmail box.
  if (!String(t.scope || '').split(/\s+/).includes(GMAIL_SCOPE)) {
    throw new GoogleAuthError('no_gmail_scope', 'Gmail access wasn’t allowed. Connect again and tick the Gmail box.');
  }
  if (!t.refresh_token) throw new GoogleAuthError('no_refresh_token', 'Google didn’t give lasting access. Connect again.');
  return { email, refreshToken: t.refresh_token, scope: t.scope };
}

// Access tokens last an hour; reuse one until a minute before it ends.
const cache = new Map();
export async function accessToken({ client, refreshToken, fetchImpl, now = () => Date.now() }) {
  const key = createHash('sha256').update(refreshToken).digest('hex');
  const hit = cache.get(key);
  if (hit && hit.until > now()) return hit.token;
  const t = await tokenRequest(
    { client_id: client.id, client_secret: client.secret, refresh_token: refreshToken, grant_type: 'refresh_token' },
    fetchImpl
  );
  cache.set(key, { token: t.access_token, until: now() + Math.max(0, (t.expires_in || 3600) - 60) * 1000 });
  return t.access_token;
}
export const forgetAccessTokens = () => cache.clear();

export async function revoke(refreshToken, fetchImpl = fetch) {
  try {
    await fetchImpl(REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refreshToken }),
      signal: AbortSignal.timeout(10_000)
    });
  } catch {
    // Best effort: the token is deleted on our side either way.
  }
}

// AES-256-GCM with a key derived from ADMIN_SESSION_SECRET (changing that
// secret means connecting Gmail again).
function key(env) {
  const secret = env.ADMIN_SESSION_SECRET;
  if (!secret) throw new GoogleAuthError('not_configured', 'ADMIN_SESSION_SECRET is not set.');
  return Buffer.from(hkdfSync('sha256', secret, 'kok-mail', 'google-refresh-token', 32));
}

export function encryptToken(plain, env = process.env) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(env), iv);
  const data = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `v1.${b64url(iv)}.${b64url(data)}.${b64url(c.getAuthTag())}`;
}

export function decryptToken(sealed, env = process.env) {
  const [v, iv, data, tag] = String(sealed || '').split('.');
  if (v !== 'v1' || !iv || !data || !tag) return null;
  try {
    const d = createDecipheriv('aes-256-gcm', key(env), Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}
