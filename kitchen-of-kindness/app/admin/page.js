'use client';

import { useState, useEffect, useRef } from 'react';
import Script from 'next/script';
import { supabase } from '../../lib/supabase';

const ADMIN_PASSWORD = process.env.NEXT_PUBLIC_ADMIN_PASSWORD;
const GOOGLE_MAPS_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
const ALL_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'];
const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

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

const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DELIVERY_RANGE_START = new Date(2026, 0, 25);
const DELIVERY_RANGE_END = new Date(2026, 5, 30);

const getInitialDeliveryDate = () => {
  const today = new Date();
  if (today.getDay() >= 0 && today.getDay() <= 4) return today;
  const daysUntilSunday = 7 - today.getDay();
  const next = new Date(today);
  next.setDate(today.getDate() + daysUntilSunday);
  return next;
};

const getInitialWeekStart = () => {
  const today = new Date();
  const sunday = new Date(today);
  sunday.setDate(today.getDate() - today.getDay());
  return sunday;
};

export default function AdminPage() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [passwordInput, setPasswordInput] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [families, setFamilies] = useState([]);
  const [assignments, setAssignments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [activeTab, setActiveTab] = useState('dashboard');
  const [filterWeek, setFilterWeek] = useState('all');
  const [historySearch, setHistorySearch] = useState('');
  const [historyFilter, setHistoryFilter] = useState('all');
  const [allRecords, setAllRecords] = useState([]);
  const [signupsView, setSignupsView] = useState('today');
  const [signupsDate, setSignupsDate] = useState(getInitialDeliveryDate);
  const [signupsWeekStart, setSignupsWeekStart] = useState(getInitialWeekStart);
  const [googleReady, setGoogleReady] = useState(false);
  const [googleFailed, setGoogleFailed] = useState(false);
  const addressInputRef = useRef(null);
  const [copiedFlash, setCopiedFlash] = useState(false);

  // Form state
  const [formData, setFormData] = useState({
    address: '',
    instructions: 'Leave at door',
    contact: '',
    people_count: 1,
    delivery_days: [...ALL_DAYS],
    notes: '',
    saturday_meals: false,
    active: true
  });

  useEffect(() => {
    const auth = localStorage.getItem('kok_admin_authenticated');
    if (auth === 'true') {
      setIsAuthenticated(true);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (isAuthenticated) {
      loadFamilies();
      loadAssignments();
    }
  }, [isAuthenticated]);

  useEffect(() => {
    // Intercept Google Maps auth failures BEFORE the API script runs.
    // Without this, an invalid/expired/quota-exceeded key triggers a modal alert
    // that blocks all page interaction (including typing in the address field).
    window.gm_authFailure = () => {
      console.warn('Google Maps API auth failed — falling back to manual address entry.');
      setGoogleFailed(true);
    };
    return () => {
      window.gm_authFailure = undefined;
    };
  }, []);

  useEffect(() => {
    if (activeTab !== 'families') return;
    if (!googleReady) return;
    if (googleFailed) return;
    if (!addressInputRef.current) return;
    if (!window.google?.maps?.places?.Autocomplete) return;

    const ac = new window.google.maps.places.Autocomplete(addressInputRef.current, {
      types: ['address'],
      componentRestrictions: { country: 'us' },
      fields: ['formatted_address']
    });

    const listener = ac.addListener('place_changed', () => {
      const place = ac.getPlace();
      if (place?.formatted_address) {
        setFormData(prev => ({ ...prev, address: place.formatted_address }));
      }
    });

    return () => {
      if (window.google?.maps?.event) {
        window.google.maps.event.removeListener(listener);
        if (addressInputRef.current) {
          window.google.maps.event.clearInstanceListeners(addressInputRef.current);
        }
      }
    };
  }, [activeTab, googleReady, googleFailed]);

  const loadFamilies = async () => {
    if (!supabase) return;
    try {
      const { data, error } = await supabase
        .from('families')
        .select('*')
        .order('family_id', { ascending: true });

      if (error) throw error;
      setFamilies(data || []);
    } catch (error) {
      console.error('Error loading families:', error);
    }
  };

  const loadAssignments = async () => {
    if (!supabase) { setLoading(false); return; }
    try {
      // Load active assignments (not cancelled)
      const { data, error } = await supabase
        .from('delivery_assignments')
        .select('*')
        .is('cancelled_at', null)
        .order('delivery_date', { ascending: true });

      if (error) throw error;
      setAssignments(data || []);

      // Load ALL records including cancelled for history
      const { data: allData, error: allError } = await supabase
        .from('delivery_assignments')
        .select('*')
        .order('created_at', { ascending: false });

      if (!allError) {
        setAllRecords(allData || []);
      }
    } catch (error) {
      console.error('Error loading assignments:', error);
    }
    setLoading(false);
  };

  const handlePasswordSubmit = (e) => {
    e.preventDefault();
    if (passwordInput === ADMIN_PASSWORD) {
      setIsAuthenticated(true);
      localStorage.setItem('kok_admin_authenticated', 'true');
      setPasswordError('');
    } else {
      setPasswordError('Incorrect admin password.');
    }
  };

  const handleInputChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : type === 'number' ? parseInt(value) || 0 : value
    }));
  };

  const handleDayToggle = (day) => {
    setFormData(prev => ({
      ...prev,
      delivery_days: prev.delivery_days.includes(day)
        ? prev.delivery_days.filter(d => d !== day)
        : [...prev.delivery_days, day]
    }));
  };

  const getNextFamilyId = () => {
    if (families.length === 0) return 350;
    const maxId = Math.max(...families.map(f => f.family_id));
    return maxId + 1;
  };

  const resetForm = () => {
    setFormData({
      address: '',
      instructions: 'Leave at door',
      contact: '',
      people_count: 1,
      delivery_days: [...ALL_DAYS],
      notes: '',
      saturday_meals: false,
      active: true
    });
    setEditingId(null);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!formData.address.trim()) {
      alert('Address is required');
      return;
    }

    if (!supabase) return;
    setSaving(true);
    try {
      if (editingId) {
        const { error } = await supabase
          .from('families')
          .update({
            address: formData.address.trim(),
            instructions: formData.instructions.trim(),
            contact: formData.contact.trim(),
            people_count: formData.people_count,
            delivery_days: formData.delivery_days,
            notes: formData.notes.trim(),
            saturday_meals: formData.saturday_meals,
            active: formData.active
          })
          .eq('id', editingId);

        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('families')
          .insert({
            family_id: getNextFamilyId(),
            address: formData.address.trim(),
            instructions: formData.instructions.trim(),
            contact: formData.contact.trim(),
            people_count: formData.people_count,
            delivery_days: formData.delivery_days,
            notes: formData.notes.trim(),
            saturday_meals: formData.saturday_meals,
            active: formData.active
          });

        if (error) throw error;
      }

      await loadFamilies();
      resetForm();
    } catch (error) {
      console.error('Error saving family:', error);
      alert('Error saving family. Please try again.');
    }
    setSaving(false);
  };

  const handleEdit = (family) => {
    setFormData({
      address: family.address,
      instructions: family.instructions || 'Leave at door',
      contact: family.contact || '',
      people_count: family.people_count || 1,
      delivery_days: family.delivery_days || [...ALL_DAYS],
      notes: family.notes || '',
      saturday_meals: family.saturday_meals || false,
      active: family.active !== false
    });
    setEditingId(family.id);
    setActiveTab('families');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleDelete = async (family) => {
    if (!supabase) return;
    if (!confirm(`Are you sure you want to delete Family #${family.family_id}?\n\n${family.address}`)) {
      return;
    }

    try {
      const { error } = await supabase
        .from('families')
        .delete()
        .eq('id', family.id);

      if (error) throw error;
      await loadFamilies();
    } catch (error) {
      console.error('Error deleting family:', error);
      alert('Error deleting family. Please try again.');
    }
  };

  const handleCancelAssignment = async (assignment) => {
    if (!supabase) return;
    const family = families.find(f => f.family_id === assignment.family_id);
    const familyLabel = family ? `${assignment.family_id} (${family.address})` : `#${assignment.family_id}`;
    const dateLabel = formatDate(assignment.delivery_date);
    const message = assignment.delivered_at
      ? `${assignment.volunteer_name}'s delivery for family ${familyLabel} on ${dateLabel} is marked DELIVERED.\n\nClearing it will reopen the slot. The original delivery timestamp is kept in the audit trail. Continue?`
      : `Cancel ${assignment.volunteer_name}'s sign-up for family ${familyLabel} on ${dateLabel}?`;
    if (!confirm(message)) return;
    try {
      const { error } = await supabase
        .from('delivery_assignments')
        .update({ cancelled_at: new Date().toISOString() })
        .eq('id', assignment.id);

      if (error) throw error;
      await loadAssignments();
    } catch (error) {
      console.error('Error cancelling assignment:', error);
      alert('Error cancelling. Please try again.');
    }
  };

  const handleToggleActive = async (family) => {
    if (!supabase) return;
    try {
      const { error } = await supabase
        .from('families')
        .update({ active: !family.active })
        .eq('id', family.id);

      if (error) throw error;
      await loadFamilies();
    } catch (error) {
      console.error('Error updating family:', error);
    }
  };

  // Get stats
  const getStats = () => {
    const activeFamilies = families.filter(f => f.active);
    const today = new Date();
    const thisWeekStart = new Date(today);
    thisWeekStart.setDate(today.getDate() - today.getDay());
    const thisWeekEnd = new Date(thisWeekStart);
    thisWeekEnd.setDate(thisWeekStart.getDate() + 6);

    // Calculate total possible slots
    let totalSlots = 0;
    let thisWeekSlots = 0;
    deliveryDates.forEach(date => {
      const dayName = dayNames[date.getDay()];
      const familiesForDay = activeFamilies.filter(f =>
        !f.delivery_days || f.delivery_days.includes(dayName)
      );
      totalSlots += familiesForDay.length;
      if (date >= thisWeekStart && date <= thisWeekEnd) {
        thisWeekSlots += familiesForDay.length;
      }
    });

    const filledSlots = assignments.length;
    const deliveredSlots = assignments.filter(a => a.delivered_at).length;

    // This week assignments
    const thisWeekAssignments = assignments.filter(a => {
      const date = new Date(a.delivery_date);
      return date >= thisWeekStart && date <= thisWeekEnd;
    });

    // Unfilled slots for upcoming days
    const upcomingUnfilled = [];
    const nextSevenDays = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() + i);
      if (d.getDay() >= 0 && d.getDay() <= 4) {
        nextSevenDays.push(d);
      }
    }

    nextSevenDays.forEach(date => {
      const dateStr = date.toISOString().split('T')[0];
      const dayName = dayNames[date.getDay()];
      const familiesForDay = activeFamilies.filter(f =>
        !f.delivery_days || f.delivery_days.includes(dayName)
      );

      familiesForDay.forEach(family => {
        const slotKey = `${dateStr}-${family.family_id}`;
        const isAssigned = assignments.some(a => a.slot_key === slotKey);
        if (!isAssigned) {
          upcomingUnfilled.push({
            date,
            dateStr,
            family,
            dayName
          });
        }
      });
    });

    // Volunteer stats
    const volunteerCounts = {};
    assignments.forEach(a => {
      if (!volunteerCounts[a.volunteer_name]) {
        volunteerCounts[a.volunteer_name] = {
          name: a.volunteer_name,
          phone: a.volunteer_phone || '',
          count: 0,
          delivered: 0
        };
      }
      volunteerCounts[a.volunteer_name].count++;
      if (a.delivered_at) {
        volunteerCounts[a.volunteer_name].delivered++;
      }
    });

    const volunteers = Object.values(volunteerCounts).sort((a, b) => b.count - a.count);

    return {
      totalSlots,
      filledSlots,
      deliveredSlots,
      thisWeekSlots,
      thisWeekFilled: thisWeekAssignments.length,
      thisWeekDelivered: thisWeekAssignments.filter(a => a.delivered_at).length,
      upcomingUnfilled,
      volunteers,
      completionRate: filledSlots > 0 ? Math.round((deliveredSlots / filledSlots) * 100) : 0
    };
  };

  const stats = getStats();

  // Filter assignments
  const getFilteredAssignments = () => {
    let filtered = [...assignments];

    if (filterWeek === 'thisWeek') {
      const today = new Date();
      const weekStart = new Date(today);
      weekStart.setDate(today.getDate() - today.getDay());
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekStart.getDate() + 6);

      filtered = filtered.filter(a => {
        const date = new Date(a.delivery_date);
        return date >= weekStart && date <= weekEnd;
      });
    } else if (filterWeek === 'nextWeek') {
      const today = new Date();
      const nextWeekStart = new Date(today);
      nextWeekStart.setDate(today.getDate() - today.getDay() + 7);
      const nextWeekEnd = new Date(nextWeekStart);
      nextWeekEnd.setDate(nextWeekStart.getDate() + 6);

      filtered = filtered.filter(a => {
        const date = new Date(a.delivery_date);
        return date >= nextWeekStart && date <= nextWeekEnd;
      });
    }

    return filtered.sort((a, b) => new Date(a.delivery_date) - new Date(b.delivery_date));
  };

  const formatDate = (dateStr) => {
    const date = new Date(dateStr);
    return `${dayNames[date.getDay()].slice(0, 3)}, ${date.toLocaleDateString()}`;
  };

  const formatDateTime = (dateStr) => {
    if (!dateStr) return '-';
    const date = new Date(dateStr);
    return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  // Sign-ups tab helpers (mirror of volunteer view)
  const getSignupFamiliesForDate = (date) => {
    const dayName = dayNames[date.getDay()];
    return families
      .filter(f => f.active !== false)
      .filter(f => !f.delivery_days || f.delivery_days.includes(dayName));
  };

  const getSignupAssignmentForSlot = (date, familyId) => {
    const slotKey = `${date.toISOString().split('T')[0]}-${familyId}`;
    return assignments.find(a => a.slot_key === slotKey) || null;
  };

  const getSignupWeekDates = () => {
    const dates = [];
    const start = new Date(signupsWeekStart);
    for (let i = 0; i < 7; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      if (d.getDay() >= 0 && d.getDay() <= 4) dates.push(d);
    }
    return dates;
  };

  const navigateSignupDay = (direction) => {
    const newDate = new Date(signupsDate);
    do {
      newDate.setDate(newDate.getDate() + direction);
    } while (newDate.getDay() === 5 || newDate.getDay() === 6);
    if (newDate >= DELIVERY_RANGE_START && newDate <= DELIVERY_RANGE_END) {
      setSignupsDate(newDate);
    }
  };

  const navigateSignupWeek = (direction) => {
    const newStart = new Date(signupsWeekStart);
    newStart.setDate(signupsWeekStart.getDate() + direction * 7);
    if (newStart >= DELIVERY_RANGE_START && newStart <= DELIVERY_RANGE_END) {
      setSignupsWeekStart(newStart);
    }
  };

  const goToTodaySignups = () => {
    setSignupsDate(getInitialDeliveryDate());
    setSignupsWeekStart(getInitialWeekStart());
  };

  const formatShortDate = (date) => `${monthNames[date.getMonth()]} ${date.getDate()}`;
  const formatFullDate = (date) =>
    `${dayNames[date.getDay()]}, ${monthNames[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
  const isSameDay = (date) => {
    const today = new Date();
    return date.toDateString() === today.toDateString();
  };

  // Filter history records
  const getFilteredHistory = () => {
    let filtered = [...allRecords];

    if (historyFilter === 'delivered') {
      filtered = filtered.filter(a => a.delivered_at && !a.cancelled_at);
    } else if (historyFilter === 'cancelled') {
      filtered = filtered.filter(a => a.cancelled_at);
    } else if (historyFilter === 'active') {
      filtered = filtered.filter(a => !a.delivered_at && !a.cancelled_at);
    }

    if (historySearch.trim()) {
      const search = historySearch.toLowerCase();
      filtered = filtered.filter(a => {
        const family = families.find(f => f.family_id === a.family_id);
        return (
          (a.volunteer_name && a.volunteer_name.toLowerCase().includes(search)) ||
          (a.volunteer_phone && a.volunteer_phone.includes(search)) ||
          (family && family.address.toLowerCase().includes(search)) ||
          String(a.family_id).includes(search)
        );
      });
    }

    return filtered;
  };

  // Password Screen
  if (!isAuthenticated) {
    return (
      <div className="password-screen">
        <div className="password-card">
          <h1>Admin Panel</h1>
          <p>Enter admin password to continue</p>
          <form onSubmit={handlePasswordSubmit}>
            <input
              type="password"
              placeholder="Admin password"
              value={passwordInput}
              onChange={(e) => setPasswordInput(e.target.value)}
              autoFocus
            />
            <button type="submit">Enter</button>
          </form>
          {passwordError && <p className="password-error">{passwordError}</p>}
          <a href="/" style={{ marginTop: '20px', display: 'block', color: '#e07b39' }}>
            ← Back to main site
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="admin-container">
      {GOOGLE_MAPS_KEY && !googleFailed && (
        <Script
          src={`https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAPS_KEY}&libraries=places&v=weekly&loading=async`}
          strategy="afterInteractive"
          onLoad={() => setGoogleReady(true)}
          onError={() => {
            console.warn('Google Maps API failed to load — falling back to manual address entry.');
            setGoogleFailed(true);
          }}
        />
      )}
      <header className="admin-header">
        <h1>Kitchen of Kindness - Admin</h1>
        <a href="/" className="back-link">← Back to Sign-Up Page</a>
      </header>

      {/* Tab Navigation */}
      <div className="admin-tabs">
        <button
          className={`tab-btn ${activeTab === 'dashboard' ? 'active' : ''}`}
          onClick={() => setActiveTab('dashboard')}
        >
          Dashboard
        </button>
        <button
          className={`tab-btn ${activeTab === 'signups' ? 'active' : ''}`}
          onClick={() => setActiveTab('signups')}
        >
          Sign-ups
        </button>
        <button
          className={`tab-btn ${activeTab === 'assignments' ? 'active' : ''}`}
          onClick={() => setActiveTab('assignments')}
        >
          Assignments
        </button>
        <button
          className={`tab-btn ${activeTab === 'volunteers' ? 'active' : ''}`}
          onClick={() => setActiveTab('volunteers')}
        >
          Volunteers
        </button>
        <button
          className={`tab-btn ${activeTab === 'history' ? 'active' : ''}`}
          onClick={() => setActiveTab('history')}
        >
          History
        </button>
        <button
          className={`tab-btn ${activeTab === 'families' ? 'active' : ''}`}
          onClick={() => setActiveTab('families')}
        >
          Families
        </button>
      </div>

      <div className="admin-content">
        {/* Dashboard Tab */}
        {activeTab === 'dashboard' && (
          <>
            {/* Quick Stats */}
            <section className="admin-stats-section">
              <h2>Overview</h2>
              <div className="stats-grid">
                <div className="stat-card">
                  <div className="stat-number">{stats.filledSlots}</div>
                  <div className="stat-label">Total Sign-ups</div>
                </div>
                <div className="stat-card">
                  <div className="stat-number">{stats.deliveredSlots}</div>
                  <div className="stat-label">Delivered</div>
                </div>
                <div className="stat-card">
                  <div className="stat-number">{stats.completionRate}%</div>
                  <div className="stat-label">Completion Rate</div>
                </div>
                <div className="stat-card">
                  <div className="stat-number">{stats.volunteers.length}</div>
                  <div className="stat-label">Volunteers</div>
                </div>
              </div>

              <div className="stats-grid" style={{ marginTop: '16px' }}>
                <div className="stat-card highlight">
                  <div className="stat-number">{stats.thisWeekFilled}</div>
                  <div className="stat-label">This Week Sign-ups</div>
                </div>
                <div className="stat-card highlight">
                  <div className="stat-number">{stats.thisWeekDelivered}</div>
                  <div className="stat-label">This Week Delivered</div>
                </div>
              </div>
            </section>

            {/* Unfilled Slots Alert */}
            {stats.upcomingUnfilled.length > 0 && (
              <section className="admin-alert-section">
                <h2>⚠️ Unfilled Slots (Next 7 Days)</h2>
                <p className="alert-subtitle">{stats.upcomingUnfilled.length} slots need volunteers</p>
                <div className="unfilled-list">
                  {stats.upcomingUnfilled.slice(0, 10).map((slot, idx) => (
                    <div key={idx} className="unfilled-item">
                      <span className="unfilled-date">{slot.dayName.slice(0, 3)}, {slot.date.toLocaleDateString()}</span>
                      <span className="unfilled-family">Family #{slot.family.family_id}</span>
                      <span className="unfilled-address">{slot.family.address}</span>
                    </div>
                  ))}
                  {stats.upcomingUnfilled.length > 10 && (
                    <p className="more-unfilled">+ {stats.upcomingUnfilled.length - 10} more unfilled slots</p>
                  )}
                </div>
              </section>
            )}

            {stats.upcomingUnfilled.length === 0 && (
              <section className="admin-success-section">
                <h2>✅ All Slots Filled!</h2>
                <p>All delivery slots for the next 7 days have volunteers assigned.</p>
              </section>
            )}

            {/* Top Volunteers */}
            {stats.volunteers.length > 0 && (
              <section className="admin-list-section">
                <h2>Top Volunteers</h2>
                <div className="volunteer-leaderboard">
                  {stats.volunteers.slice(0, 5).map((vol, idx) => (
                    <div key={vol.name} className="leaderboard-item">
                      <span className="leaderboard-rank">#{idx + 1}</span>
                      <span className="leaderboard-name">{vol.name}</span>
                      <span className="leaderboard-count">{vol.count} deliveries</span>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </>
        )}

        {/* Sign-ups Tab — mirror of volunteer view with admin clear */}
        {activeTab === 'signups' && (
          <section className="admin-list-section">
            <div className="section-header">
              <h2>Volunteer Sign-ups</h2>
            </div>
            <p className="history-subtitle">
              Same view volunteers see. Click any filled slot's <strong>Clear</strong> button to remove the assignment — works whether it's pending or already delivered.
            </p>

            <div className="view-toggle">
              <button
                className={`toggle-btn ${signupsView === 'today' ? 'active' : ''}`}
                onClick={() => setSignupsView('today')}
              >
                Day
              </button>
              <button
                className={`toggle-btn ${signupsView === 'week' ? 'active' : ''}`}
                onClick={() => setSignupsView('week')}
              >
                Week View
              </button>
            </div>

            {signupsView === 'today' && (
              <>
                <div className="today-stats-bar">
                  <div className="today-date-display">
                    <span className="today-day">{formatFullDate(signupsDate)}</span>
                    {isSameDay(signupsDate) && <span className="today-badge-large">TODAY</span>}
                  </div>
                  {(() => {
                    const familiesForDate = getSignupFamiliesForDate(signupsDate);
                    let filled = 0;
                    let delivered = 0;
                    familiesForDate.forEach(f => {
                      const a = getSignupAssignmentForSlot(signupsDate, f.family_id);
                      if (a) {
                        filled++;
                        if (a.delivered_at) delivered++;
                      }
                    });
                    const open = familiesForDate.length - filled;
                    return (
                      <div className="today-stats">
                        <div className="today-stat">
                          <span className="today-stat-value">{filled}</span>
                          <span className="today-stat-label">Filled</span>
                        </div>
                        <div className="today-stat">
                          <span className="today-stat-value open">{open}</span>
                          <span className="today-stat-label">Open</span>
                        </div>
                        <div className="today-stat">
                          <span className="today-stat-value delivered">{delivered}</span>
                          <span className="today-stat-label">Delivered</span>
                        </div>
                      </div>
                    );
                  })()}
                </div>

                <div className="day-nav">
                  <button onClick={() => navigateSignupDay(-1)}>← Previous Day</button>
                  {!isSameDay(signupsDate) && (
                    <button className="today-btn" onClick={goToTodaySignups}>Go to Today</button>
                  )}
                  {(() => {
                    const openIds = getSignupFamiliesForDate(signupsDate)
                      .filter(f => !getSignupAssignmentForSlot(signupsDate, f.family_id))
                      .map(f => f.family_id);
                    return (
                      <button
                        className="today-btn"
                        disabled={openIds.length === 0}
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(openIds.join('\n'));
                            setCopiedFlash(true);
                            setTimeout(() => setCopiedFlash(false), 1500);
                          } catch (err) {
                            console.error('Clipboard write failed:', err);
                          }
                        }}
                      >
                        {copiedFlash ? '✓ Copied!' : `📋 Copy open IDs (${openIds.length})`}
                      </button>
                    );
                  })()}
                  <button
                    className="today-btn"
                    onClick={() => {
                      const yyyy = signupsDate.getFullYear();
                      const mm = String(signupsDate.getMonth() + 1).padStart(2, '0');
                      const dd = String(signupsDate.getDate()).padStart(2, '0');
                      window.open(`/admin/print-labels?date=${yyyy}-${mm}-${dd}`, '_blank');
                    }}
                  >
                    🖨️ Print labels
                  </button>
                  <button onClick={() => navigateSignupDay(1)}>Next Day →</button>
                </div>

                <div className="today-slots">
                  {getSignupFamiliesForDate(signupsDate).map(family => {
                    const assignment = getSignupAssignmentForSlot(signupsDate, family.family_id);
                    const slotClass = assignment
                      ? assignment.delivered_at ? 'slot-delivered' : 'slot-taken'
                      : 'slot-open';
                    return (
                      <div key={family.id} className={`slot slot-large ${slotClass}`}>
                        <div className="slot-main">
                          <div className="slot-family">Family #{family.family_id}</div>
                          <div className="slot-address">{family.address}</div>
                          <div className="slot-meta">
                            <span>📋 {family.instructions || 'Leave at door'}</span>
                            {family.contact && <span>📞 {family.contact}</span>}
                          </div>
                        </div>
                        {assignment ? (
                          <div className="slot-volunteer">
                            <div className="volunteer-info">
                              <span className="volunteer-name">
                                {assignment.delivered_at ? '✅' : '✓'} {assignment.volunteer_name}
                              </span>
                              {assignment.volunteer_phone && (
                                <span className="volunteer-phone">📞 {assignment.volunteer_phone}</span>
                              )}
                              {assignment.delivered_at && <span className="delivered-badge">DELIVERED</span>}
                            </div>
                            <button
                              className="admin-cancel-btn"
                              onClick={() => handleCancelAssignment(assignment)}
                              title={assignment.delivered_at ? 'Clear this delivery' : 'Cancel this sign-up'}
                            >
                              {assignment.delivered_at ? '✕ Clear' : '✕ Cancel'}
                            </button>
                          </div>
                        ) : (
                          <div className="slot-volunteer">
                            <span className="open-badge">OPEN</span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            )}

            {signupsView === 'week' && (
              <>
                <div className="week-nav">
                  <button
                    onClick={() => navigateSignupWeek(-1)}
                    disabled={signupsWeekStart <= DELIVERY_RANGE_START}
                  >
                    ← Previous Week
                  </button>
                  <span className="week-title">
                    Week of {formatShortDate(signupsWeekStart)}, {signupsWeekStart.getFullYear()}
                  </span>
                  <button
                    onClick={() => navigateSignupWeek(1)}
                    disabled={signupsWeekStart >= new Date(2026, 5, 28)}
                  >
                    Next Week →
                  </button>
                </div>

                <div className="calendar-grid">
                  {getSignupWeekDates().map(date => (
                    <div className="day-column" key={date.toISOString()}>
                      <div className="day-header">
                        <span className="day-name">
                          {dayNames[date.getDay()]}
                          {isSameDay(date) && <span className="today-badge">TODAY</span>}
                        </span>
                        <div className="day-date">{formatShortDate(date)}, {date.getFullYear()}</div>
                      </div>
                      <div className="slots-container">
                        {getSignupFamiliesForDate(date).map(family => {
                          const assignment = getSignupAssignmentForSlot(date, family.family_id);
                          const slotClass = assignment
                            ? assignment.delivered_at ? 'slot-delivered' : 'slot-taken'
                            : 'slot-open';
                          return (
                            <div key={family.id} className={`slot ${slotClass}`}>
                              <div className="slot-family">Family #{family.family_id}</div>
                              <div className="slot-address">{family.address}</div>
                              <div className="slot-meta">
                                <span>📋 {family.instructions || 'Leave at door'}</span>
                              </div>
                              {assignment ? (
                                <div className="slot-volunteer">
                                  <div className="volunteer-info">
                                    <span className="volunteer-name">
                                      {assignment.delivered_at ? '✅' : '✓'} {assignment.volunteer_name}
                                    </span>
                                    {assignment.volunteer_phone && (
                                      <span className="volunteer-phone">📞 {assignment.volunteer_phone}</span>
                                    )}
                                    {assignment.delivered_at && <span className="delivered-badge">DELIVERED</span>}
                                  </div>
                                  <button
                                    className="admin-cancel-btn"
                                    onClick={() => handleCancelAssignment(assignment)}
                                    title={assignment.delivered_at ? 'Clear this delivery' : 'Cancel this sign-up'}
                                  >
                                    {assignment.delivered_at ? '✕ Clear' : '✕ Cancel'}
                                  </button>
                                </div>
                              ) : (
                                <div className="slot-volunteer">
                                  <span className="open-badge">OPEN</span>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </section>
        )}

        {/* Assignments Tab */}
        {activeTab === 'assignments' && (
          <section className="admin-list-section">
            <div className="section-header">
              <h2>All Assignments ({getFilteredAssignments().length})</h2>
              <div className="filter-buttons">
                <button
                  className={`filter-btn ${filterWeek === 'all' ? 'active' : ''}`}
                  onClick={() => setFilterWeek('all')}
                >
                  All
                </button>
                <button
                  className={`filter-btn ${filterWeek === 'thisWeek' ? 'active' : ''}`}
                  onClick={() => setFilterWeek('thisWeek')}
                >
                  This Week
                </button>
                <button
                  className={`filter-btn ${filterWeek === 'nextWeek' ? 'active' : ''}`}
                  onClick={() => setFilterWeek('nextWeek')}
                >
                  Next Week
                </button>
              </div>
            </div>

            {loading ? (
              <p>Loading...</p>
            ) : getFilteredAssignments().length === 0 ? (
              <p>No assignments found for this period.</p>
            ) : (
              <div className="assignments-table">
                <div className="table-header table-header-6">
                  <span>Date</span>
                  <span>Family / Address</span>
                  <span>Volunteer</span>
                  <span>Phone</span>
                  <span>Signed Up</span>
                  <span>Status</span>
                </div>
                {getFilteredAssignments().map(assignment => {
                  const family = families.find(f => f.family_id === assignment.family_id);
                  return (
                    <div key={assignment.id} className={`table-row table-row-6 ${assignment.delivered_at ? 'delivered' : ''}`}>
                      <span className="cell-date">{formatDate(assignment.delivery_date)}</span>
                      <span className="cell-family">
                        #{assignment.family_id}
                        {family && <small>{family.address}</small>}
                      </span>
                      <span className="cell-volunteer">{assignment.volunteer_name}</span>
                      <span className="cell-phone">{assignment.volunteer_phone || '-'}</span>
                      <span className="cell-date">{formatDateTime(assignment.created_at)}</span>
                      <span className={`cell-status ${assignment.delivered_at ? 'status-delivered' : 'status-pending'}`}>
                        {assignment.delivered_at ? '✅ Delivered' : '🕐 Pending'}
                        <button
                          className="admin-cancel-btn"
                          onClick={() => handleCancelAssignment(assignment)}
                          title={assignment.delivered_at ? 'Clear this delivery' : 'Cancel this sign-up'}
                        >
                          {assignment.delivered_at ? '✕ Clear' : '✕ Cancel'}
                        </button>
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {/* History Tab - Full Audit Trail */}
        {activeTab === 'history' && (
          <section className="admin-list-section">
            <div className="section-header">
              <h2>Delivery History ({getFilteredHistory().length})</h2>
            </div>
            <p className="history-subtitle">Complete record of all sign-ups, deliveries, and cancellations</p>

            <div className="history-controls">
              <input
                type="text"
                className="history-search"
                placeholder="Search by name, phone, address, or family #..."
                value={historySearch}
                onChange={(e) => setHistorySearch(e.target.value)}
              />
              <div className="filter-buttons">
                <button
                  className={`filter-btn ${historyFilter === 'all' ? 'active' : ''}`}
                  onClick={() => setHistoryFilter('all')}
                >
                  All
                </button>
                <button
                  className={`filter-btn ${historyFilter === 'active' ? 'active' : ''}`}
                  onClick={() => setHistoryFilter('active')}
                >
                  Active
                </button>
                <button
                  className={`filter-btn ${historyFilter === 'delivered' ? 'active' : ''}`}
                  onClick={() => setHistoryFilter('delivered')}
                >
                  Delivered
                </button>
                <button
                  className={`filter-btn ${historyFilter === 'cancelled' ? 'active' : ''}`}
                  onClick={() => setHistoryFilter('cancelled')}
                >
                  Cancelled
                </button>
              </div>
            </div>

            {loading ? (
              <p>Loading...</p>
            ) : getFilteredHistory().length === 0 ? (
              <p>No records found.</p>
            ) : (
              <div className="assignments-table">
                <div className="table-header table-header-history">
                  <span>Delivery Date</span>
                  <span>Family / Address</span>
                  <span>Volunteer</span>
                  <span>Phone</span>
                  <span>Signed Up</span>
                  <span>Status</span>
                  <span>Completed / Cancelled</span>
                </div>
                {getFilteredHistory().map(record => {
                  const family = families.find(f => f.family_id === record.family_id);
                  const isCancelled = !!record.cancelled_at;
                  const isDelivered = !!record.delivered_at && !isCancelled;
                  const statusClass = isCancelled ? 'status-cancelled' : isDelivered ? 'status-delivered' : 'status-pending';
                  const statusText = isCancelled ? 'Cancelled' : isDelivered ? 'Delivered' : 'Pending';

                  return (
                    <div key={record.id} className={`table-row table-row-history ${isCancelled ? 'cancelled' : isDelivered ? 'delivered' : ''}`}>
                      <span className="cell-date">{formatDate(record.delivery_date)}</span>
                      <span className="cell-family">
                        #{record.family_id}
                        {family && <small>{family.address}</small>}
                      </span>
                      <span className="cell-volunteer">{record.volunteer_name}</span>
                      <span className="cell-phone">{record.volunteer_phone || '-'}</span>
                      <span className="cell-date">{formatDateTime(record.created_at)}</span>
                      <span className={`cell-status ${statusClass}`}>
                        {statusText}
                      </span>
                      <span className="cell-date">
                        {isCancelled ? formatDateTime(record.cancelled_at) : isDelivered ? formatDateTime(record.delivered_at) : '-'}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {/* Volunteers Tab */}
        {activeTab === 'volunteers' && (
          <section className="admin-list-section">
            <h2>Volunteer Directory ({stats.volunteers.length})</h2>

            {stats.volunteers.length === 0 ? (
              <p>No volunteers have signed up yet.</p>
            ) : (
              <div className="volunteers-grid">
                {stats.volunteers.map(vol => (
                  <div key={vol.name} className="volunteer-card">
                    <div className="volunteer-card-name">{vol.name}</div>
                    {vol.phone && <div className="volunteer-card-phone">📞 {vol.phone}</div>}
                    <div className="volunteer-card-stats">
                      <span>{vol.count} sign-ups</span>
                      <span>{vol.delivered} delivered</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {/* Families Tab */}
        {activeTab === 'families' && (
          <>
            {/* Add/Edit Form */}
            <section className="admin-form-section">
              <h2>{editingId ? 'Edit Family' : 'Add New Family'}</h2>
              {!editingId && (
                <p className="next-id">Next Family ID: <strong>#{getNextFamilyId()}</strong></p>
              )}

              <form onSubmit={handleSubmit} className="admin-form">
                <div className="form-group">
                  <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                    <span>Address *</span>
                    {GOOGLE_MAPS_KEY && !googleFailed && (
                      <button
                        type="button"
                        onClick={() => setGoogleFailed(true)}
                        style={{
                          background: 'none',
                          border: 'none',
                          color: '#0066cc',
                          cursor: 'pointer',
                          textDecoration: 'underline',
                          fontSize: 12,
                          padding: 0
                        }}
                      >
                        ✎ Type manually (disable autocomplete)
                      </button>
                    )}
                  </label>
                  <input
                    ref={addressInputRef}
                    type="text"
                    name="address"
                    value={formData.address}
                    onChange={handleInputChange}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && GOOGLE_MAPS_KEY && !googleFailed) e.preventDefault();
                    }}
                    placeholder={GOOGLE_MAPS_KEY && !googleFailed ? 'Start typing an address…' : '123 Main St, City, CA 91234'}
                    autoComplete="off"
                    required
                  />
                  {googleFailed && (
                    <small style={{ display: 'block', marginTop: '4px', color: '#a05a00' }}>
                      ⚠️ Address autocomplete off — type the address manually.
                    </small>
                  )}
                </div>

                <div className="form-group">
                  <label>People in Family</label>
                  <input
                    type="number"
                    name="people_count"
                    value={formData.people_count}
                    onChange={handleInputChange}
                    min="1"
                    max="20"
                  />
                </div>

                <div className="form-group">
                  <label>Contact Phone</label>
                  <input
                    type="text"
                    name="contact"
                    value={formData.contact}
                    onChange={handleInputChange}
                    placeholder="(555) 123-4567"
                  />
                </div>

                <div className="form-group">
                  <label>Delivery Instructions</label>
                  <select
                    name="instructions"
                    value={formData.instructions}
                    onChange={handleInputChange}
                  >
                    <option value="Leave at door">Leave at door</option>
                    <option value="Call when arrive">Call when arrive</option>
                    <option value="Ring doorbell">Ring doorbell</option>
                    <option value="Hand to resident">Hand to resident</option>
                  </select>
                </div>

                <div className="form-group">
                  <label>Delivery Days</label>
                  <div className="days-selector">
                    {ALL_DAYS.map(day => (
                      <button
                        key={day}
                        type="button"
                        className={`day-btn ${formData.delivery_days.includes(day) ? 'active' : ''}`}
                        onClick={() => handleDayToggle(day)}
                      >
                        {day.slice(0, 3)}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="form-group">
                  <label>Notes (optional)</label>
                  <textarea
                    name="notes"
                    value={formData.notes}
                    onChange={handleInputChange}
                    placeholder="Any special notes about this family..."
                    rows="2"
                  />
                </div>

                <div className="form-group checkbox-group">
                  <label>
                    <input
                      type="checkbox"
                      name="saturday_meals"
                      checked={formData.saturday_meals}
                      onChange={handleInputChange}
                    />
                    Saturday Meals (receives Saturday meal deliveries)
                  </label>
                </div>

                <div className="form-group checkbox-group">
                  <label>
                    <input
                      type="checkbox"
                      name="active"
                      checked={formData.active}
                      onChange={handleInputChange}
                    />
                    Active (shows in volunteer sign-up)
                  </label>
                </div>

                <div className="form-buttons">
                  {editingId && (
                    <button type="button" className="btn-secondary" onClick={resetForm}>
                      Cancel
                    </button>
                  )}
                  <button type="submit" className="btn-primary" disabled={saving}>
                    {saving ? 'Saving...' : editingId ? 'Update Family' : 'Add Family'}
                  </button>
                </div>
              </form>
            </section>

            {/* Families List */}
            <section className="admin-list-section">
              <h2>All Families ({families.length})</h2>

              {loading ? (
                <p>Loading...</p>
              ) : families.length === 0 ? (
                <p>No families yet. Add one above!</p>
              ) : (
                <div className="families-list">
                  {families.map(family => (
                    <div key={family.id} className={`family-card ${!family.active ? 'inactive' : ''}`}>
                      <div className="family-header">
                        <span className="family-id">#{family.family_id}</span>
                        <span className={`status-badge ${family.active ? 'active' : 'inactive'}`}>
                          {family.active ? 'Active' : 'Inactive'}
                        </span>
                      </div>
                      <div className="family-address">{family.address}</div>
                      <div className="family-details">
                        <span>👥 {family.people_count || '-'} people</span>
                        {family.contact && <span>📞 {family.contact}</span>}
                        {family.saturday_meals && <span>🗓 Sat Meals</span>}
                      </div>
                      <div className="family-details">
                        <span>📋 {family.instructions}</span>
                      </div>
                      {family.delivery_days && family.delivery_days.length < 5 && (
                        <div className="family-days">
                          Days: {family.delivery_days.map(d => d.slice(0, 3)).join(', ')}
                        </div>
                      )}
                      {family.notes && (
                        <div className="family-notes">📝 {family.notes}</div>
                      )}
                      <div className="family-actions">
                        <button onClick={() => handleEdit(family)}>Edit</button>
                        <button onClick={() => handleToggleActive(family)}>
                          {family.active ? 'Deactivate' : 'Activate'}
                        </button>
                        <button className="delete-btn" onClick={() => handleDelete(family)}>
                          Delete
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
