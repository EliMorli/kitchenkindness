'use client';

import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';

// Fallback family data (used if Supabase table doesn't exist yet)
const fallbackFamilies = [
  { id: 350, address: "12619 Miranda St, North Hollywood, CA", instructions: "Leave at door", contact: "(818) 482-9559", bags: 3 },
  { id: 351, address: "5247 Corteen Pl, Valley Village, CA 91607", instructions: "Call when arrive", contact: "(323) 528-7899", bags: 2 },
  { id: 352, address: "5465 White Oak Ave Apt 212, Encino, CA 91316", instructions: "Leave at door", contact: "", bags: 1 },
  { id: 353, address: "18342 Ventura Blvd, CA", instructions: "Leave at door", contact: "", bags: 1 },
  { id: 354, address: "6413 Wystone Ave, Reseda, CA 91335", instructions: "Leave at door", contact: "", bags: 2 },
  { id: 355, address: "12720 Burbank Blvd #127, Valley Village, CA 90035", instructions: "Leave at door", contact: "(718) 909-0378", bags: 3 },
];

const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Generate dates from Jan 25 to Mar 25, 2026 (Sun-Thu only)
const generateDeliveryDates = () => {
  const dates = [];
  const start = new Date(2026, 0, 25);
  const end = new Date(2026, 2, 25);
  
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const day = d.getDay();
    if (day >= 0 && day <= 4) {
      dates.push(new Date(d));
    }
  }
  return dates;
};

const deliveryDates = generateDeliveryDates();

// Site password - change this to your desired password
const SITE_PASSWORD = process.env.NEXT_PUBLIC_SITE_PASSWORD || 'kindness2026';

export default function Home() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [passwordInput, setPasswordInput] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [loading, setLoading] = useState(true);
  const [families, setFamilies] = useState(fallbackFamilies);
  const [assignments, setAssignments] = useState({});
  const [currentWeekStart, setCurrentWeekStart] = useState(new Date(2026, 0, 25));
  const [showSignupModal, setShowSignupModal] = useState(false);
  const [selectedDate, setSelectedDate] = useState(null);
  const [selectedFamily, setSelectedFamily] = useState(null);
  const [volunteerName, setVolunteerName] = useState('');
  const [volunteerPhone, setVolunteerPhone] = useState('');

  // Check if already authenticated
  useEffect(() => {
    const auth = localStorage.getItem('kok_authenticated');
    if (auth === 'true') {
      setIsAuthenticated(true);
    }
    setLoading(false);
  }, []);

  // Load families and assignments from Supabase
  useEffect(() => {
    if (isAuthenticated) {
      loadFamilies();
      loadAssignments();
    }
  }, [isAuthenticated]);

  const loadFamilies = async () => {
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
          address: f.address,
          instructions: f.instructions || 'Leave at door',
          contact: f.contact || '',
          bags: (f.bags || 1) + (f.extra_bags || 0),
          delivery_days: f.delivery_days || ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday']
        }));
        setFamilies(formattedFamilies);
      }
    } catch (error) {
      console.error('Error loading families:', error);
    }
  };

  const loadAssignments = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('delivery_assignments')
        .select('*');
      
      if (error) throw error;
      
      const assignmentMap = {};
      data?.forEach(item => {
        assignmentMap[item.slot_key] = {
          volunteer: item.volunteer_name,
          phone: item.volunteer_phone || '',
          signedUpAt: item.created_at
        };
      });
      setAssignments(assignmentMap);
    } catch (error) {
      console.error('Error loading assignments:', error);
    }
    setLoading(false);
  };

  const handlePasswordSubmit = (e) => {
    e.preventDefault();
    if (passwordInput === SITE_PASSWORD) {
      setIsAuthenticated(true);
      localStorage.setItem('kok_authenticated', 'true');
      setPasswordError('');
    } else {
      setPasswordError('Incorrect password. Please try again.');
    }
  };

  const getAssignmentKey = (date, familyId) => {
    return `${date.toISOString().split('T')[0]}-${familyId}`;
  };

  const handleSlotClick = (date, family) => {
    setSelectedDate(date);
    setSelectedFamily(family);
    setShowSignupModal(true);
  };

  const handleSignup = async () => {
    if (!volunteerName.trim() || !volunteerPhone.trim()) return;

    const key = getAssignmentKey(selectedDate, selectedFamily.id);

    try {
      const { error } = await supabase
        .from('delivery_assignments')
        .insert({
          slot_key: key,
          delivery_date: selectedDate.toISOString().split('T')[0],
          family_id: selectedFamily.id,
          volunteer_name: volunteerName.trim(),
          volunteer_phone: volunteerPhone.trim()
        });

      if (error) throw error;

      setAssignments(prev => ({
        ...prev,
        [key]: {
          volunteer: volunteerName.trim(),
          phone: volunteerPhone.trim(),
          signedUpAt: new Date().toISOString()
        }
      }));

      setShowSignupModal(false);
      setVolunteerName('');
      setVolunteerPhone('');
    } catch (error) {
      console.error('Error signing up:', error);
      alert('Error signing up. Please try again.');
    }
  };

  const handleRemoveSignup = async (date, familyId) => {
    const key = getAssignmentKey(date, familyId);
    
    try {
      const { error } = await supabase
        .from('delivery_assignments')
        .delete()
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
    if (newStart >= new Date(2026, 0, 25) && newStart <= new Date(2026, 2, 25)) {
      setCurrentWeekStart(newStart);
    }
  };

  const formatDate = (date) => {
    return `${monthNames[date.getMonth()]} ${date.getDate()}`;
  };

  const isToday = (date) => {
    const today = new Date();
    return date.toDateString() === today.toDateString();
  };

  const getFamiliesForDate = (date) => {
    const dayName = dayNames[date.getDay()];
    return families.filter(f => !f.delivery_days || f.delivery_days.includes(dayName));
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

  // Password Screen
  if (!isAuthenticated) {
    return (
      <div className="password-screen">
        <div className="password-card">
          <h1>🍲 Kitchen of Kindness</h1>
          <p>Enter the volunteer password to continue</p>
          <form onSubmit={handlePasswordSubmit}>
            <input
              type="password"
              placeholder="Enter password"
              value={passwordInput}
              onChange={(e) => setPasswordInput(e.target.value)}
              autoFocus
            />
            <button type="submit">Enter</button>
          </form>
          {passwordError && <p className="password-error">{passwordError}</p>}
        </div>
      </div>
    );
  }

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

  return (
    <>
      <header className="header">
        <h1>🍲 Kitchen of Kindness</h1>
        <p>Volunteer Delivery Sign-Up</p>
      </header>

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
            Week of {formatDate(currentWeekStart)}, 2026
          </span>
          <button 
            onClick={() => navigateWeek(1)}
            disabled={currentWeekStart >= new Date(2026, 2, 22)}
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
                <div className="day-date">{formatDate(date)}, 2026</div>
              </div>
              <div className="slots-container">
                {getFamiliesForDate(date).map(family => {
                  const key = getAssignmentKey(date, family.id);
                  const assignment = assignments[key];

                  return (
                    <div
                      key={family.id}
                      className={`slot ${assignment ? 'slot-taken' : 'slot-open'}`}
                      onClick={() => !assignment && handleSlotClick(date, family)}
                    >
                      <div className="slot-family">Family #{family.id}</div>
                      <div className="slot-address">{family.address}</div>
                      <div className="slot-meta">
                        <span>📦 {family.bags} bag{family.bags > 1 ? 's' : ''}</span>
                        <span>📋 {family.instructions}</span>
                      </div>
                      {assignment ? (
                        <div className="slot-volunteer">
                          <div className="volunteer-info">
                            <span className="volunteer-name">✓ {assignment.volunteer}</span>
                            {assignment.phone && <span className="volunteer-phone">📞 {assignment.phone}</span>}
                          </div>
                          <button
                            className="remove-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleRemoveSignup(date, family.id);
                            }}
                          >
                            Remove
                          </button>
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
                <span className="modal-info-value">#{selectedFamily.id}</span>
              </div>
              <div className="modal-info-row">
                <span className="modal-info-label">Address</span>
                <span className="modal-info-value">{selectedFamily.address}</span>
              </div>
              <div className="modal-info-row">
                <span className="modal-info-label">Bags</span>
                <span className="modal-info-value">{selectedFamily.bags}</span>
              </div>
              <div className="modal-info-row">
                <span className="modal-info-label">Instructions</span>
                <span className="modal-info-value">{selectedFamily.instructions}</span>
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
    </>
  );
}
