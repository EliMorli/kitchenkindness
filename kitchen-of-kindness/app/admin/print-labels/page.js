'use client';

import { Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { supabase } from '../../../lib/supabase';
import { computeGroups, groupBadge } from '../../../lib/groups';
import { formatAddress, formatNote } from '../../../lib/format';
import { attachPauses, isDayPaused, isSaturdayPaused } from '../../../lib/pauses';
import { loadSpecialOrdersForDate } from '../../../lib/weeks';

// Labels: JADENS 4 in × 6 in thermal shipping labels (portrait).
// Printer paper-size driver setting should match (any standard 4×6 thermal printer).
const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parseDateParam(dateStr) {
  if (!dateStr) return null;
  const parts = dateStr.split('-').map(Number);
  if (parts.length !== 3 || parts.some(n => Number.isNaN(n))) return null;
  const [y, m, d] = parts;
  return new Date(y, m - 1, d);
}

function formatFullDate(date) {
  return `${dayNames[date.getDay()]}, ${monthNames[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
}

function PrintLabelsContent() {
  const searchParams = useSearchParams();
  const dateStr = searchParams.get('date');
  const date = parseDateParam(dateStr);
  // silent=1: opened from the admin "Print labels" button on the kitchen PC,
  // where Chrome/Edge runs with --kiosk-printing (no dialog). Print at once,
  // confirm, and close the tab so the admin lands back on the Sign-ups view.
  const silent = searchParams.get('silent') === '1';
  // test=1: one fixed sample label to verify the printer setup on any day.
  // pdf=1: render only, never auto-print (for a future headless renderer).
  const testMode = searchParams.get('test') === '1';
  const pdfMode = searchParams.get('pdf') === '1';

  const [families, setFamilies] = useState([]);
  const [specialWeeks, setSpecialWeeks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [authed, setAuthed] = useState(null); // null = checking
  const [layoutReady, setLayoutReady] = useState(false);
  const [printTriggered, setPrintTriggered] = useState(false);
  // idle | printing | done | no-labels | timeout
  const [printStatus, setPrintStatus] = useState('idle');
  const labelRefs = useRef([]);

  // Same lightweight gate as /admin: the page lists family addresses.
  useEffect(() => {
    try {
      setAuthed(localStorage.getItem('kok_admin_authenticated') === 'true');
    } catch {
      setAuthed(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (testMode || !supabase) {
        setLoading(false);
        return;
      }
      try {
        const { data, error } = await supabase
          .from('families')
          .select('*')
          .eq('active', true)
          .order('family_id', { ascending: true });
        if (error) throw error;
        const withPauses = await attachPauses(supabase, data || []);
        const weeks = dateStr ? await loadSpecialOrdersForDate(supabase, dateStr) : [];
        if (!cancelled) {
          setFamilies(withPauses);
          setSpecialWeeks(weeks);
        }
      } catch (e) {
        console.error('Error loading families:', e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const labels = [];
  if (testMode) {
    labels.push({
      kind: 'saturday',
      group: 1,
      family: {
        id: 'test',
        family_id: 'TEST',
        people_count: 2,
        address: '12345 Sample Street, Valley Village, CA 91607',
        unit: '7',
        contact: '(818) 555-0123',
        instructions: 'Leave at door',
        notes: 'Test label — check size, margins, and that no header/footer printed.'
      }
    });
  } else if (date) {
    const dayName = dayNames[date.getDay()];
    const isThursday = dayName === 'Thursday';
    const deliversToday = f =>
      (!f.delivery_days || f.delivery_days.includes(dayName)) && !isDayPaused(f, dateStr);
    const satToday = f => isThursday && !!f.saturday_meals && !isSaturdayPaused(f, dateStr);
    const familiesForDay = families.filter(f => deliversToday(f) || satToday(f));
    const groups = computeGroups(familiesForDay);
    familiesForDay.forEach(f => {
      const g = groups.get(f.family_id) ?? null;
      if (deliversToday(f)) labels.push({ family: f, kind: 'regular', group: g });
      if (satToday(f)) labels.push({ family: f, kind: 'saturday', group: g });
    });
    // Sort so same-group labels print consecutively; regular before its Saturday twin.
    labels.sort((a, b) => {
      const ag = a.group ?? Infinity;
      const bg = b.group ?? Infinity;
      if (ag !== bg) return ag - bg;
      const aid = Number(a.family.family_id);
      const bid = Number(b.family.family_id);
      if (aid !== bid) return aid - bid;
      return a.kind === 'saturday' ? 1 : -1;
    });
    // Special-week orders print after the regular run, with a "Special" badge.
    specialWeeks.forEach(week => {
      week.orders.forEach(o => {
        labels.push({
          kind: 'special',
          group: null,
          weekTitle: `${week.emoji} ${week.title}`,
          family: {
            id: `order-${o.id}`,
            family_id: o.family_id,
            label: o.label,
            people_count: o.people_count,
            address: o.address,
            unit: o.unit,
            contact: o.contact,
            instructions: o.instructions,
            notes: o.notes
          }
        });
      });
    });
  }

  useLayoutEffect(() => {
    if (loading || labels.length === 0) return;
    for (let i = 0; i < labels.length; i++) {
      const el = labelRefs.current[i];
      if (!el) continue;
      const notes = el.querySelector('.label-notes');
      const address = el.querySelector('.label-address');
      let notesPt = 13;
      while (el.scrollHeight > el.clientHeight && notesPt > 8 && notes) {
        notesPt -= 1;
        notes.style.fontSize = `${notesPt}pt`;
      }
      let addrPt = 18;
      while (el.scrollHeight > el.clientHeight && addrPt > 12 && address) {
        addrPt -= 1;
        address.style.fontSize = `${addrPt}pt`;
      }
    }
    setLayoutReady(true);
  }, [loading, labels.length]);

  useEffect(() => {
    const onAfter = () => setPrintStatus('done');
    window.addEventListener('afterprint', onAfter);
    return () => window.removeEventListener('afterprint', onAfter);
  }, []);

  const reportToOpener = (status) => {
    try {
      window.opener?.postMessage(
        { type: 'kok-labels-printed', date: dateStr, total: labels.length, status, test: testMode },
        window.location.origin
      );
    } catch {}
  };

  // Silent mode: exactly one window.print() per page load, after fonts and the
  // auto-shrink layout pass are done. (Chromium throttles repeated scripted
  // prints, so all labels go as ONE multi-page job — the printer still emits
  // each label in turn.) Preview mode never auto-prints; it has a Print button.
  useEffect(() => {
    if (!silent || pdfMode || loading || !layoutReady || printTriggered || authed !== true) return;
    if (labels.length === 0) {
      setPrintStatus('no-labels');
      reportToOpener('no-labels');
      return;
    }
    let cancelled = false;
    setPrintTriggered(true);
    (document.fonts?.ready || Promise.resolve()).then(() => {
      if (cancelled) return;
      requestAnimationFrame(() => {
        if (cancelled) return;
        setPrintStatus('printing');
        window.print();
      });
    });
    return () => { cancelled = true; };
  }, [silent, pdfMode, loading, layoutReady, printTriggered, labels.length, authed]);

  // Watchdog: with --kiosk-printing, afterprint fires within a couple of
  // seconds. If it hasn't after 20 s, a real print dialog is almost certainly
  // open — say so instead of pretending the labels printed.
  useEffect(() => {
    if (printStatus !== 'printing') return;
    const t = setTimeout(() => {
      setPrintStatus(prev => (prev === 'printing' ? 'timeout' : prev));
    }, 20000);
    return () => clearTimeout(t);
  }, [printStatus]);

  // Silent mode: report back to the admin tab and close.
  useEffect(() => {
    if (!silent) return;
    if (printStatus === 'done' || printStatus === 'no-labels') {
      if (printStatus === 'done') reportToOpener('done');
      const t = setTimeout(() => {
        window.close();
        // window.close() is a no-op if the tab wasn't script-opened.
        try { window.opener?.focus(); } catch {}
      }, printStatus === 'done' ? 2500 : 4000);
      return () => clearTimeout(t);
    }
    if (printStatus === 'timeout') reportToOpener('timeout');
  }, [silent, printStatus]);

  const printAgain = () => {
    setPrintStatus('printing');
    window.print();
  };

  if (authed === false) {
    return (
      <div style={{ padding: 20, fontFamily: 'system-ui, sans-serif' }}>
        Please log in to the <a href="/admin">admin</a> first, then use Print labels from the Sign-ups tab.
      </div>
    );
  }

  if (!testMode && (!dateStr || !date)) {
    return (
      <div style={{ padding: 20, fontFamily: 'system-ui, sans-serif' }}>
        Missing or invalid <code>?date=YYYY-MM-DD</code> parameter.
      </div>
    );
  }

  if (loading || authed === null) {
    return <div style={{ padding: 20, fontFamily: 'system-ui, sans-serif' }}>Loading…</div>;
  }

  return (
    <>
      <style>{`
        /* margin: 0 makes the page box exactly one 4x6 label and leaves no
           room for the browser's header/footer, so silent printing never
           depends on that checkbox. Physical paper size still comes from the
           printer's default (must be 4x6 in) — CSS can't choose paper. */
        @page { size: 4in 6in; margin: 0; }
        * { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
        @media print {
          html, body { background: #fff; margin: 0; padding: 0; }
          .no-print { display: none !important; }
          .labels .label-page { margin: 0; border: none; }
          .labels .label-page + .label-page { break-before: page; page-break-before: always; }
        }
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
          background: #eee;
        }
        .toolbar {
          padding: 12px 16px;
          background: #fff;
          border-bottom: 1px solid #ddd;
          display: flex;
          gap: 12px;
          align-items: center;
          flex-wrap: wrap;
          position: sticky;
          top: 0;
          z-index: 10;
        }
        .toolbar button {
          padding: 8px 14px;
          font-size: 14px;
          cursor: pointer;
          border-radius: 6px;
          border: 1px solid #ccc;
          background: #f7f7f7;
        }
        .toolbar button:hover { background: #efefef; }
        .toolbar.silent { border-left: 6px solid #0891b2; }
        .toolbar.silent.done { border-left-color: #10b981; background: #ecfdf5; }
        .toolbar.silent strong { font-size: 1.05rem; }
        .toolbar .hint { color: #555; font-size: 12px; max-width: 600px; }
        .label-page {
          width: 4in;
          height: 6in;
          padding: 0.3in;
          margin: 0.25in auto;
          box-sizing: border-box;
          background: #fff;
          color: #000;
          border: 1px dashed #aaa;
          display: flex;
          flex-direction: column;
          gap: 0.1in;
          position: relative;
          overflow: hidden;
          page-break-inside: avoid;
          break-inside: avoid;
        }
        .label-id {
          font-size: 72pt;
          font-weight: 800;
          line-height: 1;
          letter-spacing: -1px;
        }
        .label-id-text { font-size: 30pt; line-height: 1.05; word-break: break-word; }
        .label-meals {
          font-size: 36pt;
          font-weight: 700;
          line-height: 1.05;
        }
        .label-address {
          font-size: 18pt;
          line-height: 1.2;
          word-break: break-word;
        }
        .label-phone {
          font-size: 18pt;
          font-weight: 600;
        }
        .label-notes {
          font-size: 13pt;
          line-height: 1.25;
          color: #222;
          word-break: break-word;
          margin-top: auto;
        }
        .sat-badge {
          position: absolute;
          top: 0.1in;
          right: 0.1in;
          background: #c8102e;
          color: #fff;
          font-weight: 800;
          font-size: 22pt;
          padding: 0.04in 0.1in;
          border-radius: 0.05in;
          letter-spacing: 2px;
        }
      `}</style>

      {silent ? (
        <div className={`toolbar no-print silent ${printStatus}`}>
          <strong>
            {printStatus === 'done'
              ? `✓ Handed ${labels.length} label${labels.length === 1 ? '' : 's'} to the printer`
              : printStatus === 'no-labels'
                ? 'No labels for this day'
                : printStatus === 'timeout'
                  ? '⚠️ Printing did not start'
                  : printStatus === 'printing'
                    ? `🖨️ Sending ${labels.length} label${labels.length === 1 ? '' : 's'} to the printer…`
                    : `Preparing ${labels.length} label${labels.length === 1 ? '' : 's'}…`}
          </strong>
          <span className="hint">{testMode ? 'Test label' : formatFullDate(date)}</span>
          {(printStatus === 'done' || printStatus === 'timeout') && (
            <>
              <button onClick={printAgain}>🖨️ Print again</button>
              <button onClick={() => window.close()}>Close</button>
            </>
          )}
          {printStatus === 'done' && <span className="hint">Watch the printer — this tab closes by itself in a moment.</span>}
          {printStatus === 'no-labels' && <span className="hint">This tab closes by itself in a moment.</span>}
          {printStatus === 'timeout' && (
            <span className="hint">
              A print dialog is probably open, which means this window wasn't started from the
              "Kitchen Admin (silent print)" shortcut. Close every window of that browser, reopen it from
              the shortcut, and try again. See Printer setup on the Sign-ups tab.
            </span>
          )}
        </div>
      ) : (
        <div className="toolbar no-print">
          <strong>{testMode ? 'Test label' : formatFullDate(date)}</strong>
          <span className="hint">{labels.length} label{labels.length === 1 ? '' : 's'}</span>
          <button onClick={printAgain}>🖨️ Print</button>
          <button onClick={() => window.close()}>Close</button>
          <span className="hint">
            Sized for 4×6 in thermal labels (portrait). In the print dialog, set paper size to 4×6 and disable
            headers/footers.
          </span>
        </div>
      )}

      {labels.length === 0 ? (
        <div style={{ padding: 20 }}>No deliveries scheduled for {formatFullDate(date)}.</div>
      ) : (
        <div className="labels" data-ready={layoutReady ? '1' : '0'}>
        {labels.map((label, i) => {
          const f = label.family;
          const isSat = label.kind === 'saturday';
          const notes = [f.instructions, f.notes].filter(Boolean).map(formatNote).join(' — ');
          return (
            <div
              key={`${f.id}-${label.kind}`}
              ref={el => { labelRefs.current[i] = el; }}
              className="label-page"
            >
              {isSat && <div className="sat-badge">SAT</div>}
              <div className="label-group-badge">
                {label.kind === 'special' ? `✨ Special · ${label.weekTitle}` : groupBadge(label.group, f).text}
              </div>
              <div className={`label-id ${f.family_id == null ? 'label-id-text' : ''}`}>
                {f.family_id != null ? `#${f.family_id}` : (f.label || 'Special')}
              </div>
              <div className="label-meals">Meals: {f.people_count || '?'}</div>
              <div className="label-address">{formatAddress(f.address, f.unit)}</div>
              {f.contact && <div className="label-phone">📞 {f.contact}</div>}
              {notes && <div className="label-notes">📋 {notes}</div>}
            </div>
          );
        })}
        </div>
      )}
    </>
  );
}

export default function PrintLabelsPage() {
  return (
    <Suspense fallback={<div style={{ padding: 20, fontFamily: 'system-ui, sans-serif' }}>Loading…</div>}>
      <PrintLabelsContent />
    </Suspense>
  );
}
