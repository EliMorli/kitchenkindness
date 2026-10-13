'use client';

import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { groupBadge } from '../../lib/groups';
import { formatAddress, formatNote } from '../../lib/format';
import { attachPauses } from '../../lib/pauses';
import { loadSpecialOrdersForDate, orderTitle } from '../../lib/weeks';
import { buildDay } from '../../lib/day';
import { buildWhatsAppList, buildChecklist } from '../../lib/whatsapp';
import { markCopied, logStage } from '../../lib/kitchenDays';

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
  const [printFlash, setPrintFlash] = useState(false);
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

  const copyToClipboard = async (text, setFlash) => {
    try {
      await navigator.clipboard.writeText(text);
      setFlash(true);
      setTimeout(() => setFlash(false), 1500);
      return true;
    } catch (err) {
      console.error('Clipboard write failed:', err);
      return false;
    }
  };

  // Copying the list is how volunteers get their groups (they answer in
  // WhatsApp), so it also moves the day to "Delivering" on Kitchen Live.
  const day = buildDay(families, specialWeeks, dateForSelectedDay());

  const handleCopyList = async () => {
    if (await copyToClipboard(buildWhatsAppList(day), setCopiedFlash)) {
      logStage(markCopied, supabase, day.dateStr);
    }
  };

  const handleCopyChecklist = async () => {
    if (await copyToClipboard(buildChecklist(day, window.location.origin), setCopiedChecklistFlash)) {
      logStage(markCopied, supabase, day.dateStr);
    }
  };

  // The print tab moves the day to "Packing" on Kitchen Live as the job starts.
  // The date is worked out on click: this page is often left open for days.
  const handlePrintLabels = () => {
    window.open(`/admin/print-labels?date=${dateForSelectedDay()}&silent=1`, '_blank');
    setPrintFlash(true);
    setTimeout(() => setPrintFlash(false), 2500);
  };

  const specialOrders = day.specialOrders;
  const specialPeople = day.totals.specialPeople;

  const todayStr = dayNames[new Date().getDay()];
  const filteredFamilies = day.families;
  const isThursday = day.isThursday;
  const getsThursdayMeal = (f) => !!f.deliversToday;
  const getsSaturdayMeal = (f) => !!f.satToday;
  const totalPeople = day.totals.people;
  const thursdayPeople = day.totals.thuPeople;
  const saturdayPeople = day.totals.satPeople;

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
            title="Copy the day's groups for the volunteers' WhatsApp group"
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
            onClick={handlePrintLabels}
            disabled={filteredFamilies.length === 0 && specialOrders.length === 0}
            title="Print this day's labels (regular + special orders). Silent from the kitchen shortcut; needs the admin login once in this browser. Printing moves the day to Packing on Kitchen Live."
          >
            {printFlash ? '✓ Sent to printer' : '🖨️ Print labels'}
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
                        {/* Special-order notes hold the recipient's name — kitchen sees only the instruction. */}
                        {[o.instructions].filter(Boolean).map(formatNote).join(' — ') || '-'}
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
