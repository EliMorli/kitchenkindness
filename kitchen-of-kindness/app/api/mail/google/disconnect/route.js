// Disconnect Gmail: tells Google to cancel the access, forgets it here, and
// turns mail checking Off.

import { adminStore, json, syncStatus } from '../../../../../lib/mail/api';
import { decryptToken, forgetAccessTokens, revoke } from '../../../../../lib/mail/google';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request) {
  const { store, response } = adminStore(request);
  if (response) return response;
  const g = await store.getGoogle();
  const token = g?.refresh_token_enc ? decryptToken(g.refresh_token_enc) : null;
  await store.saveGoogle({ email: '', refresh_token_enc: '', scope: '', connected_at: null });
  const settings = await store.updateSettings({ gmail_account: '', gmail_auth_error: '', mode: 'off' });
  forgetAccessTokens();
  if (token) await revoke(token);
  return json({ ok: true, sync: syncStatus(settings) });
}
