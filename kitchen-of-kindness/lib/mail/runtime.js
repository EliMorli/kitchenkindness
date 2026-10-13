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

export function mailConfig(env = process.env) {
  const fake = env.MAIL_FAKE === '1';
  return {
    fake,
    dryRun: !fake && env.MAIL_DRY_RUN === '1',
    user: String(env.GMAIL_USER || '').trim().toLowerCase(),
    hasGmail: fake || !!(env.GMAIL_USER && env.GMAIL_APP_PASSWORD),
    hasAi: fake || !!env.ANTHROPIC_API_KEY,
    hasDb: fake || !!(env.NEXT_PUBLIC_SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY)
  };
}

function fakeWorld() {
  globalThis.__kokMailFakeWorld ??= createFakeWorld({ mode: 'live' });
  return globalThis.__kokMailFakeWorld;
}

export function getMailStore() {
  if (mailConfig().fake) return fakeWorld().store;
  const admin = getSupabaseAdmin();
  return admin ? createStore(createSupabaseDb(admin)) : null;
}

export function getMailAdapters() {
  const cfg = mailConfig();
  if (cfg.fake) {
    const w = fakeWorld();
    return { gmail: w.gmail, smtp: w.smtp, ai: w.ai, selfEmail: w.selfEmail, dryRun: false };
  }
  const pass = process.env.GMAIL_APP_PASSWORD;
  return {
    gmail: createGmail({ user: cfg.user, pass }),
    smtp: createSmtp({ user: cfg.user, pass, dryRun: cfg.dryRun }),
    ai: process.env.ANTHROPIC_API_KEY ? createExtractor({ apiKey: process.env.ANTHROPIC_API_KEY }) : null,
    selfEmail: cfg.user,
    dryRun: cfg.dryRun
  };
}
