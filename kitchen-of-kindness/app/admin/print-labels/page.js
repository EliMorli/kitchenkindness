'use client';

import { Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { supabase } from '../../../lib/supabase';
import { computeGroups, groupBadge } from '../../../lib/groups';
import { formatAddress, formatNote } from '../../../lib/format';

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

  const [families, setFamilies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [printTriggered, setPrintTriggered] = useState(false);
  const labelRefs = useRef([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!supabase) {
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
        if (!cancelled) setFamilies(data || []);
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
  if (date) {
    const dayName = dayNames[date.getDay()];
    const isThursday = dayName === 'Thursday';
    const familiesForDay = families.filter(f => {
      const onThisDay = !f.delivery_days || f.delivery_days.includes(dayName);
      const shabbatOnThursday = isThursday && f.saturday_meals;
      return onThisDay || shabbatOnThursday;
    });
    const groups = computeGroups(familiesForDay);
    familiesForDay.forEach(f => {
      const g = groups.get(f.family_id) ?? null;
      const onThisDay = !f.delivery_days || f.delivery_days.includes(dayName);
      if (onThisDay) labels.push({ family: f, kind: 'regular', group: g });
      if (isThursday && f.saturday_meals) labels.push({ family: f, kind: 'saturday', group: g });
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
  }, [loading, labels.length]);

  useEffect(() => {
    if (loading || printTriggered || labels.length === 0) return;
    const t = setTimeout(() => {
      window.print();
      setPrintTriggered(true);
    }, 400);
    return () => clearTimeout(t);
  }, [loading, labels.length, printTriggered]);

  if (!dateStr || !date) {
    return (
      <div style={{ padding: 20, fontFamily: 'system-ui, sans-serif' }}>
        Missing or invalid <code>?date=YYYY-MM-DD</code> parameter.
      </div>
    );
  }

  if (loading) {
    return <div style={{ padding: 20, fontFamily: 'system-ui, sans-serif' }}>Loading…</div>;
  }

  return (
    <>
      <style>{`
        @page { size: 4in 6in; margin: 0.2in; }
        @media print {
          html, body { background: #fff; margin: 0; padding: 0; }
          .no-print { display: none !important; }
          .label-page { page-break-after: always; break-after: page; margin: 0; border: none; }
          .label-page:last-child { page-break-after: auto; break-after: auto; }
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
        .toolbar .hint { color: #555; font-size: 12px; max-width: 600px; }
        .label-page {
          width: 3.6in;
          height: 5.6in;
          padding: 0.1in;
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

      <div className="toolbar no-print">
        <strong>{formatFullDate(date)}</strong>
        <span className="hint">{labels.length} label{labels.length === 1 ? '' : 's'}</span>
        <button onClick={() => window.print()}>🖨️ Print again</button>
        <button onClick={() => window.close()}>Close</button>
        <span className="hint">
          Sized for 4×6 in thermal labels (portrait). In the print dialog, set paper size to 4×6 and disable
          headers/footers.
        </span>
      </div>

      {labels.length === 0 ? (
        <div style={{ padding: 20 }}>No deliveries scheduled for {formatFullDate(date)}.</div>
      ) : (
        labels.map((label, i) => {
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
              <div className="label-group-badge">{groupBadge(label.group, f).text}</div>
              <div className="label-id">#{f.family_id}</div>
              <div className="label-meals">Meals: {f.people_count || '?'}</div>
              <div className="label-address">{formatAddress(f.address, f.unit)}</div>
              {f.contact && <div className="label-phone">📞 {f.contact}</div>}
              {notes && <div className="label-notes">📋 {notes}</div>}
            </div>
          );
        })
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
