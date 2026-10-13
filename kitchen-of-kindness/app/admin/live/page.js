'use client';

// Kitchen Live: a phone-first, game-like view of one kitchen day.
// The 3D diorama (kitchenScene.js) shows every bag moving through the day:
// cooking -> packing (labels printed) -> delivering (list copied to the
// volunteers' WhatsApp group) -> delivered. Printing and copying record the
// steps by themselves (from any device); the admin can mark or undo a step.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { attachPauses } from '../../../lib/pauses';
import { loadSpecialOrdersForDate, longDate, parseDate, todayStr, orderTitle } from '../../../lib/weeks';
import { buildDay, defaultKitchenDate, stepKitchenDate } from '../../../lib/day';
import { buildWhatsAppList, buildGroupText } from '../../../lib/whatsapp';
import {
  STAGES, stageIndex, loadKitchenDay, markCopied, markDelivered, markStage, undoStage, logStage
} from '../../../lib/kitchenDays';
import { groupColor } from '../../../lib/groups';
import { addressArea } from '../../../lib/format';

const ADMIN_PASSWORD = process.env.NEXT_PUBLIC_ADMIN_PASSWORD;
const OTHER_COLOR = '#94a3b8';
const BOX_COLOR = '#f59e0b';
const PICKUP_COLOR = '#57534e';
const STATUS_ICON = ['\u{1F373}', '\u{1F6CD}️', '\u{1F690}', '✅'];

const fmtTime = iso =>
  iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
const uniq = list => [...new Set(list)];
const bagsOf = f => (f.deliversToday ? 1 : 0) + (f.satToday ? 1 : 0);
const peopleOf = list => list.reduce((s, x) => s + (x.people_count || 0), 0);
// One bag is one day's meals for the family, so a Thursday family with
// Saturday meals counts twice.
const mealsOf = list => list.reduce((s, f) => s + (f.people_count || 0) * bagsOf(f), 0);
const dayMeals = t => t.thuPeople + t.satPeople;
const areasOf = list => uniq(list.map(x => addressArea(x.address)).filter(Boolean));

// Delivery groups for the day, in the same order as the WhatsApp list.
function buildGroups(day) {
  const groups = [];
  for (const [g, list] of day.grouped) {
    groups.push({
      key: `g${g}`, number: g, label: String(g), title: `Group ${g}`, color: groupColor(g),
      families: list, bags: list.reduce((s, f) => s + bagsOf(f), 0), meals: mealsOf(list), areas: areasOf(list)
    });
  }
  if (day.ungrouped.length) {
    groups.push({
      key: 'other', label: '?', title: 'No group yet', color: OTHER_COLOR, families: day.ungrouped,
      bags: day.ungrouped.reduce((s, f) => s + bagsOf(f), 0), meals: mealsOf(day.ungrouped), areas: areasOf(day.ungrouped)
    });
  }
  day.specialWeeks.forEach(w => {
    groups.push({
      key: `w${w.id}`, label: '✨', title: w.title, emoji: w.emoji, color: BOX_COLOR, special: true,
      orders: w.orders, bags: w.orders.length, people: peopleOf(w.orders), areas: areasOf(w.orders)
    });
  });
  return groups;
}

function buildSceneModel(day, groups) {
  const bagList = f => [f.deliversToday && { type: 'bag' }, f.satToday && { type: 'sat' }].filter(Boolean);
  return {
    meals: dayMeals(day.totals),
    bagsTotal: day.totals.bags,
    clusters: groups.map(g => ({
      key: g.key,
      label: g.label,
      color: g.color,
      bags: g.special ? g.orders.map(() => ({ type: 'box' })) : g.families.flatMap(bagList)
    })),
    pickups: day.pickups.flatMap(bagList)
  };
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    // Older phones: fall back to a hidden textarea.
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (e) {
    return false;
  }
}

function Kpi({ icon, value, label, sub }) {
  return (
    <div className="kl-kpi">
      <div className="kl-kpi-top">
        <span className="kl-kpi-icon">{icon}</span>
        <span className="kl-kpi-value">{value}</span>
      </div>
      <div className="kl-kpi-label">{label}</div>
      {sub && <div className="kl-kpi-sub">{sub}</div>}
    </div>
  );
}

export default function KitchenLivePage() {
  const [authed, setAuthed] = useState(null);
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [dateStr, setDateStr] = useState(null);
  const [families, setFamilies] = useState(null);
  const [specialWeeks, setSpecialWeeks] = useState([]);
  const [row, setRow] = useState(null);
  const [loadedDate, setLoadedDate] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [live, setLive] = useState(false);
  const [sheet, setSheet] = useState(null);
  const [toast, setToast] = useState(null);
  const [sceneState, setSceneState] = useState('loading');
  const [isTouch, setIsTouch] = useState(false);
  const [canShare, setCanShare] = useState(false);
  const sceneBox = useRef(null);
  const sceneRef = useRef(null);
  const modelSig = useRef('');
  const dateRef = useRef(null);
  const toastTimer = useRef(null);
  // Saves in flight, and a counter bumped by every local change or live event
  // to the row: a read sent before either one is stale and gets dropped.
  const saving = useRef(0);
  const rowVer = useRef(0);

  useEffect(() => {
    document.title = 'Kitchen Live · Kitchen of Kindness';
    try {
      setAuthed(localStorage.getItem('kok_admin_authenticated') === 'true');
    } catch (e) {
      setAuthed(false);
    }
    const q = new URLSearchParams(window.location.search).get('date');
    const parsed = q && /^\d{4}-\d{2}-\d{2}$/.test(q) ? parseDate(q) : null;
    setDateStr(parsed && parsed.getDay() <= 4 ? q : defaultKitchenDate());
    setIsTouch(!!window.matchMedia?.('(pointer: coarse)').matches);
    setCanShare(typeof navigator.share === 'function');
  }, []);

  const showToast = useCallback((text, kind = 'ok', action = null) => {
    clearTimeout(toastTimer.current);
    setToast({ text, kind, action, id: Date.now() });
    toastTimer.current = setTimeout(() => setToast(null), action ? 6500 : 3400);
  }, []);

  const loadFamilies = useCallback(async () => {
    if (!supabase) {
      setLoadError('The database is not configured.');
      setFamilies(f => f || []);
      return;
    }
    try {
      const { data, error } = await supabase
        .from('families')
        .select('*')
        .eq('active', true)
        .order('family_id', { ascending: true });
      if (error) throw error;
      setFamilies(await attachPauses(supabase, data || []));
      setLoadError('');
    } catch (e) {
      console.error('Error loading families:', e);
      setLoadError('Could not load families. Check the connection and reopen the page.');
      setFamilies(f => f || []);
    }
  }, []);

  const loadDate = useCallback(async d => {
    if (!supabase || !d) return;
    const v = rowVer.current;
    const [weeks, kitchenRow] = await Promise.all([
      loadSpecialOrdersForDate(supabase, d).catch(e => {
        console.error('Error loading special orders:', e);
        return [];
      }),
      loadKitchenDay(supabase, d).catch(e => {
        console.error('Error loading kitchen progress:', e);
        return null;
      })
    ]);
    if (dateRef.current !== d) return;
    setSpecialWeeks(weeks);
    if (rowVer.current === v && saving.current === 0) setRow(kitchenRow);
    setLoadedDate(d);
  }, []);

  const refreshRow = useCallback(async () => {
    const d = dateRef.current;
    if (!supabase || !d) return;
    const v = rowVer.current;
    try {
      const r = await loadKitchenDay(supabase, d);
      if (dateRef.current === d && rowVer.current === v && saving.current === 0) setRow(r);
    } catch (e) {
      console.error('Error refreshing kitchen progress:', e);
    }
  }, []);

  useEffect(() => {
    if (authed) loadFamilies();
  }, [authed, loadFamilies]);

  useEffect(() => {
    if (!authed || !dateStr) return;
    dateRef.current = dateStr;
    setLoadedDate(null);
    setRow(null);
    loadDate(dateStr);
  }, [authed, dateStr, loadDate]);

  // Live: when the kitchen PC prints or someone copies the list, this moves.
  useEffect(() => {
    if (!supabase || !authed || !dateStr) return;
    const channel = supabase
      .channel(`kitchen-live-${dateStr}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'kitchen_days' }, payload => {
        const r = payload.new;
        if (r && r.delivery_date === dateStr) {
          rowVer.current += 1;
          // Mid-save, the save's own read-back (sent once it finishes) brings
          // in this change too, so it's never lost.
          if (saving.current > 0) return;
          if (payload.eventType === 'INSERT') {
            // An insert is the empty row a step creates just before it sets its
            // time; keep the steps already shown so the day doesn't jump back.
            setRow(prev => {
              const merged = { ...(prev || {}), ...r };
              Object.keys(r).forEach(k => {
                if (r[k] == null && prev?.[k] != null) merged[k] = prev[k];
              });
              return merged;
            });
          } else {
            setRow(r);
          }
        } else if (payload.eventType === 'DELETE') refreshRow();
      })
      .subscribe(status => {
        const ok = status === 'SUBSCRIBED';
        setLive(ok);
        // (Re)connected: catch up on anything missed while it was down.
        if (ok) refreshRow();
      });
    return () => {
      supabase.removeChannel(channel);
      setLive(false);
    };
  }, [authed, dateStr, refreshRow]);

  // Backup for a dropped live connection (phones drop it when the screen
  // locks): re-check the day every few seconds, every minute while live, so
  // a print or copy from the kitchen always shows up here.
  useEffect(() => {
    if (!authed || !dateStr) return undefined;
    const id = setInterval(() => {
      if (document.visibilityState === 'visible' && saving.current === 0) refreshRow();
    }, live ? 60000 : 10000);
    return () => clearInterval(id);
  }, [authed, dateStr, live, refreshRow]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || !authed || !dateRef.current) return;
      loadDate(dateRef.current);
      loadFamilies();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [authed, loadDate, loadFamilies]);

  const day = useMemo(
    () => (families && dateStr ? buildDay(families, specialWeeks, dateStr) : null),
    [families, specialWeeks, dateStr]
  );
  const groups = useMemo(() => (day ? buildGroups(day) : []), [day]);
  const model = useMemo(() => (day ? buildSceneModel(day, groups) : null), [day, groups]);
  const stage = stageIndex(row);
  const ready = !!day && loadedDate === dateStr;

  // The 3D scene loads three.js on demand, only on this page.
  useEffect(() => {
    if (!authed) return undefined;
    let cancelled = false;
    let created = null;
    (async () => {
      try {
        const { createKitchenScene } = await import('./kitchenScene');
        if (cancelled || !sceneBox.current) return;
        const reduced = !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        created = createKitchenScene(sceneBox.current, {
          onSelect: sel => setSheet(sel),
          reducedMotion: reduced
        });
        sceneRef.current = created;
        setSceneState('ready');
      } catch (e) {
        console.error('3D view unavailable:', e);
        if (!cancelled) setSceneState('failed');
      }
    })();
    return () => {
      cancelled = true;
      created?.dispose();
      sceneRef.current = null;
      modelSig.current = '';
    };
  }, [authed]);

  // New day or new bags: rebuild (no animation). Same bags, new step: animate.
  useEffect(() => {
    const s = sceneRef.current;
    if (!s || sceneState !== 'ready' || !ready || !model) return;
    const sig = dateStr + JSON.stringify(model);
    if (sig !== modelSig.current) {
      modelSig.current = sig;
      s.setModel(model, stage);
    } else {
      s.setStage(stage);
    }
  }, [sceneState, ready, model, stage, dateStr]);

  useEffect(() => {
    const s = sceneRef.current;
    if (!s || sceneState !== 'ready') return;
    s.select(sheet && sheet.type !== 'step' ? sheet : null);
  }, [sheet, sceneState]);

  const patchRow = patch => {
    rowVer.current += 1;
    setRow(r => ({ ...(r || { delivery_date: dateStr }), ...patch }));
  };

  // The dock buttons move the day along; bring the 3D view into sight so the
  // animation is seen, and give a little buzz on phones that support it.
  const showScene = () => {
    navigator.vibrate?.(30);
    // After this tap's re-render: a button turning disabled drops focus,
    // which would cancel a smooth scroll started right away.
    setTimeout(() => {
      const el = sceneBox.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.top < 40 || r.bottom > window.innerHeight - 90) {
        window.scrollTo({ top: Math.max(0, window.scrollY + r.top - 64), behavior: 'smooth' });
      }
    }, 60);
  };
  const save = async (fn, ...args) => {
    saving.current += 1;
    const ok = await logStage(fn, supabase, dateStr, ...args);
    saving.current -= 1;
    if (!ok) showToast('Could not save that step. Check the connection and try again.', 'warn');
    refreshRow();
    return ok;
  };

  const sendList = async () => {
    if (!row?.copied_at) {
      showScene();
      patchRow({ copied_at: new Date().toISOString() });
      await save(markCopied);
    }
  };

  const handleCopyList = async () => {
    if (!day || !day.totals.bags) return;
    if (!(await copyText(buildWhatsAppList(day)))) {
      showToast('Could not copy. Try again.', 'warn');
      return;
    }
    showToast(
      stage >= 2
        ? '\u{1F4CB} List copied again'
        : '\u{1F4CB} Copied! Paste it in the volunteers’ WhatsApp group',
      'ok'
    );
    await sendList();
  };

  const handleShare = async () => {
    if (!day) return;
    try {
      await navigator.share({ text: buildWhatsAppList(day) });
    } catch (e) {
      if (e?.name !== 'AbortError') showToast('Could not open sharing. Use Copy list instead.', 'warn');
      return;
    }
    await sendList();
  };

  const handleCopyGroup = async g => {
    if (await copyText(buildGroupText(day, g.number))) showToast(`\u{1F4CB} ${g.title} copied`, 'ok');
    else showToast('Could not copy. Try again.', 'warn');
  };

  const handleMarkStage = async i => {
    const field = STAGES[i]?.field;
    if (!field) return;
    setSheet(null);
    showScene();
    patchRow({ [field]: row?.[field] || new Date().toISOString() });
    await save(markStage, i);
  };

  const handleUndo = async i => {
    const patch = {};
    STAGES.slice(Math.max(1, i)).forEach(s => {
      patch[s.field] = null;
    });
    setSheet(null);
    patchRow(patch);
    await save(undoStage, i);
  };

  const handleDelivered = async () => {
    showScene();
    patchRow({ delivered_at: new Date().toISOString() });
    showToast('\u{1F389} All delivered. Great work today!', 'ok', { label: 'Undo', run: () => handleUndo(3) });
    await save(markDelivered);
  };

  // The print tab moves the day to Packing itself as the job starts, the
  // same as when the kitchen prints; this page follows along live.
  const openPrint = silent =>
    window.open(`/admin/print-labels?date=${dateStr}${silent ? '&silent=1' : ''}`, '_blank');

  const go = dir => {
    setSheet(null);
    setToast(null);
    setDateStr(d => stepKitchenDate(d, dir));
  };

  // ---------- render ----------
  if (authed === null || !dateStr) {
    return <div className="kl-page"><div className="kl-center">Loading…</div></div>;
  }

  if (!authed) {
    return (
      <div className="password-screen">
        <div className="password-card">
          <h1>Kitchen Live</h1>
          <p>Enter the admin password</p>
          <form
            onSubmit={e => {
              e.preventDefault();
              if (password === ADMIN_PASSWORD) {
                try {
                  localStorage.setItem('kok_admin_authenticated', 'true');
                } catch (err) {
                  // Private mode: stay logged in for this visit only.
                }
                setAuthed(true);
                setPasswordError('');
              } else {
                setPasswordError('Incorrect admin password.');
              }
            }}
          >
            <input
              type="password"
              placeholder="Admin password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoFocus
            />
            <button type="submit">Enter</button>
          </form>
          {passwordError && <p className="password-error">{passwordError}</p>}
        </div>
      </div>
    );
  }

  const t = day?.totals;
  const today = todayStr();
  const current = STAGES[stage];
  const currentTime = current.field ? fmtTime(row?.[current.field]) : '';
  const stepStatus = i => (i < stage || (i === 3 && stage === 3) ? 'done' : i === stage ? 'current' : 'todo');
  const groupStatus = () =>
    [
      '\u{1F373} In the kitchen',
      '\u{1F6CD}️ Packed and labeled',
      `\u{1F690} Out for delivery${row?.copied_at ? ` since ${fmtTime(row.copied_at)}` : ''}`,
      `✅ Delivered${row?.delivered_at ? ` at ${fmtTime(row.delivered_at)}` : ''}`
    ][stage];

  let secondary;
  if (stage === 0) {
    secondary = isTouch
      ? { icon: '\u{1F6CD}️', main: 'Labels printed', sub: 'move to Packing', run: () => handleMarkStage(1) }
      : { icon: '\u{1F5A8}️', main: 'Print labels', sub: 'kitchen printer', run: () => openPrint(true) };
  } else if (stage === 1) {
    secondary = canShare && isTouch
      ? { icon: '\u{1F4E4}', main: 'Share', sub: 'open WhatsApp', run: handleShare }
      : { icon: '\u{1F5A8}️', main: 'Print again', sub: 'kitchen printer', run: () => openPrint(true) };
  } else if (stage === 2) {
    secondary = { icon: '✅', main: 'Delivered', sub: 'all bags dropped off', run: handleDelivered };
  } else {
    secondary = {
      icon: '\u{1F389}',
      main: 'Day done',
      sub: row?.delivered_at ? `delivered at ${fmtTime(row.delivered_at)}` : 'great work today',
      run: null
    };
  }

  const renderSheet = () => {
    if (!sheet || !day) return null;
    if (sheet.type === 'group') {
      const g = groups.find(x => x.key === sheet.key);
      if (!g) return null;
      return (
        <>
          <div className="kl-sheet-head" style={{ '--g': g.color }}>
            <span className="kl-badge">{g.label}</span>
            <div>
              <h3>{g.special ? `${g.emoji} ${g.title}` : g.title}</h3>
              <p>
                {g.special ? `${g.bags} boxes · ${g.people} people` : `${g.bags} bags · ${g.meals} meals`}
                {g.areas.length ? ` · ${g.areas.join(', ')}` : ''}
              </p>
            </div>
          </div>
          <div className="kl-sheet-status">{groupStatus()}</div>
          <ul className="kl-list">
            {g.special
              ? g.orders.map(o => (
                  <li key={o.id}>
                    <strong>{orderTitle(o)}</strong>
                    <span>{addressArea(o.address) || o.instructions || '—'}</span>
                  </li>
                ))
              : g.families.map(f => (
                  <li key={f.id}>
                    <strong>#{f.family_id}</strong>
                    <span>{addressArea(f.address) || '—'}</span>
                    <em>
                      {f.people_count || '?'} ppl
                      {f.satToday ? (f.deliversToday ? ' · +Sat' : ' · Sat only') : ''}
                    </em>
                  </li>
                ))}
          </ul>
          {g.number != null && (
            <button type="button" className="kl-btn small" onClick={() => handleCopyGroup(g)}>
              {'\u{1F4CB}'} Copy this group
            </button>
          )}
        </>
      );
    }
    if (sheet.type === 'kitchen') {
      return (
        <>
          <div className="kl-sheet-head plain">
            <div>
              <h3>{'\u{1F373}'} The kitchen</h3>
              <p>{longDate(dateStr)}</p>
            </div>
          </div>
          <ul className="kl-facts">
            <li><strong>{dayMeals(t)}</strong> meals for <strong>{t.families}</strong> families</li>
            {day.isThursday && <li>{t.thuPeople} Thursday meals {'·'} {t.satPeople} Saturday meals</li>}
            {t.specialBoxes > 0 && <li>{t.specialBoxes} holiday boxes for {t.specialPeople} people</li>}
            <li>{day.pickups.length} families pick up at the kitchen</li>
          </ul>
          <a className="kl-btn small ghost" href="/kitchen" target="_blank" rel="noreferrer">Open the kitchen table</a>
        </>
      );
    }
    if (sheet.type === 'printer') {
      return (
        <>
          <div className="kl-sheet-head plain">
            <div>
              <h3>{'\u{1F3F7}️'} Labels</h3>
              <p>{t.bags} labels for {longDate(dateStr)}</p>
            </div>
          </div>
          <div className="kl-sheet-status">
            {row?.printed_at
              ? `Printed at ${fmtTime(row.printed_at)} · ${row.printed_labels ?? t.bags} labels`
              : 'Not printed yet'}
          </div>
          <p className="kl-note">Labels printing from the kitchen page, the admin panel or here move the day to Packing by themselves.</p>
          <div className="kl-row">
            <button type="button" className="kl-btn small" onClick={() => openPrint(true)} disabled={!t.bags}>
              {'\u{1F5A8}️'} Print labels
            </button>
            <button type="button" className="kl-btn small ghost" onClick={() => openPrint(false)} disabled={!t.bags}>
              Preview
            </button>
          </div>
        </>
      );
    }
    if (sheet.type === 'pickup') {
      return (
        <>
          <div className="kl-sheet-head" style={{ '--g': PICKUP_COLOR }}>
            <span className="kl-badge">P</span>
            <div>
              <h3>Pickup at the kitchen</h3>
              <p>{day.pickups.length} families collect their bags</p>
            </div>
          </div>
          <ul className="kl-list">
            {day.pickups.map(f => (
              <li key={f.id}>
                <strong>#{f.family_id}</strong>
                <span>{f.people_count || '?'} ppl</span>
                <em>{f.satToday ? (f.deliversToday ? '+Sat' : 'Sat only') : ''}</em>
              </li>
            ))}
          </ul>
        </>
      );
    }
    if (sheet.type === 'step') {
      const i = sheet.index;
      const s = STAGES[i];
      const status = stepStatus(i);
      const when = s.field ? fmtTime(row?.[s.field]) : '';
      const auto = {
        packing: 'This happens by itself when labels start printing: from the kitchen page, the admin panel or here.',
        delivering: 'This happens by itself when you copy the list for WhatsApp.',
        delivered: 'Mark this when the volunteers have dropped off every bag.'
      }[s.key];
      return (
        <>
          <div className="kl-sheet-head plain">
            <div>
              <h3>{s.emoji} {s.label}</h3>
              <p>{s.hint}</p>
            </div>
          </div>
          {i === 0 ? (
            <p className="kl-note">
              The kitchen is cooking {dayMeals(t)} meals today. The next steps move when labels
              print and when you copy the list.
            </p>
          ) : status === 'done' ? (
            <>
              <div className="kl-sheet-status">{when ? `Done at ${when}` : 'Done'}</div>
              <p className="kl-note">{auto}</p>
              <button
                type="button"
                className="kl-btn small ghost"
                onClick={() => {
                  if (confirm(`Undo ${s.label}? Any later steps will be undone too.`)) handleUndo(i);
                }}
              >
                Undo {s.label}
              </button>
            </>
          ) : (
            <>
              <p className="kl-note">{auto}</p>
              <button type="button" className="kl-btn small" onClick={() => handleMarkStage(i)}>
                Mark {s.label} now
              </button>
            </>
          )}
        </>
      );
    }
    return null;
  };

  const sheetContent = renderSheet();

  return (
    <div className="kl-page">
      <header className="kl-top">
        <a href="/admin" className="kl-back">{'‹'} Admin</a>
        <div className="kl-title">Kitchen Live</div>
        <span className={`kl-live ${live ? 'on' : ''}`}>{live ? 'Live' : 'Connecting'}</span>
      </header>

      <div className="kl-wrap">
        <div className="kl-datebar">
          <button type="button" onClick={() => go(-1)} aria-label="Previous day">{'‹'}</button>
          <div className="kl-date">
            <strong>{longDate(dateStr)}</strong>
            {dateStr === today && <span className="kl-today">TODAY</span>}
          </div>
          <button type="button" onClick={() => go(1)} aria-label="Next day">{'›'}</button>
        </div>

        {loadError && <div className="kl-error">{loadError}</div>}

        <div className={`kl-kpis ${t && t.specialBoxes > 0 ? 'four' : ''}`}>
          <Kpi
            icon={'\u{1F6CD}️'}
            value={t ? t.bags : '–'}
            label="Bags"
            sub={t ? (day.isThursday ? `${t.regularBags} Thu · ${t.satBags} Sat` : `${t.families} families`) : ''}
          />
          <Kpi
            icon={'\u{1F372}'}
            value={t ? dayMeals(t) : '–'}
            label="Meals"
            sub={t && day.isThursday ? `${t.thuPeople} Thu · ${t.satPeople} Sat` : ''}
          />
          <Kpi
            icon={'\u{1F690}'}
            value={day ? groups.length : '–'}
            label="Groups"
            sub={day ? `${day.pickups.length} pickups` : ''}
          />
          {t && t.specialBoxes > 0 && (
            <Kpi icon={'✨'} value={t.specialBoxes} label="Holiday boxes" sub={day.specialWeeks[0]?.title} />
          )}
        </div>

        <section className="kl-scene-card">
          <div className="kl-scene" ref={sceneBox} />
          <div className="kl-stage-chip">
            {current.emoji} {current.label}
            {currentTime && <span> {'·'} {currentTime}</span>}
          </div>
          {sceneState === 'ready' && (
            <div className="kl-zoom">
              <button type="button" onClick={() => sceneRef.current?.zoomBy(1.3)} aria-label="Zoom in">+</button>
              <button type="button" onClick={() => sceneRef.current?.zoomBy(1 / 1.3)} aria-label="Zoom out">{'−'}</button>
              <button type="button" onClick={() => sceneRef.current?.resetView()} aria-label="Reset view">{'⟲'}</button>
            </div>
          )}
          {sceneState === 'failed' && (
            <div className="kl-scene-msg">The 3D view isn&apos;t available on this device. Everything below still works.</div>
          )}
          {sceneState !== 'failed' && !ready && <div className="kl-scene-msg">Loading the kitchen{'…'}</div>}
          {sceneState === 'ready' && ready && <div className="kl-hint">Drag to spin {'·'} tap anything</div>}
        </section>

        <section className="kl-card">
          <div className="kl-card-head">
            <h2>Today&apos;s run</h2>
            <span>{Math.min(stage + (stage === 3 ? 1 : 0), 4)}/4</span>
          </div>
          <ol className="kl-steps">
            {STAGES.map((s, i) => {
              const status = stepStatus(i);
              const time = s.field ? fmtTime(row?.[s.field]) : '';
              return (
                <li key={s.key} className={`kl-step ${status}`}>
                  <button type="button" onClick={() => setSheet({ type: 'step', index: i })}>
                    <span className="kl-step-dot">{status === 'done' ? '✓' : s.emoji}</span>
                    <span className="kl-step-label">{s.label}</span>
                    <span className="kl-step-time">
                      {time || (status === 'done' ? (i === 0 ? 'Cooked' : 'Skipped') : s.hint)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </section>

        <section className="kl-card">
          <div className="kl-card-head">
            <h2>Groups</h2>
            <span>{groups.length}</span>
          </div>
          {day && groups.length === 0 && day.pickups.length === 0 && (
            <p className="kl-note">No deliveries on {longDate(dateStr)}.</p>
          )}
          <div className="kl-groups">
            {groups.map(g => (
              <button
                type="button"
                key={g.key}
                className={`kl-group ${sheet?.key === g.key ? 'active' : ''}`}
                style={{ '--g': g.color }}
                onClick={() => setSheet({ type: 'group', key: g.key })}
              >
                <span className="kl-badge">{g.label}</span>
                <span className="kl-group-main">
                  <strong>{g.special ? `${g.emoji} ${g.title}` : g.title}</strong>
                  <small>
                    {g.bags} {g.special ? 'boxes' : 'bags'}
                    {g.areas.length ? ` · ${g.areas.slice(0, 2).join(', ')}` : ''}
                  </small>
                </span>
                <span className="kl-group-status">{STATUS_ICON[stage]}</span>
              </button>
            ))}
            {day && day.pickups.length > 0 && (
              <button
                type="button"
                className={`kl-group ${sheet?.type === 'pickup' ? 'active' : ''}`}
                style={{ '--g': PICKUP_COLOR }}
                onClick={() => setSheet({ type: 'pickup' })}
              >
                <span className="kl-badge">P</span>
                <span className="kl-group-main">
                  <strong>Pickup at the kitchen</strong>
                  <small>{day.pickups.length} families</small>
                </span>
                <span className="kl-group-status">{stage === 3 ? '✅' : '\u{1F3E0}'}</span>
              </button>
            )}
          </div>
        </section>
      </div>

      {sheetContent && (
        <div className="kl-sheet" role="dialog" aria-modal="false">
          <button type="button" className="kl-sheet-close" onClick={() => setSheet(null)} aria-label="Close">{'×'}</button>
          {sheetContent}
        </div>
      )}

      {toast && (
        <div key={toast.id} className={`kl-toast ${toast.kind}`} role="status">
          <span>{toast.text}</span>
          {toast.action && (
            <button
              type="button"
              onClick={() => {
                setToast(null);
                toast.action.run();
              }}
            >
              {toast.action.label}
            </button>
          )}
        </div>
      )}

      <div className="kl-dock">
        <button type="button" className="kl-btn primary" onClick={handleCopyList} disabled={!ready || !t.bags}>
          <span className="kl-btn-main">{'\u{1F4CB}'} {stage >= 2 ? 'Copy list again' : 'Copy list'}</span>
          <span className="kl-btn-sub">
            {stage >= 2 && row?.copied_at ? `sent at ${fmtTime(row.copied_at)}` : 'for the WhatsApp group'}
          </span>
        </button>
        <button
          type="button"
          className={`kl-btn secondary ${stage === 3 ? 'done' : ''}`}
          onClick={() => secondary.run?.()}
          disabled={!ready || !secondary.run || (!t.bags && stage < 3)}
        >
          <span className="kl-btn-main">{secondary.icon} {secondary.main}</span>
          <span className="kl-btn-sub">{secondary.sub}</span>
        </button>
      </div>
    </div>
  );
}
