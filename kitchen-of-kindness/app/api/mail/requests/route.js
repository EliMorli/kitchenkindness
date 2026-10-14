// The admin's mail queue: one view (pending / approved / declined / other /
// attention) plus counts and the last sync status.

import { adminStore, json, publicRequest, syncStatus } from '../../../../lib/mail/api';
import { accountEmail } from '../../../../lib/mail/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VIEWS = ['pending', 'approved', 'declined', 'other', 'attention'];

export async function GET(request) {
  const { store, response } = adminStore(request);
  if (response) return response;
  const view = new URL(request.url).searchParams.get('view') || 'pending';
  if (view === 'counts') {
    const [counts, settings] = await Promise.all([store.counts(), store.getSettings()]);
    return json({ counts, sync: syncStatus(settings) });
  }
  if (!VIEWS.includes(view)) return json({ error: 'bad_view' }, 400);
  const [items, counts, settings] = await Promise.all([store.listForAdmin(view), store.counts(), store.getSettings()]);
  // Pending and attention cards show the emails; the other lists don't need them.
  const withBodies = view === 'pending' || view === 'attention' || view === 'other';
  const messages = withBodies ? await store.messagesForMany(items.map(r => r.id)) : [];
  const byRequest = new Map();
  for (const m of messages) {
    if (!byRequest.has(m.request_id)) byRequest.set(m.request_id, []);
    byRequest.get(m.request_id).push(m);
  }
  return json({
    view,
    items: items.map(r => publicRequest(r, withBodies ? byRequest.get(r.id) || [] : null, accountEmail(settings))),
    counts,
    sync: syncStatus(settings)
  });
}
