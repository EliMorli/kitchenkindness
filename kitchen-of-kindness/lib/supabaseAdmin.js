// Server-only Supabase client with the service role key. It bypasses RLS, so
// it is used only inside API routes (never in 'use client' code). The key is
// not NEXT_PUBLIC_, so Next never ships it to the browser.

import { createClient } from '@supabase/supabase-js';

let cached = null;

export function getSupabaseAdmin() {
  if (cached) return cached;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  cached = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return cached;
}
