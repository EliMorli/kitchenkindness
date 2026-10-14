import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessToken, authUrl, decryptToken, encryptToken, exchangeCode, GMAIL_SCOPE, newSignIn, parseIdToken } from './google.js';

const env = { ADMIN_SESSION_SECRET: 'test-secret' };
const idToken = claims => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;
const fakeFetch = body => async () => ({ ok: !body.error, status: body.error ? 400 : 200, json: async () => body });
const client = { id: 'cid', secret: 'cs' };

test('refresh token is sealed: round trip, tamper and wrong key fail', () => {
  const sealed = encryptToken('1//refresh', env);
  assert.notEqual(sealed, '1//refresh');
  assert.equal(decryptToken(sealed, env), '1//refresh');
  const [v, iv, data, tag] = sealed.split('.');
  assert.equal(decryptToken([v, iv, `${data.slice(0, -2)}AA`, tag].join('.'), env), null);
  assert.equal(decryptToken(sealed, { ADMIN_SESSION_SECRET: 'other' }), null);
  assert.equal(decryptToken('', env), null);
});

test('sign-in URL asks for Gmail, offline access and PKCE', () => {
  const s = newSignIn();
  const u = new URL(authUrl({ clientId: 'cid', redirect: 'https://x/cb', state: s.state, challenge: s.challenge }));
  assert.equal(u.searchParams.get('scope'), `${GMAIL_SCOPE} openid email`);
  assert.equal(u.searchParams.get('access_type'), 'offline');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('state'), s.state);
});

test('code exchange: email and Gmail permission are required', async () => {
  const ok = { refresh_token: 'r1', scope: `openid ${GMAIL_SCOPE} email`, id_token: idToken({ email: 'Kitchen@Gmail.com', email_verified: true }) };
  const a = await exchangeCode({ client, code: 'c', verifier: 'v', redirect: 'r', fetchImpl: fakeFetch(ok) });
  assert.deepEqual([a.email, a.refreshToken], ['kitchen@gmail.com', 'r1']);
  await assert.rejects(
    exchangeCode({ client, code: 'c', verifier: 'v', redirect: 'r', fetchImpl: fakeFetch({ ...ok, scope: 'openid email' }) }),
    { code: 'no_gmail_scope' }
  );
  await assert.rejects(exchangeCode({ client, code: 'c', verifier: 'v', redirect: 'r', fetchImpl: fakeFetch({ error: 'invalid_grant' }) }), {
    code: 'invalid_grant'
  });
  assert.deepEqual(parseIdToken('garbage'), {});
});

test('access tokens are reused until they are about to expire', async () => {
  let calls = 0;
  let t = 0;
  const fetchImpl = async () => ({ ok: true, json: async () => ({ access_token: `a${++calls}`, expires_in: 3600 }) });
  const get = () => accessToken({ client, refreshToken: 'r-cache', fetchImpl, now: () => t });
  assert.equal(await get(), 'a1');
  t += 30 * 60_000;
  assert.equal(await get(), 'a1');
  t += 31 * 60_000;
  assert.equal(await get(), 'a2');
});
