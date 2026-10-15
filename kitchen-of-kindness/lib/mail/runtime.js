// Builds the real or fake mail parts for the API routes.
//   MAIL_FAKE=1     fake inbox + in-memory database (local testing; nothing real)
//   MAIL_DRY_RUN=1  reads real mail and writes summaries, but never sends or
//                   changes Gmail (queued emails stay queued for the real sync)

import { getSupabaseAdmin } from '../supabaseAdmin.js';
import { createSupabaseDb } from './db.js';
import { createStore } from './store.js';
import { createGmail } from './gmail.js';
import { createSmtp } from './smtp.js';
import { createExtractor } from './extract.js';
import { createFakeWorld } from './fakes.js';
import { accessToken, decryptToken, googleClient } from './google.js';

export const RECONNECT = 'Gmail was disconnected (password changed or access removed). Connect it again in Mail → Settings.';

// user / hasPassword: the older app-password setup (GMAIL_USER +
// GMAIL_APP_PASSWORD), still used when no Google account is connected.
export function mailConfig(env = process.env) {
  const fake = env.MAIL_FAKE === '1';
  return {
    fake,
    dryRun: !fake && env.MAIL_DRY_RUN === '1',
    user: fake ? 'kitchen@example.org' : String(env.GMAIL_USER || '').trim().toLowerCase(),
    hasPassword: !!(env.GMAIL_USER && env.GMAIL_APP_PASSWORD),
    hasGoogleClient: !!googleClient(env),
    hasAi: fake || !!env.ANTHROPIC_API_KEY,
    hasDb: fake || !!(env.NEXT_PUBLIC_SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY)
  };
}

// The connected Gmail address (or the app-password one), for links and
// status. Not a check that it still works.
export const accountEmail = settings => settings?.gmail_account || mailConfig().user;
export const hasGmail = settings => mailConfig().fake || !!settings?.gmail_account || mailConfig().hasPassword;

function fakeWorld() {
  globalThis.__kokMailFakeWorld ??= createFakeWorld({ mode: 'live' });
  return globalThis.__kokMailFakeWorld;
}

export function getMailStore() {
  if (mailConfig().fake) return fakeWorld().store;
  const admin = getSupabaseAdmin();
  return admin ? createStore(createSupabaseDb(admin)) : null;
}

// How to log in to Gmail: the Google account connected in Settings (an
// access token from its refresh token), else the app password. Returns
// { user, accessToken } | { user, pass } | { error }.
async function mailLogin(store, settings) {
  const cfg = mailConfig();
  const g = settings?.gmail_account ? await store.getGoogle() : null;
  if (g?.refresh_token_enc) {
    const client = googleClient();
    if (!client) return { error: 'Google sign-in isn’t set up (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in Vercel).' };
    const refreshToken = decryptToken(g.refresh_token_enc);
    if (!refreshToken) return { error: 'Gmail needs to be connected again (Mail → Settings).' };
    try {
      return { user: g.email, accessToken: await accessToken({ client, refreshToken }) };
    } catch (err) {
      if (err.code === 'invalid_grant') {
        await store.updateSettings({ gmail_auth_error: RECONNECT });
        return { error: RECONNECT };
      }
      return { error: err.message || 'Could not reach Google. It will try again.' };
    }
  }
  if (cfg.hasPassword) return { user: cfg.user, pass: process.env.GMAIL_APP_PASSWORD };
  return { error: 'Gmail isn’t connected yet. Connect it in Mail → Settings.' };
}

// The Gmail, SMTP and Claude parts for a sync or a test email, or { error }.
export async function getMailAdapters(store) {
  const cfg = mailConfig();
  if (cfg.fake) {
    const w = fakeWorld();
    return { gmail: w.gmail, smtp: w.smtp, ai: w.ai, selfEmail: w.selfEmail, dryRun: false, user: w.selfEmail };
  }
  const login = await mailLogin(store, await store.getSettings());
  if (login.error) return { error: login.error };
  const auth = login.accessToken ? { accessToken: login.accessToken } : { pass: login.pass };
  return {
    gmail: createGmail({ user: login.user, ...auth }),
    smtp: createSmtp({ user: login.user, ...auth, dryRun: cfg.dryRun }),
    ai: process.env.ANTHROPIC_API_KEY ? createExtractor({ apiKey: process.env.ANTHROPIC_API_KEY }) : null,
    selfEmail: login.user,
    dryRun: cfg.dryRun,
    user: login.user
  };
}
