'use client';

import { use, useEffect, useRef, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import {
  loadWeek, activeSignups, spotsLeft, isFull, todayStr, dayName, shortDate, longDate, parseDate
} from '../../../lib/weeks';

const CONFETTI_COLORS = ['#f59e0b', '#ef4444', '#0891b2', '#8b5cf6', '#10b981', '#ec4899', '#fbbf24'];

const firstName = full => String(full || '').trim().split(/\s+/)[0] || '';
const initials = full =>
  String(full || '').trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() || '').join('');

export default function WeekPage({ params }) {
  const { slug } = use(params);
  const [week, setWeek] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedDay, setSelectedDay] = useState(null);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null);
  const [confetti, setConfetti] = useState([]);
  const cardRefs = useRef({});
  const scrolledRef = useRef(false);
  const today = todayStr();

  useEffect(() => {
    try {
      setName(localStorage.getItem('kok_volunteer_name') || '');
      setPhone(localStorage.getItem('kok_volunteer_phone') || '');
    } catch {}
  }, []);

  const refresh = async () => {
    if (!supabase) { setLoading(false); setError('Sign-ups are unavailable right now.'); return; }
    try {
      const w = await loadWeek(supabase, slug);
      setWeek(w);
      if (!w) setError('This sign-up week doesn\'t exist.');
      else if (!w.active) setError('This sign-up week is closed.');
      else setError('');
    } catch (e) {
      console.error('Error loading week:', e);
      setError('Could not load this week. Please try again.');
    }
    setLoading(false);
  };

  useEffect(() => { refresh(); }, [slug]);

  // Live updates: other volunteers' sign-ups appear without a reload.
  useEffect(() => {
    if (!supabase || !week?.id) return;
    const channel = supabase
      .channel(`week-${week.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'volunteer_week_signups' }, () => refresh())
      .subscribe();
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      supabase.removeChannel(channel);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [week?.id]);

  // Land on today's bubble (or the next upcoming day) the first time it renders.
  useEffect(() => {
    if (!week || scrolledRef.current) return;
    const target = week.days.find(d => d.date === today) || week.days.find(d => d.date > today);
    if (target && cardRefs.current[target.id]) {
      scrolledRef.current = true;
      setTimeout(() => {
        cardRefs.current[target.id]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 250);
    }
  }, [week]);

  const showToast = (text, kind = 'ok') => {
    setToast({ text, kind });
    setTimeout(() => setToast(null), 3200);
  };

  const burstConfetti = () => {
    const pieces = Array.from({ length: 28 }, (_, i) => ({
      id: `${Date.now()}-${i}`,
      left: Math.random() * 100,
      delay: Math.random() * 0.25,
      color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
      rotate: Math.random() * 360,
      size: 6 + Math.random() * 8
    }));
    setConfetti(pieces);
    setTimeout(() => setConfetti([]), 1800);
  };

  const mySignup = day =>
    activeSignups(day).find(s => name && s.volunteer_name.trim().toLowerCase() === name.trim().toLowerCase());

  const openSignup = day => {
    if (day.date < today || isFull(day) || mySignup(day)) return;
    setSelectedDay(day);
  };

  const handleSignup = async () => {
    if (!supabase || !selectedDay) return;
    const cleanName = name.trim();
    const cleanPhone = phone.trim();
    if (!cleanName || !cleanPhone) return;
    setSaving(true);
    try {
      // Re-check capacity right before inserting so two people tapping at once
      // can't both take the last spot.
      if (selectedDay.capacity != null) {
        const { count, error: cErr } = await supabase
          .from('volunteer_week_signups')
          .select('id', { count: 'exact', head: true })
          .eq('day_id', selectedDay.id)
          .is('cancelled_at', null);
        if (cErr) throw cErr;
        if ((count ?? 0) >= selectedDay.capacity) {
          setSelectedDay(null);
          showToast(`${dayName(selectedDay.date)} just filled up — pick another day! 😅`, 'warn');
          await refresh();
          setSaving(false);
          return;
        }
      }
      const { error: iErr } = await supabase
        .from('volunteer_week_signups')
        .insert({ day_id: selectedDay.id, volunteer_name: cleanName, volunteer_phone: cleanPhone });
      if (iErr) throw iErr;
      try {
        localStorage.setItem('kok_volunteer_name', cleanName);
        localStorage.setItem('kok_volunteer_phone', cleanPhone);
      } catch {}
      setSelectedDay(null);
      burstConfetti();
      showToast(`🎉 You're in for ${dayName(selectedDay.date)}! Thank you, ${firstName(cleanName)}!`);
      await refresh();
    } catch (e) {
      console.error('Sign-up failed:', e);
      showToast('Something went wrong — please try again.', 'warn');
    }
    setSaving(false);
  };

  const handleCancel = async day => {
    const mine = mySignup(day);
    if (!supabase || !mine) return;
    if (!confirm(`Cancel your spot on ${dayName(day.date)}?`)) return;
    try {
      const { error: uErr } = await supabase
        .from('volunteer_week_signups')
        .update({ cancelled_at: new Date().toISOString() })
        .eq('id', mine.id);
      if (uErr) throw uErr;
      showToast(`Your ${dayName(day.date)} spot is open again.`);
      await refresh();
    } catch (e) {
      console.error('Cancel failed:', e);
      showToast('Could not cancel — please try again.', 'warn');
    }
  };

  if (loading) {
    return <div className="wk-page"><div className="wk-loading">Loading…</div></div>;
  }
  if (error || !week) {
    return (
      <div className="wk-page">
        <div className="wk-loading">
          <p>{error || 'Not found.'}</p>
          <a href="/" className="wk-link">← Back to Kitchen of Kindness</a>
        </div>
      </div>
    );
  }

  const limitedDays = week.days.filter(d => d.capacity != null);
  const totalCapacity = limitedDays.reduce((s, d) => s + d.capacity, 0);
  const totalFilled = limitedDays.reduce((s, d) => s + Math.min(d.capacity, activeSignups(d).length), 0);
  const unlimitedCount = week.days.filter(d => d.capacity == null).reduce((s, d) => s + activeSignups(d).length, 0);
  const todayInWeek = week.days.find(d => d.date === today);
  const todayLeft = todayInWeek ? spotsLeft(todayInWeek) : null;
  const pct = totalCapacity ? Math.round((totalFilled / totalCapacity) * 100) : 0;

  return (
    <div className="wk-page">
      {confetti.length > 0 && (
        <div className="wk-confetti" aria-hidden="true">
          {confetti.map(p => (
            <span
              key={p.id}
              style={{
                left: `${p.left}%`,
                animationDelay: `${p.delay}s`,
                background: p.color,
                width: p.size,
                height: p.size * 0.6,
                transform: `rotate(${p.rotate}deg)`
              }}
            />
          ))}
        </div>
      )}

      {toast && <div className={`wk-toast ${toast.kind}`}>{toast.text}</div>}

      <header className="wk-hero">
        <div className="wk-hero-emoji">{week.emoji}</div>
        <h1>{week.title}</h1>
        {week.subtitle && <p className="wk-hero-sub">{week.subtitle}</p>}
        <div className="wk-today-chip">
          Today is <strong>{longDate(today)}</strong>
          {todayInWeek && (
            <span className="wk-today-spots">
              {todayLeft === null
                ? ' · unlimited spots today!'
                : todayLeft === 0
                  ? ' · today is full 🎉'
                  : ` · ${todayLeft} ${todayLeft === 1 ? 'spot' : 'spots'} left today`}
            </span>
          )}
        </div>
        {totalCapacity > 0 && (
          <div className="wk-progress">
            <div className="wk-progress-bar"><div className="wk-progress-fill" style={{ width: `${pct}%` }} /></div>
            <div className="wk-progress-label">
              {totalFilled}/{totalCapacity} spots filled
              {unlimitedCount > 0 && ` · +${unlimitedCount} on the big day`}
            </div>
          </div>
        )}
      </header>

      <main className="wk-days">
        {week.days.map((day, idx) => {
          const signups = activeSignups(day);
          const left = spotsLeft(day);
          const past = day.date < today;
          const isToday = day.date === today;
          const full = isFull(day);
          const mine = mySignup(day);
          const status = past ? 'past' : isToday ? 'today' : 'upcoming';
          return (
            <section
              key={day.id}
              ref={el => { cardRefs.current[day.id] = el; }}
              className={`wk-card ${status} ${full ? 'full' : ''} ${mine ? 'mine' : ''} ${day.capacity == null ? 'unlimited' : ''}`}
              style={{ animationDelay: `${idx * 70}ms` }}
            >
              <div className="wk-card-top">
                <div>
                  <div className="wk-card-day">{dayName(day.date)}</div>
                  <div className="wk-card-date">{shortDate(day.date)}</div>
                  {day.time_label && <div className="wk-card-time">🕐 {day.time_label}</div>}
                </div>
                <div className="wk-pill-stack">
                  {isToday && <span className="wk-pill today">TODAY</span>}
                  {past ? (
                    <span className="wk-pill past">Done</span>
                  ) : day.capacity == null ? (
                    <span className="wk-pill infinite">∞ Unlimited</span>
                  ) : full ? (
                    <span className="wk-pill full">FULL 🎉</span>
                  ) : (
                    <span className="wk-pill open">{left} {left === 1 ? 'spot' : 'spots'} left</span>
                  )}
                </div>
              </div>

              {day.note && <div className="wk-card-note">{day.note}</div>}

              <div className="wk-spots">
                {day.capacity != null
                  ? Array.from({ length: day.capacity }, (_, i) => {
                      const s = signups[i];
                      return s ? (
                        <span key={i} className="wk-spot taken" title={s.volunteer_name}>{initials(s.volunteer_name)}</span>
                      ) : (
                        <span key={i} className={`wk-spot open ${past ? 'past' : ''}`}>+</span>
                      );
                    })
                  : (
                    <>
                      {signups.map(s => (
                        <span key={s.id} className="wk-spot taken" title={s.volunteer_name}>{initials(s.volunteer_name)}</span>
                      ))}
                      {!past && <span className="wk-spot open">+</span>}
                    </>
                  )}
              </div>

              {signups.length > 0 && (
                <div className="wk-names">
                  {signups.map(s => firstName(s.volunteer_name)).join(', ')}
                  {day.capacity == null && ` — ${signups.length} so far`}
                </div>
              )}

              <div className="wk-card-actions">
                {mine ? (
                  <>
                    <span className="wk-youre-in">✓ You're in!</span>
                    <button className="wk-cancel" onClick={() => handleCancel(day)}>Cancel my spot</button>
                  </>
                ) : past ? (
                  <span className="wk-muted">This day has passed</span>
                ) : full ? (
                  <span className="wk-muted">All spots taken — thank you!</span>
                ) : (
                  <button className="wk-join" onClick={() => openSignup(day)}>
                    {day.capacity == null ? 'Count me in — bring friends!' : 'Count me in!'}
                  </button>
                )}
              </div>
            </section>
          );
        })}
      </main>

      <footer className="wk-footer">
        <a href="/" className="wk-link">← Delivery sign-ups</a>
      </footer>

      {selectedDay && (
        <div className="modal-overlay" onClick={() => !saving && setSelectedDay(null)}>
          <div className="modal wk-modal" onClick={e => e.stopPropagation()}>
            <div className="wk-modal-emoji">{week.emoji}</div>
            <h2>Join us {dayName(selectedDay.date)}</h2>
            <p className="wk-modal-sub">
              {longDate(selectedDay.date)}
              {selectedDay.time_label ? ` · ${selectedDay.time_label}` : ''}
              {selectedDay.note ? ` · ${selectedDay.note}` : ''}
            </p>
            <input
              className="wk-input"
              type="text"
              placeholder="Your name"
              value={name}
              onChange={e => setName(e.target.value)}
              autoFocus={!name}
            />
            <input
              className="wk-input"
              type="tel"
              placeholder="Your phone"
              value={phone}
              onChange={e => setPhone(e.target.value)}
              autoFocus={!!name && !phone}
            />
            <div className="modal-buttons">
              <button className="btn-secondary" onClick={() => setSelectedDay(null)} disabled={saving}>Not now</button>
              <button
                className="btn-primary"
                onClick={handleSignup}
                disabled={saving || !name.trim() || !phone.trim()}
              >
                {saving ? 'Saving…' : 'Count me in! 🙌'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
