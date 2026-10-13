'use client';

// The admin's Mail tab: emails to the kitchen's Gmail, summarized by Claude,
// as a queue of requests. Yes adds the family (and sends the approval email
// on the next sync); No files it. Both wait 5 seconds so they can be undone.
// Keys: Y = yes, Shift+Y = yes without the email, N = no, J/K = next/previous.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loginAdmin, logoutAdminServer, serverSession } from '../../lib/adminLogin';
import { DAYS } from '../../lib/mail/config';
import { familyDraft, validateFamilyPayload } from '../../lib/mail/fields';
import { findPossibleDuplicates } from '../../lib/mail/dupes';
import { geocodeUS, geocoderAvailable } from '../../lib/geocode';
import { isPickup } from '../../lib/groups';

const VIEWS = [
  { key: 'pending', label: 'Pending' },
  { key: 'attention', label: 'Needs attention' },
  { key: 'approved', label: 'Approved' },
  { key: 'declined', label: 'Declined' },
  { key: 'other', label: 'Other' }
];
const UNDO_MS = 5000;
const IDLE_SYNC_MS = 15000;
const POLL_MS = 60000;
const INSTRUCTION_OPTIONS = ['Leave at door', 'Ring doorbell', 'Call when arrive', 'Hand to resident'];
const MISSING_LABEL = { address: 'No address', phone: 'No phone', people_count: 'No household size' };
const TOPIC_LABEL = {
  volunteering: 'Volunteering', donation: 'Donation', question: 'Question', thanks: 'Thanks',
  update_existing: 'Update from a family', vendor_or_newsletter: 'Vendor / newsletter', spam: 'Spam', other: 'Other', none: ''
};

async function api(path, opts = {}) {
  try {
    const res = await fetch(path, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: { message: 'No connection. Check the internet and try again.' } };
  }
}

function timeAgo(iso) {
  if (!iso) return '';
  const t = new Date(iso);
  const mins = Math.round((Date.now() - t.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 24 * 60) return `${Math.round(mins / 60)} h ago`;
  return t.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

const typingIn = el =>
  !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));

export default function MailTab({ families = [], onFamiliesChanged, googleReady = false, onCounts }) {
  const [session, setSession] = useState('checking'); // checking | login | ready | not_configured
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [view, setView] = useState('pending');
  const [items, setItems] = useState([]);
  const [counts, setCounts] = useState({});
  const [sync, setSync] = useState(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [banner, setBanner] = useState('');
  const [focusId, setFocusId] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [cardErrors, setCardErrors] = useState({});
  const [geo, setGeo] = useState({});
  const [queue, setQueue] = useState([]);
  const [hidden, setHidden] = useState(() => new Set());
  const [toast, setToast] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showEmail, setShowEmail] = useState({});
  const timers = useRef(new Map());
  const entries = useRef(new Map());
  const idleTimer = useRef(null);
  const toastTimer = useRef(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  // The parent passes new callback functions on every render; keep the latest
  // in refs so they don't restart the loading effects.
  const onCountsRef = useRef(onCounts);
  onCountsRef.current = onCounts;
  const onFamiliesChangedRef = useRef(onFamiliesChanged);
  onFamiliesChangedRef.current = onFamiliesChanged;

  const showToast = useCallback((text, kind = 'ok', undoKey = null) => {
    clearTimeout(toastTimer.current);
    setToast({ text, kind, undoKey });
    toastTimer.current = setTimeout(() => setToast(null), undoKey ? UNDO_MS + 300 : 4000);
  }, []);

  // ---------- loading ----------
  const load = useCallback(
    async (v = viewRef.current) => {
      const r = await api(`/api/mail/requests?view=${v}`);
      setLoading(false);
      if (r.status === 401) {
        setSession('login');
        return;
      }
      if (!r.ok) {
        setBanner(r.data?.message || 'Could not load the mail.');
        return;
      }
      if (v !== viewRef.current) return;
      setBanner('');
      const ids = new Set(r.data.items.map(it => it.id));
      const waiting = new Set([...entries.current.values()].map(e => e.id));
      setHidden(h => new Set([...h].filter(id => waiting.has(id) || ids.has(id))));
      setItems(r.data.items);
      setCounts(r.data.counts);
      setSync(r.data.sync);
      onCountsRef.current?.(r.data.counts);
    },
    []
  );

  const runSync = useCallback(
    async quiet => {
      setSyncing(true);
      const r = await api('/api/mail/sync', { method: 'POST' });
      setSyncing(false);
      if (!quiet) {
        if (!r.ok) setBanner(r.data?.message || 'The mail check failed.');
        else if (r.data?.locked) showToast('Already checking mail. Try again in a moment.', 'info');
        else if (r.data?.skipped === 'off') showToast('Mail checking is off. Turn it on in Settings.', 'info');
        else {
          const n = r.data?.read || 0;
          showToast(n ? `${n} new email${n === 1 ? '' : 's'}` : 'No new email', 'ok');
        }
      }
      await load();
      return r;
    },
    [load, showToast]
  );

  useEffect(() => {
    (async () => {
      const s = await serverSession();
      if (!s.configured) setSession('not_configured');
      else setSession(s.authenticated ? 'ready' : 'login');
    })();
  }, []);

  useEffect(() => {
    if (session !== 'ready') return;
    setLoading(true);
    load(view);
  }, [session, view, load]);

  // Check Gmail once when the tab opens.
  useEffect(() => {
    if (session === 'ready') runSync(true);
  }, [session]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (session !== 'ready') return undefined;
    const id = setInterval(() => {
      if (document.visibilityState === 'visible' && entries.current.size === 0) load();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [session, load]);

  // Drafts (the editable family form) start from Claude's fields; rebuilt
  // when the summary changes unless the admin already edited them.
  useEffect(() => {
    setDrafts(prev => {
      const next = { ...prev };
      for (const it of items) {
        if (it.status !== 'pending' && it.status !== 'new' && it.status !== 'other') continue;
        const have = prev[it.id];
        if (!have || (!have.edited && have.aiAt !== it.ai_at)) {
          next[it.id] = { ...familyDraft(it.ai_fields), edited: false, aiAt: it.ai_at };
        }
      }
      return next;
    });
    setGeo(prev => {
      const next = { ...prev };
      for (const it of items) if (it.geo && !next[it.id]) next[it.id] = it.geo;
      return next;
    });
  }, [items]);

  const visible = useMemo(
    () => (view === 'pending' ? items.filter(it => !hidden.has(it.id)) : items),
    [items, hidden, view]
  );

  useEffect(() => {
    if (view !== 'pending') return;
    if (!visible.some(it => it.id === focusId)) setFocusId(visible[0]?.id ?? null);
  }, [visible, focusId, view]);

  // ---------- map check ----------
  const lookup = useCallback(
    async (id, address) => {
      const text = String(address || '').trim();
      if (!text || isPickup({ address: text }) || !geocoderAvailable()) return;
      setGeo(g => ({ ...g, [id]: { address: text, status: 'looking' } }));
      const top = await geocodeUS(text);
      const result = top
        ? { address: text, status: 'found', formatted_address: top.formatted_address, lat: top.lat, lng: top.lng }
        : { address: text, status: 'not_found' };
      setGeo(g => (g[id]?.address === text ? { ...g, [id]: result } : g));
      api(`/api/mail/requests/${id}`, { method: 'POST', body: JSON.stringify({ action: 'save_geo', geo: result }) });
    },
    []
  );

  // Look up the focused card and the next two before they are needed.
  useEffect(() => {
    if (view !== 'pending' || !googleReady) return;
    const start = visible.findIndex(it => it.id === focusId);
    if (start < 0) return;
    for (const it of visible.slice(start, start + 3)) {
      const d = drafts[it.id];
      const g = geo[it.id];
      if (d?.address?.trim() && (!g || g.address !== d.address.trim())) lookup(it.id, d.address);
    }
  }, [focusId, visible, drafts, geo, googleReady, view, lookup]);

  // ---------- decisions (5 s undo) ----------
  const scheduleIdleSync = useCallback(() => {
    clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(async () => {
      if (entries.current.size) return scheduleIdleSync();
      await runSync(true);
      onFamiliesChangedRef.current?.();
    }, IDLE_SYNC_MS);
  }, [runSync]);

  const commit = useCallback(
    async entry => {
      entries.current.delete(entry.key);
      timers.current.delete(entry.key);
      setQueue(q => q.filter(x => x.key !== entry.key));
      const body =
        entry.kind === 'approve'
          ? { action: 'approve', family: entry.family, sendEmail: entry.sendEmail }
          : { action: 'decline' };
      const r = await api(`/api/mail/requests/${entry.id}`, { method: 'POST', body: JSON.stringify(body) });
      if (!r.ok) {
        setHidden(h => {
          const n = new Set(h);
          n.delete(entry.id);
          return n;
        });
        setCardErrors(e => ({ ...e, [entry.id]: r.data?.errors || [r.data?.message || 'Could not save. Try again.'] }));
        showToast(`Couldn’t ${entry.kind === 'approve' ? 'add the family' : 'decline'}. The request is back in the list.`, 'warn');
        return;
      }
      if (r.data?.shadow) showToast('Shadow mode: nothing was added (this is a practice run).', 'info');
      else if (entry.kind === 'approve' && r.data?.family_id) {
        showToast(`Family #${r.data.family_id} added${entry.sendEmail ? ' · approval email goes out shortly' : ''}`, 'ok');
      }
      setCounts(c => {
        const next = { ...c, pending: Math.max(0, (c.pending || 0) - 1) };
        const key = entry.kind === 'approve' ? 'approved' : 'declined';
        next[key] = (c[key] || 0) + (r.data?.shadow ? 0 : 1);
        return next;
      });
      scheduleIdleSync();
    },
    [scheduleIdleSync, showToast]
  );

  const enqueue = useCallback(
    (item, kind, extra = {}) => {
      const key = `${item.id}-${Date.now()}`;
      const entry = { key, id: item.id, kind, ...extra };
      entries.current.set(key, entry);
      setQueue(q => [...q, entry]);
      setHidden(h => new Set(h).add(item.id));
      const idx = visible.findIndex(it => it.id === item.id);
      const nextItem = visible[idx + 1] || visible[idx - 1] || null;
      setFocusId(nextItem ? nextItem.id : null);
      timers.current.set(key, setTimeout(() => commit(entry), UNDO_MS));
      const who = item.from_name || item.from_email;
      showToast(kind === 'approve' ? `Adding ${who}…` : `Declined ${who}`, 'ok', key);
    },
    [visible, commit, showToast]
  );

  const undo = useCallback(key => {
    const entry = entries.current.get(key);
    if (!entry) return;
    clearTimeout(timers.current.get(key));
    timers.current.delete(key);
    entries.current.delete(key);
    setQueue(q => q.filter(x => x.key !== key));
    setHidden(h => {
      const n = new Set(h);
      n.delete(entry.id);
      return n;
    });
    setFocusId(entry.id);
    setToast(null);
  }, []);

  // Leaving the tab: send whatever is still waiting rather than dropping it.
  useEffect(
    () => () => {
      for (const [key, t] of timers.current) {
        clearTimeout(t);
        const entry = entries.current.get(key);
        if (entry) commit(entry);
      }
      clearTimeout(idleTimer.current);
      clearTimeout(toastTimer.current);
    },
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );

  useEffect(() => {
    if (!queue.length) return undefined;
    const warn = e => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [queue.length]);

  const approve = useCallback(
    (item, sendEmail = true) => {
      const d = drafts[item.id];
      if (!d) return;
      const g = geo[item.id];
      const onMap = g?.status === 'found' && g.address === d.address.trim();
      const family = {
        ...d,
        people_count: Number(d.people_count),
        latitude: onMap ? g.lat : null,
        longitude: onMap ? g.lng : null
      };
      const v = validateFamilyPayload(family, { names: [item.from_name, item.ai_fields?.requester_name] });
      if (!v.ok) {
        setCardErrors(e => ({ ...e, [item.id]: v.errors }));
        setFocusId(item.id);
        return;
      }
      setCardErrors(e => ({ ...e, [item.id]: null }));
      enqueue(item, 'approve', { family: v.family, sendEmail });
    },
    [drafts, geo, enqueue]
  );

  const decline = useCallback(item => enqueue(item, 'decline'), [enqueue]);

  // Immediate actions (no undo needed).
  const act = async (item, body, okText) => {
    const r = await api(`/api/mail/requests/${item.id}`, { method: 'POST', body: JSON.stringify(body) });
    if (!r.ok) showToast(r.data?.message || 'Could not save. Try again.', 'warn');
    else if (okText) showToast(okText, 'ok');
    load();
    scheduleIdleSync();
  };

  // ---------- keyboard ----------
  useEffect(() => {
    if (session !== 'ready' || view !== 'pending') return undefined;
    const onKey = e => {
      if (typingIn(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const idx = visible.findIndex(it => it.id === focusId);
      const item = visible[idx];
      const key = e.key.toLowerCase();
      if (key === 'j' || e.key === 'ArrowDown') {
        if (visible[idx + 1]) setFocusId(visible[idx + 1].id);
      } else if (key === 'k' || e.key === 'ArrowUp') {
        if (idx > 0) setFocusId(visible[idx - 1].id);
      } else if (key === 'y' && item) {
        approve(item, !e.shiftKey);
      } else if (key === 'n' && item) {
        decline(item);
      } else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [session, view, visible, focusId, approve, decline]);

  const editDraft = (id, patch) =>
    setDrafts(d => ({ ...d, [id]: { ...d[id], ...patch, edited: true } }));

  // ---------- render ----------
  if (session === 'checking') return <div className="mail-empty">Loading mail…</div>;
  if (session === 'not_configured') {
    return (
      <div className="mail-setup">
        <h3>Mail isn’t set up yet</h3>
        <p>
          The server password for the admin hasn’t been added. In Vercel → Settings → Environment Variables, add{' '}
          <code>ADMIN_PASSWORD</code> and <code>ADMIN_SESSION_SECRET</code>, then redeploy. The README’s Mail section has
          every step.
        </p>
      </div>
    );
  }
  if (session === 'login') {
    return (
      <form
        className="mail-login"
        onSubmit={async e => {
          e.preventDefault();
          const r = await loginAdmin(password);
          if (r.ok && !r.legacy) {
            setPassword('');
            setLoginError('');
            setSession('ready');
          } else setLoginError(r.ok ? 'Mail needs the new server password.' : r.error);
        }}
      >
        <h3>🔒 Mail</h3>
        <p>The emails include people’s private details, so Mail asks for the admin password on each device.</p>
        <input type="password" placeholder="Admin password" value={password} onChange={e => setPassword(e.target.value)} autoFocus />
        <button type="submit" className="mail-btn primary">Open Mail</button>
        {loginError && <p className="password-error">{loginError}</p>}
      </form>
    );
  }

  const notices = [];
  if (sync?.fake) notices.push(['info', 'Test mode: a fake inbox, nothing real is read or sent.']);
  if (sync && !sync.has_gmail) notices.push(['warn', 'Gmail isn’t connected yet (GMAIL_USER and GMAIL_APP_PASSWORD in Vercel).']);
  if (sync && !sync.has_ai) notices.push(['warn', 'Summaries are off until ANTHROPIC_API_KEY is set in Vercel.']);
  if (sync?.mode === 'off') notices.push(['info', 'Mail checking is off. Turn it on in ⚙ Settings (start with Shadow to try it safely).']);
  if (sync?.mode === 'shadow') {
    notices.push(['info', 'Shadow mode: reading and summarizing only. Nothing is sent, Gmail isn’t changed, and Yes doesn’t add families.']);
  }
  if (sync?.last_sync_error) notices.push(['error', sync.last_sync_error]);
  if (banner) notices.push(['error', banner]);

  return (
    <section className="mail-tab">
      <div className="mail-head">
        <div className="mail-chips" role="tablist">
          {VIEWS.map(v => (
            <button
              key={v.key}
              type="button"
              role="tab"
              aria-selected={view === v.key}
              className={`mail-chip ${view === v.key ? 'active' : ''} ${v.key === 'attention' && counts.attention ? 'alert' : ''}`}
              onClick={() => {
                setLoading(true);
                setView(v.key);
              }}
            >
              {v.label}
              <span className="mail-chip-count">{counts[v.key] ?? 0}</span>
            </button>
          ))}
        </div>
        <div className="mail-tools">
          <span className="mail-synced">{sync?.last_sync_at ? `Checked ${timeAgo(sync.last_sync_at)}` : 'Not checked yet'}</span>
          <button type="button" className="mail-btn" onClick={() => runSync(false)} disabled={syncing}>
            {syncing ? 'Checking…' : '↻ Check now'}
          </button>
          <button type="button" className="mail-btn" onClick={() => setSettingsOpen(o => !o)}>
            ⚙ Settings
          </button>
          <button
            type="button"
            className="mail-btn"
            title="Lock Mail on this device"
            onClick={async () => {
              await logoutAdminServer();
              setSession('login');
            }}
          >
            🔒
          </button>
        </div>
      </div>

      {notices.map(([kind, text], i) => (
        <div key={i} className={`mail-notice ${kind}`}>{text}</div>
      ))}

      {settingsOpen && <MailSettings onSaved={s => setSync(s)} showToast={showToast} />}

      {loading ? (
        <div className="mail-empty">Loading…</div>
      ) : view === 'pending' ? (
        visible.length === 0 ? (
          <div className="mail-empty">
            🎉 No pending requests.
            {queue.length > 0 && ' Saving your last choices…'}
          </div>
        ) : (
          <>
            <p className="mail-keys">
              {visible.length} waiting · keys: <kbd>Y</kbd> yes · <kbd>N</kbd> no · <kbd>J</kbd>/<kbd>K</kbd> next/previous
            </p>
            <div className="mail-list">
              {visible.map(item => (
                <RequestCard
                  key={item.id}
                  item={item}
                  focused={item.id === focusId}
                  draft={drafts[item.id]}
                  geo={geo[item.id]}
                  errors={cardErrors[item.id]}
                  families={families}
                  showEmail={!!showEmail[item.id]}
                  onToggleEmail={() => setShowEmail(s => ({ ...s, [item.id]: !s[item.id] }))}
                  onFocus={() => setFocusId(item.id)}
                  onEdit={patch => editDraft(item.id, patch)}
                  onAddressBlur={() => {
                    const d = drafts[item.id];
                    if (d?.address?.trim() && geo[item.id]?.address !== d.address.trim()) lookup(item.id, d.address);
                  }}
                  onApprove={sendEmail => approve(item, sendEmail)}
                  onDecline={() => decline(item)}
                  onNotRequest={() => act(item, { action: 'reclassify', kind: 'other' }, 'Moved to Other')}
                  onResend={() => act(item, { action: 'resend', which: 'auto_reply' }, 'The reply will be sent on the next check')}
                />
              ))}
            </div>
          </>
        )
      ) : (
        <SimpleList view={view} items={visible} act={act} showEmail={showEmail} setShowEmail={setShowEmail} />
      )}

      {toast && (
        <div className={`mail-toast ${toast.kind}`} role="status">
          <span>{toast.text}</span>
          {toast.undoKey && entries.current.has(toast.undoKey) && (
            <button type="button" onClick={() => undo(toast.undoKey)}>
              Undo
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function AutoReplyBadge({ item, onResend }) {
  const s = item.auto_reply_status;
  if (s === 'sent') return <span className="mail-badge ok">Auto-replied</span>;
  if (s === 'due' || s === 'claimed' || s === 'wait_ai') return <span className="mail-badge">Auto-reply on its way</span>;
  if (s === 'failed' || s === 'unknown') {
    return (
      <span className="mail-badge red">
        {s === 'failed' ? 'Auto-reply failed' : 'Auto-reply unclear'}
        {onResend && (
          <button type="button" className="mail-inline-btn" onClick={e => { e.stopPropagation(); onResend(); }}>
            Send now
          </button>
        )}
      </span>
    );
  }
  return null;
}

function EmailThread({ item }) {
  return (
    <div className="mail-thread">
      {(item.messages || []).map(m => (
        <div key={m.id} className="mail-message">
          <div className="mail-message-meta">
            {m.from_name || m.from_email} · {new Date(m.received_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
            {m.attachment_count ? ` · 📎 ${m.attachment_count}` : ''}
          </div>
          <pre className="mail-body">{m.body_text || '(no text)'}</pre>
        </div>
      ))}
    </div>
  );
}

function RequestCard({
  item, focused, draft, geo, errors, families, showEmail, onToggleEmail, onFocus, onEdit, onAddressBlur,
  onApprove, onDecline, onNotRequest, onResend
}) {
  const f = item.ai_fields || {};
  const dupes = useMemo(
    () =>
      draft
        ? findPossibleDuplicates(
            {
              phone: draft.contact,
              address: draft.address,
              latitude: geo?.status === 'found' ? geo.lat : null,
              longitude: geo?.status === 'found' ? geo.lng : null
            },
            families
          )
        : [],
    [draft, geo, families]
  );
  const summary =
    item.ai_status === 'done' ? item.ai_summary
      : item.ai_status === 'failed' ? 'Couldn’t summarize this one. Read the email below.'
        : 'Summarizing…';
  const badges = (
    <div className="mail-badges">
      {item.kind === 'unknown' && item.ai_status !== 'due' && <span className="mail-badge orange">Not sorted</span>}
      {(f.missing || []).map(m => (
        <span key={m} className="mail-badge red">{MISSING_LABEL[m] || m}</span>
      ))}
      {f.urgent && <span className="mail-badge red">Urgent</span>}
      {f.on_behalf_of_someone && <span className="mail-badge">For someone else</span>}
      {f.language && !/^english$/i.test(f.language) && <span className="mail-badge">{f.language}</span>}
      {dupes.map(d => (
        <span key={d.family_id} className="mail-badge orange">
          Possible duplicate of #{d.family_id}
          {d.active ? '' : ' (inactive)'} · {d.reasons.join(', ')}
        </span>
      ))}
      {(f.flags || []).includes('instructions_to_ai') && <span className="mail-badge orange">Tried to instruct the AI</span>}
      {(f.flags || []).includes('multiple_households') && <span className="mail-badge orange">Several households</span>}
      {(f.flags || []).includes('outside_area') && <span className="mail-badge orange">Maybe outside the area</span>}
      <AutoReplyBadge item={item} onResend={onResend} />
    </div>
  );

  if (!focused) {
    return (
      <button type="button" className="mail-row" onClick={onFocus}>
        <span className="mail-row-who">{item.from_name || item.from_email}</span>
        <span className="mail-row-summary">{summary}</span>
        <span className="mail-row-when">{timeAgo(item.last_message_at)}</span>
      </button>
    );
  }

  const d = draft || familyDraft(f);
  const onMap = geo?.status === 'found' && geo.address === d.address.trim();
  return (
    <article className="mail-card" aria-label={`Request from ${item.from_name || item.from_email}`}>
      <header className="mail-card-head">
        <div>
          <strong>{item.from_name || item.from_email}</strong>
          <span className="mail-from">{item.from_email}</span>
        </div>
        <span className="mail-when">
          {timeAgo(item.last_message_at)}
          {item.message_count > 1 ? ` · ${item.message_count} emails` : ''}
        </span>
      </header>
      <div className="mail-subject">{item.subject || '(no subject)'}</div>
      <p className="mail-summary">{summary}</p>
      {badges}

      <div className="mail-form">
        <label className="mail-field wide">
          <span>Address</span>
          <input
            value={d.address}
            onChange={e => onEdit({ address: e.target.value })}
            onBlur={onAddressBlur}
            placeholder="Street, city"
          />
          <small className={`mail-geo ${onMap ? 'ok' : geo?.status === 'not_found' ? 'bad' : ''}`}>
            {!d.address.trim()
              ? 'Add the address before saying yes.'
              : geo?.address !== d.address.trim() || !geo
                ? geocoderAvailable() ? 'Checking the map when you leave this field…' : 'Map check unavailable here.'
                : geo.status === 'looking'
                  ? 'Checking the map…'
                  : onMap
                    ? <>📍 On the map: {geo.formatted_address}{' '}
                        {geo.formatted_address !== d.address.trim() && (
                          <button type="button" className="mail-inline-btn" onClick={() => onEdit({ address: geo.formatted_address })}>
                            Use this
                          </button>
                        )}
                      </>
                    : 'Not found on the map. It will be added without a delivery group; check the address.'}
          </small>
        </label>
        <label className="mail-field small">
          <span>Unit</span>
          <input value={d.unit} onChange={e => onEdit({ unit: e.target.value })} placeholder="#" />
        </label>
        <label className="mail-field">
          <span>Phone</span>
          <input value={d.contact} onChange={e => onEdit({ contact: e.target.value })} inputMode="tel" />
        </label>
        <label className="mail-field small">
          <span>People</span>
          <input
            type="number"
            min="1"
            max="20"
            value={d.people_count}
            onChange={e => onEdit({ people_count: e.target.value === '' ? '' : Number(e.target.value) })}
          />
        </label>
        <div className="mail-field wide">
          <span>Delivery days</span>
          <div className="mail-days">
            {DAYS.map(day => {
              const on = d.delivery_days.includes(day);
              return (
                <button
                  key={day}
                  type="button"
                  className={`mail-day ${on ? 'on' : ''}`}
                  aria-pressed={on}
                  onClick={() =>
                    onEdit({ delivery_days: on ? d.delivery_days.filter(x => x !== day) : DAYS.filter(x => x === day || d.delivery_days.includes(x)) })
                  }
                >
                  {day.slice(0, 3)}
                </button>
              );
            })}
          </div>
        </div>
        <label className="mail-field">
          <span>Instructions</span>
          <input list="mail-instructions" value={d.instructions} onChange={e => onEdit({ instructions: e.target.value })} />
          <datalist id="mail-instructions">
            {INSTRUCTION_OPTIONS.map(o => (
              <option key={o} value={o} />
            ))}
          </datalist>
        </label>
        <label className="mail-field">
          <span>Notes</span>
          <input value={d.notes} onChange={e => onEdit({ notes: e.target.value })} placeholder="Allergies, diet…" />
        </label>
        <small className="mail-hint wide">Instructions and notes print on the delivery labels. No names.</small>
      </div>

      {errors?.length > 0 && (
        <ul className="mail-errors">
          {errors.map(e => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}

      <button type="button" className="mail-link" onClick={onToggleEmail}>
        {showEmail ? 'Hide the email' : `Show the email${item.message_count > 1 ? `s (${item.message_count})` : ''}`}
      </button>
      {showEmail && <EmailThread item={item} />}

      <div className="mail-decide">
        <button type="button" className="mail-yes" onClick={e => onApprove(!e.shiftKey)} title="Y (Shift+Y: without the email)">
          ✓ Yes, add family
        </button>
        <button type="button" className="mail-no" onClick={onDecline} title="N">
          ✕ No
        </button>
        <div className="mail-decide-more">
          <button type="button" className="mail-link" onClick={() => onApprove(false)}>
            Yes, without email
          </button>
          <button type="button" className="mail-link" onClick={onNotRequest}>
            Not a request
          </button>
          <a className="mail-link" href={item.gmail_url} target="_blank" rel="noreferrer">
            Open in Gmail
          </a>
        </div>
      </div>
    </article>
  );
}

function SimpleList({ view, items, act, showEmail, setShowEmail }) {
  if (!items.length) {
    const empty = { attention: 'Nothing needs attention.', approved: 'No approved requests yet.', declined: 'No declined requests.', other: 'No other emails.' };
    return <div className="mail-empty">{empty[view]}</div>;
  }
  return (
    <div className="mail-simple">
      {items.map(item => {
        const f = item.ai_fields || {};
        const fam = item.approved_family;
        return (
          <div key={item.id} className="mail-simple-row">
            <div className="mail-simple-main">
              <div className="mail-simple-top">
                <strong>{item.from_name || item.from_email}</strong>
                {view === 'approved' && item.family_id && <span className="mail-badge ok">Family #{item.family_id}</span>}
                {view === 'other' && f.other_topic && TOPIC_LABEL[f.other_topic] && (
                  <span className="mail-badge">{TOPIC_LABEL[f.other_topic]}</span>
                )}
                {view === 'attention' && <span className="mail-badge red">New email after a decision ({item.status})</span>}
                <span className="mail-when">{timeAgo(view === 'approved' || view === 'declined' ? item.decided_at : item.last_message_at)}</span>
              </div>
              <p className="mail-summary">
                {view === 'approved' && fam ? `${fam.address}${fam.unit ? ` #${fam.unit}` : ''} · ${fam.people_count} people` : item.ai_summary || item.subject}
              </p>
              {view === 'approved' && (
                <span className={`mail-badge ${item.approval_email_status === 'sent' ? 'ok' : ['failed', 'unknown'].includes(item.approval_email_status) ? 'red' : ''}`}>
                  {{ sent: 'Approval email sent', due: 'Approval email on its way', claimed: 'Approval email on its way', failed: 'Approval email failed', unknown: 'Approval email unclear', not_needed: 'No approval email' }[item.approval_email_status]}
                  {['failed', 'unknown'].includes(item.approval_email_status) && (
                    <button type="button" className="mail-inline-btn" onClick={() => act(item, { action: 'resend', which: 'approval_email' }, 'It will be sent on the next check')}>
                      Resend
                    </button>
                  )}
                </span>
              )}
              {item.gmail_error && <span className="mail-badge orange">{item.gmail_error}</span>}
              {(view === 'other' || view === 'attention') && (
                <>
                  <button type="button" className="mail-link" onClick={() => setShowEmail(s => ({ ...s, [item.id]: !s[item.id] }))}>
                    {showEmail[item.id] ? 'Hide the email' : 'Show the email'}
                  </button>
                  {showEmail[item.id] && <EmailThread item={item} />}
                </>
              )}
            </div>
            <div className="mail-simple-actions">
              {view === 'declined' && (
                <button type="button" className="mail-btn" onClick={() => act(item, { action: 'reopen' }, 'Moved back to Pending')}>
                  Reopen
                </button>
              )}
              {view === 'other' && (
                <button type="button" className="mail-btn" onClick={() => act(item, { action: 'reclassify', kind: 'request' }, 'Moved to Pending')}>
                  It’s a request
                </button>
              )}
              {view === 'attention' && (
                <button type="button" className="mail-btn" onClick={() => act(item, { action: 'handled' }, 'Marked as handled')}>
                  Mark handled
                </button>
              )}
              <a className="mail-link" href={item.gmail_url} target="_blank" rel="noreferrer">
                Open in Gmail
              </a>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function MailSettings({ onSaved, showToast }) {
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const r = await api('/api/mail/settings');
      if (r.ok) {
        setData(r.data);
        setForm(r.data.settings);
      }
    })();
  }, []);

  if (!form) return <div className="mail-settings">Loading settings…</div>;
  const set = patch => setForm(f => ({ ...f, ...patch }));

  const save = async () => {
    if (form.mode === 'live' && data.settings.mode !== 'live') {
      const ok = confirm(
        'Turn on Live?\n\nNew emails from now on get the automatic reply, and requests move out of the inbox into the ' +
          '"Kitchen Requests" folder in Gmail. Yes on a request adds the family and sends the approval email.'
      );
      if (!ok) return;
    }
    setSaving(true);
    const r = await api('/api/mail/settings', { method: 'PUT', body: JSON.stringify(form) });
    setSaving(false);
    if (!r.ok) {
      showToast(r.data?.message || 'Could not save the settings.', 'warn');
      return;
    }
    setData(d => ({ ...d, settings: r.data.settings, sync: r.data.sync }));
    onSaved?.(r.data.sync);
    showToast('Settings saved', 'ok');
  };

  const test = async which => {
    const r = await api('/api/mail/settings', { method: 'POST', body: JSON.stringify({ action: 'test_email', which }) });
    if (r.ok) showToast(r.data.dryRun ? 'Test built (dry run: not actually sent).' : `Test sent to ${r.data.to}`, 'ok');
    else showToast(r.data?.message || 'Could not send the test.', 'warn');
  };

  const sync = data.sync || {};
  return (
    <div className="mail-settings">
      <div className="mail-settings-status">
        <span>Gmail: {sync.has_gmail ? `connected as ${sync.gmail_user}` : 'not connected'}</span>
        <span>Claude summaries: {sync.has_ai ? 'on' : 'off (no API key)'}</span>
        <span>Last check: {sync.last_sync_at ? new Date(sync.last_sync_at).toLocaleString() : 'never'}</span>
      </div>

      <fieldset className="mail-modes">
        <legend>Mode</legend>
        {[
          ['off', 'Off', 'Mail isn’t checked.'],
          ['shadow', 'Shadow (practice)', 'Reads and summarizes only. Sends nothing, changes nothing in Gmail, Yes adds nothing.'],
          ['live', 'Live', 'Automatic replies, folders in Gmail, Yes adds the family and sends the approval email.']
        ].map(([value, label, help]) => (
          <label key={value} className={`mail-mode ${form.mode === value ? 'on' : ''}`}>
            <input type="radio" name="mail-mode" checked={form.mode === value} onChange={() => set({ mode: value })} />
            <strong>{label}</strong>
            <small>{help}</small>
          </label>
        ))}
      </fieldset>

      <label className="mail-check">
        <input type="checkbox" checked={!!form.auto_reply_enabled} onChange={e => set({ auto_reply_enabled: e.target.checked })} />
        Send the automatic reply
      </label>
      <label className="mail-field wide">
        <span>Who gets it</span>
        <select value={form.auto_reply_scope} onChange={e => set({ auto_reply_scope: e.target.value })}>
          <option value="all">Every person who writes (not newsletters or robots)</option>
          <option value="requests">Only people asking for meals (after the summary)</option>
        </select>
      </label>
      <label className="mail-field wide">
        <span>Automatic reply</span>
        <textarea
          rows={5}
          value={form.auto_reply_body || ''}
          placeholder={data.defaults.auto_reply_body}
          onChange={e => set({ auto_reply_body: e.target.value })}
        />
        <small>{data.help.auto_reply_body}. Leave empty to use the text shown.</small>
      </label>
      <label className="mail-field wide">
        <span>Approval email</span>
        <textarea
          rows={6}
          value={form.approval_body || ''}
          placeholder={data.defaults.approval_body}
          onChange={e => set({ approval_body: e.target.value })}
        />
        <small>{data.help.approval_body}. Leave empty to use the text shown.</small>
      </label>
      <label className="mail-field wide">
        <span>Never auto-reply to</span>
        <textarea
          rows={2}
          value={form.no_reply_senders || ''}
          placeholder="partner@example.org, @city.gov"
          onChange={e => set({ no_reply_senders: e.target.value })}
        />
      </label>
      <div className="mail-settings-actions">
        <button type="button" className="mail-btn primary" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save settings'}
        </button>
        <button type="button" className="mail-btn" onClick={() => test('auto_reply')} disabled={!sync.has_gmail}>
          Send me a test reply
        </button>
        <button type="button" className="mail-btn" onClick={() => test('approval')} disabled={!sync.has_gmail}>
          Send me a test approval
        </button>
      </div>
    </div>
  );
}
