'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { supabase } from '../../../lib/supabase';

// Default label dimensions — tune these once the actual thermal label is identified.
// Common Brother QL label: 62mm × 90mm. Adjust the @page size + .label-page width/min-height below.
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
    families.forEach(f => {
      const onThisDay = !f.delivery_days || f.delivery_days.includes(dayName);
      if (onThisDay) {
        labels.push({ family: f, kind: 'regular' });
      }
      if (isThursday && f.saturday_meals) {
        labels.push({ family: f, kind: 'saturday' });
      }
    });
  }

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
        @page { size: 62mm 90mm; margin: 4mm; }
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
          width: 54mm;
          min-height: 82mm;
          padding: 2mm;
          margin: 6mm auto;
          box-sizing: border-box;
          background: #fff;
          color: #000;
          border: 1px dashed #aaa;
          display: flex;
          flex-direction: column;
          gap: 1.5mm;
          position: relative;
          page-break-inside: avoid;
          break-inside: avoid;
        }
        .label-id {
          font-size: 28pt;
          font-weight: 800;
          line-height: 1;
          letter-spacing: -0.5px;
        }
        .label-meals {
          font-size: 18pt;
          font-weight: 700;
          line-height: 1.1;
        }
        .label-address {
          font-size: 11pt;
          line-height: 1.25;
          word-break: break-word;
        }
        .label-phone {
          font-size: 11pt;
          font-weight: 600;
        }
        .label-notes {
          font-size: 9pt;
          line-height: 1.25;
          color: #222;
          word-break: break-word;
          margin-top: auto;
        }
        .sat-badge {
          position: absolute;
          top: 2mm;
          right: 2mm;
          background: #c8102e;
          color: #fff;
          font-weight: 800;
          font-size: 11pt;
          padding: 1mm 2mm;
          border-radius: 1mm;
          letter-spacing: 1px;
        }
      `}</style>

      <div className="toolbar no-print">
        <strong>{formatFullDate(date)}</strong>
        <span className="hint">{labels.length} label{labels.length === 1 ? '' : 's'}</span>
        <button onClick={() => window.print()}>🖨️ Print again</button>
        <button onClick={() => window.close()}>Close</button>
        <span className="hint">
          Tip: in the print dialog, set paper size to your label and disable headers/footers. Once you confirm
          the printer/label, adjust the <code>@page size</code> at the top of <code>app/admin/print-labels/page.js</code>.
        </span>
      </div>

      {labels.length === 0 ? (
        <div style={{ padding: 20 }}>No deliveries scheduled for {formatFullDate(date)}.</div>
      ) : (
        labels.map(label => {
          const f = label.family;
          const isSat = label.kind === 'saturday';
          const notes = [f.instructions, f.notes].filter(Boolean).join(' — ');
          return (
            <div key={`${f.id}-${label.kind}`} className="label-page">
              {isSat && <div className="sat-badge">SAT</div>}
              <div className="label-id">#{f.family_id}</div>
              <div className="label-meals">Meals: {f.people_count || '?'}</div>
              <div className="label-address">{f.address}</div>
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
