'use client';

import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';

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
      setFamilies(data || []);
    } catch (error) {
      console.error('Error loading families:', error);
    }
    setLoading(false);
  };

  const getFamiliesForDay = () => {
    return families.filter(f =>
      !f.delivery_days || f.delivery_days.includes(selectedDay)
    );
  };

  const todayStr = dayNames[new Date().getDay()];
  const filteredFamilies = getFamiliesForDay();
  const totalPeople = filteredFamilies.reduce((sum, f) => sum + (f.people_count || 0), 0);
  const showSaturdayCol = selectedDay === 'Thursday';

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
          <span className="kitchen-summary-item">{filteredFamilies.length} Families</span>
          <span className="kitchen-summary-item">{totalPeople} People</span>
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
              <th className="col-id">#</th>
              <th className="col-people">People</th>
              <th className="col-notes">Notes / Instructions</th>
              <th className="col-address">Address</th>
              {showSaturdayCol && <th className="col-saturday">Sat Meals</th>}
            </tr>
          </thead>
          <tbody>
            {filteredFamilies.length === 0 ? (
              <tr>
                <td colSpan={showSaturdayCol ? 5 : 4} className="kitchen-empty">
                  No families scheduled for {selectedDay}
                </td>
              </tr>
            ) : (
              filteredFamilies.map((family, idx) => (
                <tr key={family.id} className={idx % 2 === 0 ? 'row-even' : 'row-odd'}>
                  <td className="col-id">{family.family_id}</td>
                  <td className="col-people">{family.people_count || '-'}</td>
                  <td className="col-notes">
                    {[family.instructions, family.notes].filter(Boolean).join(' — ') || '-'}
                  </td>
                  <td className="col-address">{family.address}</td>
                  {showSaturdayCol && (
                    <td className={`col-saturday ${family.saturday_meals ? 'sat-yes' : 'sat-no'}`}>
                      {family.saturday_meals ? 'YES' : '-'}
                    </td>
                  )}
                </tr>
              ))
            )}
          </tbody>
          {filteredFamilies.length > 0 && (
            <tfoot>
              <tr>
                <td className="col-id"><strong>Total</strong></td>
                <td className="col-people"><strong>{totalPeople}</strong></td>
                <td className="col-notes"></td>
                <td className="col-address"></td>
                {showSaturdayCol && (
                  <td className="col-saturday">
                    <strong>{filteredFamilies.filter(f => f.saturday_meals).length}</strong>
                  </td>
                )}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
