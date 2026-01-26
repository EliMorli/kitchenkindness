'use client';

import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';

const ADMIN_PASSWORD = process.env.NEXT_PUBLIC_ADMIN_PASSWORD || 'admin2026';
const ALL_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'];

export default function AdminPage() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [passwordInput, setPasswordInput] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [families, setFamilies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState(null);

  // Form state
  const [formData, setFormData] = useState({
    address: '',
    instructions: 'Leave at door',
    contact: '',
    bags: 1,
    extra_bags: 0,
    delivery_days: [...ALL_DAYS],
    notes: '',
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
    }
  }, [isAuthenticated]);

  const loadFamilies = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('families')
        .select('*')
        .order('family_id', { ascending: true });

      if (error) throw error;
      setFamilies(data || []);
    } catch (error) {
      console.error('Error loading families:', error);
      alert('Error loading families. Make sure the families table exists in Supabase.');
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
      bags: 1,
      extra_bags: 0,
      delivery_days: [...ALL_DAYS],
      notes: '',
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

    setSaving(true);
    try {
      if (editingId) {
        // Update existing family
        const { error } = await supabase
          .from('families')
          .update({
            address: formData.address.trim(),
            instructions: formData.instructions.trim(),
            contact: formData.contact.trim(),
            bags: formData.bags,
            extra_bags: formData.extra_bags,
            delivery_days: formData.delivery_days,
            notes: formData.notes.trim(),
            active: formData.active
          })
          .eq('id', editingId);

        if (error) throw error;
      } else {
        // Add new family
        const { error } = await supabase
          .from('families')
          .insert({
            family_id: getNextFamilyId(),
            address: formData.address.trim(),
            instructions: formData.instructions.trim(),
            contact: formData.contact.trim(),
            bags: formData.bags,
            extra_bags: formData.extra_bags,
            delivery_days: formData.delivery_days,
            notes: formData.notes.trim(),
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
      bags: family.bags || 1,
      extra_bags: family.extra_bags || 0,
      delivery_days: family.delivery_days || [...ALL_DAYS],
      notes: family.notes || '',
      active: family.active !== false
    });
    setEditingId(family.id);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleDelete = async (family) => {
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

  const handleToggleActive = async (family) => {
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
      <header className="admin-header">
        <h1>Kitchen of Kindness - Admin</h1>
        <a href="/" className="back-link">← Back to Sign-Up Page</a>
      </header>

      <div className="admin-content">
        {/* Add/Edit Form */}
        <section className="admin-form-section">
          <h2>{editingId ? 'Edit Family' : 'Add New Family'}</h2>
          {!editingId && (
            <p className="next-id">Next Family ID: <strong>#{getNextFamilyId()}</strong></p>
          )}

          <form onSubmit={handleSubmit} className="admin-form">
            <div className="form-group">
              <label>Address *</label>
              <input
                type="text"
                name="address"
                value={formData.address}
                onChange={handleInputChange}
                placeholder="123 Main St, City, CA 91234"
                required
              />
            </div>

            <div className="form-row">
              <div className="form-group">
                <label>Bags</label>
                <input
                  type="number"
                  name="bags"
                  value={formData.bags}
                  onChange={handleInputChange}
                  min="1"
                  max="10"
                />
              </div>
              <div className="form-group">
                <label>Extra Bags</label>
                <input
                  type="number"
                  name="extra_bags"
                  value={formData.extra_bags}
                  onChange={handleInputChange}
                  min="0"
                  max="10"
                />
              </div>
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
                    <span>📦 {family.bags} bag{family.bags !== 1 ? 's' : ''}</span>
                    {family.extra_bags > 0 && <span>+{family.extra_bags} extra</span>}
                    {family.contact && <span>📞 {family.contact}</span>}
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
      </div>
    </div>
  );
}
