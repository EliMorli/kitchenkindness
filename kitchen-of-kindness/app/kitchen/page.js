'use client';

import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { computeGroups, groupBadge, isPickup } from '../../lib/groups';
import { formatAddress, formatNote, addressArea } from '../../lib/format';
import { attachPauses, isDayPaused, isSaturdayPaused } from '../../lib/pauses';
import { loadSpecialOrdersForDate, orderTitle } from '../../lib/weeks';

const DELIVERY_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'];
const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const getDefaultDay = () => {
  const today = new Date().getDay();
  if (today >= 0 && today <= 4) return dayNames[today];
  return 'Sunday';
};

export default function KitchenPage() {
  const [families, setFamilies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedDay, setSelectedDay] = useState(getDefaultDay);
  const [copiedFlash, setCopiedFlash] = useState(false);
  const [copiedChecklistFlash, setCopiedChecklistFlash] = useState(false);
  const [specialWeeks, setSpecialWeeks] = useState([]);

  useEffect(() => {
    loadFamilies();
  }, []);

  const loadFamilies = async () => {
    if (!supabase) { setLoading(false); return; }
    try {
      const { data, error } = await supabase
        .from('families')
        .select('*')
        .eq('active', true)
        .order('family_id', { ascending: true });

      if (error) throw error;
      setFamilies(await attachPauses(supabase, data || []));
    } catch (error) {
      console.error('Error loading families:', error);
    }
    setLoading(false);
  };

  // The calendar date of the selected day name: today if the names match,
  // otherwise the next occurrence of that weekday. Local time, no UTC shift.
  const dateForSelectedDay = () => {
    const target = dayNames.indexOf(selectedDay);
    const d = new Date();
    while (d.getDay() !== target) d.setDate(d.getDate() + 1);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  };

  // Special-week orders that apply to the selected day.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!supabase) return;
      try {
        const weeks = await loadSpecialOrdersForDate(supabase, dateForSelectedDay());
        if (!cancelled) setSpecialWeeks(weeks);
      } catch (e) {
        console.error('Error loading special orders:', e);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedDay]);

  const getFamiliesForDay = () => {
    const dateStr = dateForSelectedDay();
    const list = families
      .map(f => {
        const inDays = !f.delivery_days || f.delivery_days.includes(selectedDay);
        const deliversToday = inDays && !isDayPaused(f, dateStr);
        const satToday = selectedDay === 'Thursday' && !!f.saturday_meals && !isSaturdayPaused(f, dateStr);
        return { ...f, deliversToday, satToday };
      })
      .filter(f => f.deliversToday || f.satToday);
    const groups = computeGroups(list);
    return list
      .map(f => ({ ...f, group: groups.get(f.family_id) ?? null }))
      .sort((a, b) => {
        const ag = a.group ?? Infinity;
        const bg = b.group ?? Infinity;
        if (ag !== bg) return ag - bg;
        return Number(a.family_id) - Number(b.family_id);
      });
  };

  const partitionForDay = (fams) => {
    const grouped = new Map();
    const pickups = [];
    const ungrouped = [];
    fams.forEach(f => {
      if (f.group != null) {
        if (!grouped.has(f.group)) grouped.set(f.group, []);
        grouped.get(f.group).push(f);
      } else if (isPickup(f)) {
        pickups.push(f);
      } else {
        ungrouped.push(f);
      }
    });
    return { grouped, pickups, ungrouped };
  };

  // WhatsApp-ready list of the day's deliveries, grouped: the admin copies
  // this and pastes it into the volunteers group chat.
  const buildWhatsAppList = (fams) => {
    const { grouped, pickups, ungrouped } = partitionForDay(fams);
    const familyLine = f => {
      const sat = f.satToday ? ' (+Sat)' : '';
      return `${f.family_id} \u2014 ${addressArea(f.address) || '\u2014'}${sat}`;
    };
    const lines = [`\u{1F372} Kitchen of Kindness \u2014 ${selectedDay} deliveries`, ''];
    for (const [g, list] of grouped) {
      lines.push(`*Group ${g}* (${list.length} ${list.length === 1 ? 'bag' : 'bags'})`);
      list.forEach(f => lines.push(familyLine(f)));
      lines.push('');
    }
    if (ungrouped.length) {
      lines.push('*Ungrouped*');
      ungrouped.forEach(f => lines.push(familyLine(f)));
      lines.push('');
    }
    if (pickups.length) {
      lines.push(`*Pickup at kitchen*: ${pickups.map(f => f.family_id).join(', ')}`);
      lines.push('');
    }
    lines.push(...specialSection());
    return lines.join('\n').trim();
  };

  // Checklist variant: leads with a link to the live claim page (the volunteer
  // sign-up view for this date), where volunteers check off the bags they take
  // and everyone sees what's left.
  const buildChecklist = (fams) => {
    const { grouped, pickups, ungrouped } = partitionForDay(fams);
    const familyLine = f => {
      const sat = f.satToday ? ' (+Sat)' : '';
      return `${f.family_id} \u2014 ${addressArea(f.address) || '\u2014'}${sat}`;
    };
    const lines = [
      `\u{1F372} Kitchen of Kindness \u2014 ${selectedDay} deliveries`,
      '',
      '\u2705 *Tap here to claim your bags (live list):*',
      `${window.location.origin}/?date=${dateForSelectedDay()}`,
      ''
    ];
    for (const [g, list] of grouped) {
      lines.push(`*Group ${g}* (${list.length} ${list.length === 1 ? 'bag' : 'bags'})`);
      list.forEach(f => lines.push(familyLine(f)));
      lines.push('');
    }
    if (ungrouped.length) {
      lines.push('*Ungrouped*');
      ungrouped.forEach(f => lines.push(familyLine(f)));
      lines.push('');
    }
    if (pickups.length) {
      lines.push(`*Pickup at kitchen*: ${pickups.map(f => f.family_id).join(', ')}`);
      lines.push('');
    }
    lines.push(...specialSection());
    return lines.join('\n').trim();
  };

  const copyToClipboard = async (text, setFlash) => {
    try {
      await navigator.clipboard.writeText(text);
      setFlash(true);
      setTimeout(() => setFlash(false), 1500);
    } catch (err) {
      console.error('Clipboard write failed:', err);
    }
  };

  const handleCopyList = () =>
    copyToClipboard(buildWhatsAppList(filteredFamilies), setCopiedFlash);

  const handleCopyChecklist = () =>
    copyToClipboard(buildChecklist(filteredFamilies), setCopiedChecklistFlash);

  const specialOrders = specialWeeks.flatMap(w => w.orders.map(o => ({ ...o, weekTitle: `${w.emoji} ${w.title}` })));
  const specialPeople = specialOrders.reduce((sum, o) => sum + (o.people_count || 0), 0);
  const specialSection = () => {
    const lines = [];
    specialWeeks.forEach(w => {
      lines.push(`*✨ ${w.emoji} ${w.title}* (${w.orders.length} ${w.orders.length === 1 ? 'box' : 'boxes'})`);
      w.orders.forEach(o => lines.push(`${orderTitle(o)} — ${addressArea(o.address) || o.instructions || '—'}`));
      lines.push('');
    });
    return lines;
  };

  const todayStr = dayNames[new Date().getDay()];
  const filteredFamilies = getFamiliesForDay();
  const isThursday = selectedDay === 'Thursday';
  const getsThursdayMeal = (f) => !!f.deliversToday;
  const getsSaturdayMeal = (f) => !!f.satToday;
  const totalPeople = filteredFamilies.reduce((sum, f) => sum + (f.people_count || 0), 0);
  const thursdayPeople = filteredFamilies
    .filter(getsThursdayMeal)
    .reduce((sum, f) => sum + (f.people_count || 0), 0);
  const saturdayPeople = filteredFamilies
    .filter(getsSaturdayMeal)
    .reduce((sum, f) => sum + (f.people_count || 0), 0);

  if (loading) {
    return (
      <div className="kitchen-loading">
        <p>Loading...</p>
      </div>
    );
  }

  return (
    <div className="kitchen-container">
      <header className="kitchen-header">
        <h1>Kitchen of Kindness</h1>
        <div className="kitchen-summary">
          <button
            className="kitchen-copy-btn"
            onClick={handleCopyList}
            disabled={filteredFamilies.length === 0}
            title="Copy the day's groups with a map link per family"
          >
            {copiedFlash ? '\u2713 Copied!' : '\u{1F4CB} Copy list'}
          </button>
          <button
            className="kitchen-copy-btn"
            onClick={handleCopyChecklist}
            disabled={filteredFamilies.length === 0}
            title="Copy the day's groups as a checklist with a live claim link on top"
          >
            {copiedChecklistFlash ? '\u2713 Copied!' : '\u2705 Copy checklist'}
          </button>
          <button
            className="kitchen-copy-btn"
            onClick={() => window.open(`/admin/print-labels?date=${dateForSelectedDay()}&silent=1`, '_blank')}
            disabled={filteredFamilies.length === 0 && specialOrders.length === 0}
            title="Print this day's labels (regular + special orders). Silent from the kitchen shortcut; needs the admin login once in this browser."
          >
            🖨️ Print labels
          </button>
          <span className="kitchen-summary-item">{filteredFamilies.length} Families</span>
          {isThursday ? (
            <>
              <span className="kitchen-summary-item">{thursdayPeople} Thu People</span>
              <span className="kitchen-summary-item">{saturdayPeople} Sat People</span>
            </>
          ) : (
            <span className="kitchen-summary-item">{totalPeople} People</span>
          )}
          {specialOrders.length > 0 && (
            <span className="kitchen-summary-item">+{specialOrders.length} special ({specialPeople} ppl)</span>
          )}
        </div>
      </header>

      <div className="kitchen-day-selector">
        {DELIVERY_DAYS.map(day => (
          <button
            key={day}
            className={`kitchen-day-btn ${selectedDay === day ? 'active' : ''} ${todayStr === day ? 'today' : ''}`}
            onClick={() => setSelectedDay(day)}
          >
            {day}
            {todayStr === day && <span className="kitchen-today-dot"></span>}
          </button>
        ))}
      </div>

      <div className="kitchen-table-wrapper">
        <table className="kitchen-table">
          <thead>
            <tr>
              <th className="col-group">Group</th>
              <th className="col-id">#</th>
              {isThursday ? (
                <>
                  <th className="col-people">Thu People</th>
                  <th className="col-people">Sat People</th>
                </>
              ) : (
                <th className="col-people">People</th>
              )}
              <th className="col-notes">Notes / Instructions</th>
              <th className="col-address">Address</th>
            </tr>
          </thead>
          <tbody>
            {filteredFamilies.length === 0 ? (
              <tr>
                <td colSpan={isThursday ? 6 : 5} className="kitchen-empty">
                  No families scheduled for {selectedDay}
                </td>
              </tr>
            ) : (
              filteredFamilies.map((family, idx) => (
                <tr key={family.id} className={idx % 2 === 0 ? 'row-even' : 'row-odd'}>
                  <td className="col-group">
                    <span className={groupBadge(family.group, family).className}>{groupBadge(family.group, family).short}</span>
                  </td>
                  <td className="col-id">{family.family_id}</td>
                  {isThursday ? (
                    <>
                      <td className="col-people">{getsThursdayMeal(family) ? (family.people_count || '-') : '-'}</td>
                      <td className="col-people">{getsSaturdayMeal(family) ? (family.people_count || '-') : '-'}</td>
                    </>
                  ) : (
                    <td className="col-people">{family.people_count || '-'}</td>
                  )}
                  <td className="col-notes">
                    {[family.instructions, family.notes].filter(Boolean).map(formatNote).join(' — ') || '-'}
                  </td>
                  <td className="col-address">{formatAddress(family.address, family.unit)}</td>
                </tr>
              ))
            )}
          </tbody>
          {filteredFamilies.length > 0 && (
            <tfoot>
              <tr>
                <td className="col-group"></td>
                <td className="col-id"><strong>Total</strong></td>
                {isThursday ? (
                  <>
                    <td className="col-people"><strong>{thursdayPeople}</strong></td>
                    <td className="col-people"><strong>{saturdayPeople}</strong></td>
                  </>
                ) : (
                  <td className="col-people"><strong>{totalPeople}</strong></td>
                )}
                <td className="col-notes"></td>
                <td className="col-address"></td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {specialWeeks.map(week => {
        const total = week.orders.reduce((s, o) => s + (o.people_count || 0), 0);
        return (
          <div key={week.id} className="kitchen-special">
            <h2 className="kitchen-special-title">{week.emoji} Special Week — {week.title}</h2>
            <div className="kitchen-table-wrapper">
              <table className="kitchen-table">
                <thead>
                  <tr>
                    <th className="col-id">#</th>
                    <th className="col-people">People</th>
                    <th className="col-notes">Notes / Instructions</th>
                    <th className="col-address">Address</th>
                  </tr>
                </thead>
                <tbody>
                  {week.orders.map((o, idx) => (
                    <tr key={o.id} className={idx % 2 === 0 ? 'row-even' : 'row-odd'}>
                      <td className={`col-id ${o.family_id == null ? 'col-id-text' : ''}`}>{orderTitle(o)}</td>
                      <td className="col-people">{o.people_count || '-'}</td>
                      <td className="col-notes">
                        {[o.instructions, o.notes].filter(Boolean).map(formatNote).join(' — ') || '-'}
                      </td>
                      <td className="col-address">{o.address ? formatAddress(o.address, o.unit) : '-'}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td className="col-id"><strong>Total</strong></td>
                    <td className="col-people"><strong>{total}</strong></td>
                    <td className="col-notes"></td>
                    <td className="col-address"></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        );
      })}
    </div>
  );
}
