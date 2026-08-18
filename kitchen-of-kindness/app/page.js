'use client';

import { useState, useEffect, useMemo } from 'react';
import { supabase } from '../lib/supabase';
import { computeGroups, groupBadge } from '../lib/groups';
import { formatAddress, formatNote } from '../lib/format';

// Families are loaded from Supabase - empty fallback if database is unavailable
const fallbackFamilies = [];

const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Generate dates from Jan 25 to Jun 30, 2026 (Sun-Thu only)
const generateDeliveryDates = () => {
  const dates = [];
  const start = new Date(2026, 0, 25);
  const end = new Date(2026, 5, 30);

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const day = d.getDay();
    if (day >= 0 && day <= 4) {
      dates.push(new Date(d));
    }
  }
  return dates;
};

const deliveryDates = generateDeliveryDates();

// Get today or nearest delivery day
const getInitialDate = () => {
  const today = new Date();
  // Check if today is a delivery day (Sun-Thu)
  if (today.getDay() >= 0 && today.getDay() <= 4) {
    return today;
  }
  // If Friday or Saturday, show next Sunday
  const daysUntilSunday = 7 - today.getDay();
  const nextSunday = new Date(today);
  nextSunday.setDate(today.getDate() + daysUntilSunday);
  return nextSunday;
};

export default function Home() {
  const [loading, setLoading] = useState(true);
  const [families, setFamilies] = useState(fallbackFamilies);
  const [assignments, setAssignments] = useState({});
  const [viewMode, setViewMode] = useState('today'); // 'today' or 'week'
  const [currentDate, setCurrentDate] = useState(getInitialDate());
  const [currentWeekStart, setCurrentWeekStart] = useState(() => {
    const today = new Date();
    const sunday = new Date(today);
    sunday.setDate(today.getDate() - today.getDay());
    return sunday;
  });
  const [showSignupModal, setShowSignupModal] = useState(false);
  const [selectedDate, setSelectedDate] = useState(null);
  const [selectedFamily, setSelectedFamily] = useState(null);
  const [volunteerName, setVolunteerName] = useState('');
  const [volunteerPhone, setVolunteerPhone] = useState('');
  const [showDetailsModal, setShowDetailsModal] = useState(false);
  const [selectedAssignment, setSelectedAssignment] = useState(null);

  // Load saved volunteer info
  useEffect(() => {
    const savedName = localStorage.getItem('kok_volunteer_name');
    const savedPhone = localStorage.getItem('kok_volunteer_phone');
    if (savedName) setVolunteerName(savedName);
    if (savedPhone) setVolunteerPhone(savedPhone);
  }, []);

  // Load families and assignments from Supabase
  useEffect(() => {
    loadFamilies();
    loadAssignments();
  }, []);

  const loadFamilies = async () => {
    if (!supabase) return;
    try {
      const { data, error } = await supabase
        .from('families')
        .select('*')
        .eq('active', true)
        .order('family_id', { ascending: true });

      if (error) {
        console.log('Families table not found, using fallback data');
        return;
      }

      if (data && data.length > 0) {
        const formattedFamilies = data.map(f => ({
          id: f.family_id,
          family_id: f.family_id,
          address: f.address,
          instructions: f.instructions || 'Leave at door',
          contact: f.contact || '',
          delivery_days: f.delivery_days || ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'],
          unit: f.unit || '',
          latitude: f.latitude ?? null,
          longitude: f.longitude ?? null
        }));
        setFamilies(formattedFamilies);
      }
    } catch (error) {
      console.error('Error loading families:', error);
    }
  };

  const loadAssignments = async () => {
    if (!supabase) { setLoading(false); return; }
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('delivery_assignments')
        .select('*')
        .is('cancelled_at', null);

      if (error) throw error;

      const assignmentMap = {};
      data?.forEach(item => {
        assignmentMap[item.slot_key] = {
          volunteer: item.volunteer_name,
          phone: item.volunteer_phone || '',
          signedUpAt: item.created_at,
          deliveredAt: item.delivered_at || null
        };
      });
      setAssignments(assignmentMap);
    } catch (error) {
      console.error('Error loading assignments:', error);
    }
    setLoading(false);
  };

  const getAssignmentKey = (date, familyId) => {
    return `${date.toISOString().split('T')[0]}-${familyId}`;
  };

  const handleSlotClick = (date, family) => {
    setSelectedDate(date);
    setSelectedFamily(family);
    setShowSignupModal(true);
  };

  const handleTakenSlotClick = (date, family, assignment) => {
    setSelectedDate(date);
    setSelectedFamily(family);
    setSelectedAssignment(assignment);
    setShowDetailsModal(true);
  };

  const handleMarkDelivered = async () => {
    if (!supabase) return;
    const key = getAssignmentKey(selectedDate, selectedFamily.id);

    try {
      const { error } = await supabase
        .from('delivery_assignments')
        .update({ delivered_at: new Date().toISOString() })
        .eq('slot_key', key);

      if (error) throw error;

      setAssignments(prev => ({
        ...prev,
        [key]: {
          ...prev[key],
          deliveredAt: new Date().toISOString()
        }
      }));

      setShowDetailsModal(false);
    } catch (error) {
      console.error('Error marking as delivered:', error);
      alert('Error marking as delivered. Please try again.');
    }
  };

  const handleSignup = async () => {
    if (!volunteerName.trim() || !volunteerPhone.trim() || !supabase) return;

    const key = getAssignmentKey(selectedDate, selectedFamily.id);

    try {
      const { error } = await supabase
        .from('delivery_assignments')
        .upsert({
          slot_key: key,
          delivery_date: selectedDate.toISOString().split('T')[0],
          family_id: selectedFamily.id,
          volunteer_name: volunteerName.trim(),
          volunteer_phone: volunteerPhone.trim(),
          cancelled_at: null,
          delivered_at: null
        }, { onConflict: 'slot_key' });

      if (error) throw error;

      setAssignments(prev => ({
        ...prev,
        [key]: {
          volunteer: volunteerName.trim(),
          phone: volunteerPhone.trim(),
          signedUpAt: new Date().toISOString()
        }
      }));

      // Remember volunteer info for next time
      localStorage.setItem('kok_volunteer_name', volunteerName.trim());
      localStorage.setItem('kok_volunteer_phone', volunteerPhone.trim());

      setShowSignupModal(false);
    } catch (error) {
      console.error('Error signing up:', error);
      alert('Error signing up. Please try again.');
    }
  };

  const handleRemoveSignup = async (date, familyId) => {
    if (!supabase) return;
    const key = getAssignmentKey(date, familyId);

    try {
      const { error } = await supabase
        .from('delivery_assignments')
        .update({ cancelled_at: new Date().toISOString() })
        .eq('slot_key', key);

      if (error) throw error;

      setAssignments(prev => {
        const newAssignments = { ...prev };
        delete newAssignments[key];
        return newAssignments;
      });
    } catch (error) {
      console.error('Error removing signup:', error);
      alert('Error removing signup. Please try again.');
    }
  };

  const getWeekDates = () => {
    const dates = [];
    const start = new Date(currentWeekStart);
    for (let i = 0; i < 7; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const day = d.getDay();
      if (day >= 0 && day <= 4) {
        dates.push(d);
      }
    }
    return dates;
  };

  const navigateWeek = (direction) => {
    const newStart = new Date(currentWeekStart);
    newStart.setDate(currentWeekStart.getDate() + (direction * 7));
    if (newStart >= new Date(2026, 0, 25) && newStart <= new Date(2026, 5, 30)) {
      setCurrentWeekStart(newStart);
    }
  };

  // Navigate single day
  const navigateDay = (direction) => {
    let newDate = new Date(currentDate);
    do {
      newDate.setDate(newDate.getDate() + direction);
    } while (newDate.getDay() === 5 || newDate.getDay() === 6); // Skip Fri/Sat

    // Keep within delivery date range
    if (newDate >= new Date(2026, 0, 25) && newDate <= new Date(2026, 5, 30)) {
      setCurrentDate(newDate);
    }
  };

  const goToToday = () => {
    setCurrentDate(getInitialDate());
    setViewMode('today');
  };

  const formatDate = (date) => {
    return `${monthNames[date.getMonth()]} ${date.getDate()}`;
  };

  const formatFullDate = (date) => {
    return `${dayNames[date.getDay()]}, ${monthNames[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
  };

  const isToday = (date) => {
    const today = new Date();
    return date.toDateString() === today.toDateString();
  };

  const isOwnSignup = (assignment) => {
    const savedName = localStorage.getItem('kok_volunteer_name');
    if (!savedName || !assignment) return false;
    return assignment.volunteer.trim().toLowerCase() === savedName.trim().toLowerCase();
  };

  const getFamiliesForDate = (date) => {
    const dayName = dayNames[date.getDay()];
    const list = families.filter(f => !f.delivery_days || f.delivery_days.includes(dayName));
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

  // Stats for a specific date
  const getStatsForDate = (date) => {
    const familiesForDate = getFamiliesForDate(date);
    const dateStr = date.toISOString().split('T')[0];
    let filled = 0;
    let delivered = 0;

    familiesForDate.forEach(family => {
      const key = `${dateStr}-${family.id}`;
      if (assignments[key]) {
        filled++;
        if (assignments[key].deliveredAt) delivered++;
      }
    });

    return {
      total: familiesForDate.length,
      filled,
      delivered,
      open: familiesForDate.length - filled
    };
  };

  const getStats = () => {
    let totalSlots = 0;
    deliveryDates.forEach(date => {
      totalSlots += getFamiliesForDate(date).length;
    });
    const filledSlots = Object.keys(assignments).length;
    const volunteerCounts = {};
    Object.values(assignments).forEach(a => {
      volunteerCounts[a.volunteer] = (volunteerCounts[a.volunteer] || 0) + 1;
    });
    return { totalSlots, filledSlots, volunteerCounts };
  };

  // Loading Screen
  if (loading) {
    return (
      <div className="loading">
        <div className="loading-spinner"></div>
        <p>Loading schedule...</p>
      </div>
    );
  }

  const stats = getStats();
  const todayStats = getStatsForDate(currentDate);

  return (
    <>
      <header className="header">
        <h1>🍲 Kitchen of Kindness</h1>
        <p>Volunteer Delivery Sign-Up</p>
      </header>

      {/* View Toggle */}
      <div className="view-toggle">
        <button
          className={`toggle-btn ${viewMode === 'today' ? 'active' : ''}`}
          onClick={() => setViewMode('today')}
        >
          Today
        </button>
        <button
          className={`toggle-btn ${viewMode === 'week' ? 'active' : ''}`}
          onClick={() => setViewMode('week')}
        >
          Week View
        </button>
      </div>

      {/* Today View */}
      {viewMode === 'today' && (
        <>
          {/* Today Stats */}
          <div className="today-stats-bar">
            <div className="today-date-display">
              <span className="today-day">{formatFullDate(currentDate)}</span>
              {isToday(currentDate) && <span className="today-badge-large">TODAY</span>}
            </div>
            <div className="today-stats">
              <div className="today-stat">
                <span className="today-stat-value">{todayStats.filled}</span>
                <span className="today-stat-label">Filled</span>
              </div>
              <div className="today-stat">
                <span className="today-stat-value open">{todayStats.open}</span>
                <span className="today-stat-label">Open</span>
              </div>
              <div className="today-stat">
                <span className="today-stat-value delivered">{todayStats.delivered}</span>
                <span className="today-stat-label">Delivered</span>
              </div>
            </div>
          </div>

          <div className="main-content">
            {/* Day Navigation */}
            <div className="day-nav">
              <button onClick={() => navigateDay(-1)}>
                ← Previous Day
              </button>
              {!isToday(currentDate) && (
                <button className="today-btn" onClick={goToToday}>
                  Go to Today
                </button>
              )}
              <button onClick={() => navigateDay(1)}>
                Next Day →
              </button>
            </div>

            {/* Single Day Slots */}
            <div className="today-slots">
              {getFamiliesForDate(currentDate).map(family => {
                const key = getAssignmentKey(currentDate, family.id);
                const assignment = assignments[key];

                return (
                  <div
                    key={family.id}
                    className={`slot slot-large ${assignment ? (assignment.deliveredAt ? 'slot-delivered' : 'slot-taken') : 'slot-open'}`}
                    onClick={() => assignment ? handleTakenSlotClick(currentDate, family, assignment) : handleSlotClick(currentDate, family)}
                  >
                    <div className="slot-main">
                      <div className="slot-family">
                        Family #{family.id}
                        <span className={groupBadge(family.group, family).className}>{groupBadge(family.group, family).text}</span>
                      </div>
                      <div className="slot-address">{formatAddress(family.address, family.unit)}</div>
                      <div className="slot-meta">
                        <span>📋 {formatNote(family.instructions)}</span>
                        {family.contact && <span>📞 {family.contact}</span>}
                      </div>
                    </div>
                    {assignment ? (
                      <div className="slot-volunteer">
                        <div className="volunteer-info">
                          <span className="volunteer-name">{assignment.deliveredAt ? '✅' : '✓'} {assignment.volunteer}</span>
                          {assignment.phone && <span className="volunteer-phone">📞 {assignment.phone}</span>}
                          {assignment.deliveredAt && <span className="delivered-badge">DELIVERED</span>}
                        </div>
                        {isOwnSignup(assignment) && !assignment.deliveredAt && (
                          <button
                            className="remove-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleRemoveSignup(currentDate, family.id);
                            }}
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    ) : (
                      <div className="slot-volunteer">
                        <span className="open-badge">OPEN - Click to sign up</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}

      {/* Week View */}
      {viewMode === 'week' && (
        <>
          <div className="stats-bar">
            <div className="stat">
              <div className="stat-value">{stats.filledSlots}</div>
              <div className="stat-label">Slots Filled</div>
            </div>
            <div className="stat">
              <div className="stat-value">{stats.totalSlots - stats.filledSlots}</div>
              <div className="stat-label">Slots Open</div>
            </div>
            <div className="stat">
              <div className="stat-value">{Object.keys(stats.volunteerCounts).length}</div>
              <div className="stat-label">Volunteers</div>
            </div>
            <div className="stat">
              <div className="stat-value">{families.length}</div>
              <div className="stat-label">Families</div>
            </div>
          </div>

          <div className="main-content">
            <div className="week-nav">
              <button
                onClick={() => navigateWeek(-1)}
                disabled={currentWeekStart <= new Date(2026, 0, 25)}
              >
                ← Previous Week
              </button>
              <span className="week-title">
                Week of {formatDate(currentWeekStart)}, {currentWeekStart.getFullYear()}
              </span>
              <button
                onClick={() => navigateWeek(1)}
                disabled={currentWeekStart >= new Date(2026, 5, 28)}
              >
                Next Week →
              </button>
            </div>

            <div className="calendar-grid">
              {getWeekDates().map(date => (
                <div className="day-column" key={date.toISOString()}>
                  <div className="day-header">
                    <span className="day-name">
                      {dayNames[date.getDay()]}
                      {isToday(date) && <span className="today-badge">TODAY</span>}
                    </span>
                    <div className="day-date">{formatDate(date)}, {date.getFullYear()}</div>
                  </div>
                  <div className="slots-container">
                    {getFamiliesForDate(date).map(family => {
                      const key = getAssignmentKey(date, family.id);
                      const assignment = assignments[key];

                      return (
                        <div
                          key={family.id}
                          className={`slot ${assignment ? (assignment.deliveredAt ? 'slot-delivered' : 'slot-taken') : 'slot-open'}`}
                          onClick={() => assignment ? handleTakenSlotClick(date, family, assignment) : handleSlotClick(date, family)}
                        >
                          <div className="slot-family">
                            Family #{family.id}
                            <span className={groupBadge(family.group, family).className}>{groupBadge(family.group, family).text}</span>
                          </div>
                          <div className="slot-address">{formatAddress(family.address, family.unit)}</div>
                          <div className="slot-meta">
                            <span>📋 {formatNote(family.instructions)}</span>
                          </div>
                          {assignment ? (
                            <div className="slot-volunteer">
                              <div className="volunteer-info">
                                <span className="volunteer-name">{assignment.deliveredAt ? '✅' : '✓'} {assignment.volunteer}</span>
                                {assignment.phone && <span className="volunteer-phone">📞 {assignment.phone}</span>}
                                {assignment.deliveredAt && <span className="delivered-badge">DELIVERED</span>}
                              </div>
                              {isOwnSignup(assignment) && !assignment.deliveredAt && (
                                <button
                                  className="remove-btn"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleRemoveSignup(date, family.id);
                                  }}
                                >
                                  Remove
                                </button>
                              )}
                            </div>
                          ) : (
                            <div className="slot-volunteer">
                              <span className="open-badge">OPEN - Click to sign up</span>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>

            {Object.keys(stats.volunteerCounts).length > 0 && (
              <div className="leaderboard">
                <h3>🙌 Our Amazing Volunteers</h3>
                <div className="volunteer-list">
                  {Object.entries(stats.volunteerCounts)
                    .sort((a, b) => b[1] - a[1])
                    .map(([name, count]) => (
                      <div className="volunteer-chip" key={name}>
                        {name}: <strong>{count} delivery{count > 1 ? 'ies' : ''}</strong>
                      </div>
                    ))}
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {showSignupModal && (
        <div className="modal-overlay" onClick={() => setShowSignupModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2>Sign Up for Delivery</h2>
            <p className="modal-subtitle">Thank you for volunteering! 💛</p>

            <div className="modal-info">
              <div className="modal-info-row">
                <span className="modal-info-label">Date</span>
                <span className="modal-info-value">
                  {dayNames[selectedDate.getDay()]}, {formatDate(selectedDate)}
                </span>
              </div>
              <div className="modal-info-row">
                <span className="modal-info-label">Family</span>
                <span className="modal-info-value">
                  #{selectedFamily.id}
                  <span className={groupBadge(selectedFamily.group, selectedFamily).className}>{groupBadge(selectedFamily.group, selectedFamily).text}</span>
                </span>
              </div>
              <div className="modal-info-row">
                <span className="modal-info-label">Address</span>
                <span className="modal-info-value">{formatAddress(selectedFamily.address, selectedFamily.unit)}</span>
              </div>
              <div className="modal-info-row">
                <span className="modal-info-label">Instructions</span>
                <span className="modal-info-value">{formatNote(selectedFamily.instructions)}</span>
              </div>
              {selectedFamily.contact && (
                <div className="modal-info-row">
                  <span className="modal-info-label">Contact</span>
                  <span className="modal-info-value">{selectedFamily.contact}</span>
                </div>
              )}
            </div>

            <input
              type="text"
              placeholder="Enter your name"
              value={volunteerName}
              onChange={(e) => setVolunteerName(e.target.value)}
              autoFocus
            />

            <input
              type="tel"
              placeholder="Enter your phone number"
              value={volunteerPhone}
              onChange={(e) => setVolunteerPhone(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSignup()}
            />

            <div className="modal-buttons">
              <button className="btn-secondary" onClick={() => setShowSignupModal(false)}>
                Cancel
              </button>
              <button className="btn-primary" onClick={handleSignup}>
                Sign Up
              </button>
            </div>
          </div>
        </div>
      )}

      {showDetailsModal && selectedAssignment && (
        <div className="modal-overlay" onClick={() => setShowDetailsModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2>Delivery Details</h2>
            <p className="modal-subtitle">
              {selectedAssignment.deliveredAt ? 'This delivery is complete! ✅' : 'Ready to deliver? 🚗'}
            </p>

            <div className="modal-info">
              <div className="modal-info-row">
                <span className="modal-info-label">Date</span>
                <span className="modal-info-value">
                  {dayNames[selectedDate.getDay()]}, {formatDate(selectedDate)}
                </span>
              </div>
              <div className="modal-info-row">
                <span className="modal-info-label">Family</span>
                <span className="modal-info-value">#{selectedFamily.id}</span>
              </div>
              <div className="modal-info-row">
                <span className="modal-info-label">Address</span>
                <span className="modal-info-value">{formatAddress(selectedFamily.address, selectedFamily.unit)}</span>
              </div>
              <div className="modal-info-row">
                <span className="modal-info-label">Instructions</span>
                <span className="modal-info-value">{formatNote(selectedFamily.instructions)}</span>
              </div>
              {selectedFamily.contact && (
                <div className="modal-info-row">
                  <span className="modal-info-label">Family Contact</span>
                  <span className="modal-info-value">{selectedFamily.contact}</span>
                </div>
              )}
              <div className="modal-info-row">
                <span className="modal-info-label">Volunteer</span>
                <span className="modal-info-value">{selectedAssignment.volunteer}</span>
              </div>
              {selectedAssignment.phone && (
                <div className="modal-info-row">
                  <span className="modal-info-label">Volunteer Phone</span>
                  <span className="modal-info-value">{selectedAssignment.phone}</span>
                </div>
              )}
              {selectedAssignment.deliveredAt && (
                <div className="modal-info-row">
                  <span className="modal-info-label">Delivered At</span>
                  <span className="modal-info-value">
                    {new Date(selectedAssignment.deliveredAt).toLocaleString()}
                  </span>
                </div>
              )}
            </div>

            <div className="modal-buttons">
              <button className="btn-secondary" onClick={() => setShowDetailsModal(false)}>
                Close
              </button>
              {!selectedAssignment.deliveredAt && (
                <button className="btn-primary btn-delivered" onClick={handleMarkDelivered}>
                  ✓ Mark as Delivered
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
