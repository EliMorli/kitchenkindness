import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPassword, readCookie, requireAdmin, sameOrigin, signSession, verifySession } from './adminSession.js';

const env = { ADMIN_PASSWORD: 'correct horse', ADMIN_SESSION_SECRET: 'x'.repeat(40), NODE_ENV: 'test' };
const req = (method, headers = {}) => new Request('https://kitchen.example/api/mail/requests', { method, headers });

test('password check', () => {
  assert.ok(checkPassword('correct horse', env));
  assert.ok(!checkPassword('correct horse ', env));
  assert.ok(!checkPassword('', env));
  assert.ok(!checkPassword('x', { ...env, ADMIN_PASSWORD: '' }));
});

test('session tokens: valid, tampered, expired, password changed', () => {
  const now = 1_800_000_000_000;
  const token = signSession(now, env);
  assert.ok(verifySession(token, now + 1000, env));
  assert.ok(!verifySession(token.slice(0, -2) + 'AA', now, env));
  assert.ok(!verifySession(token.replace(/^v1\.(\d+)/, (m, d) => `v1.${Number(d) + 1}`), now, env));
  assert.ok(!verifySession(token, now + 31 * 86_400_000, env));
  assert.ok(!verifySession(token, now, { ...env, ADMIN_PASSWORD: 'new password' }));
  assert.ok(!verifySession('garbage', now, env));
});

test('requireAdmin: cookie and same-origin checks', () => {
  const token = signSession(Date.now(), env);
  const cookie = `other=1; kok_admin=${token}`;
  assert.equal(readCookie(req('GET', { cookie })), token);
  assert.equal(requireAdmin(req('GET', { cookie }), env), null);
  assert.equal(requireAdmin(req('GET'), env).status, 401);
  assert.equal(requireAdmin(req('POST', { cookie, origin: 'https://evil.example' }), env).status, 403);
  assert.equal(requireAdmin(req('POST', { cookie, origin: 'https://kitchen.example' }), env), null);
  assert.equal(requireAdmin(req('GET'), { ...env, ADMIN_PASSWORD: '' }).status, 503);
  assert.ok(!sameOrigin(req('POST', { 'sec-fetch-site': 'cross-site' })));
});
