// Browser side of the admin login: the password is checked on the server
// (/api/admin/session), which also sets the session cookie the Mail tab needs.
// The localStorage flag still gates the other admin pages as before.

export const ADMIN_FLAG = 'kok_admin_authenticated';

function setFlag() {
  try {
    localStorage.setItem(ADMIN_FLAG, 'true');
  } catch {
    // Private mode: stay logged in for this visit only.
  }
}

// Returns { ok: true } or { ok: false, error }.
export async function loginAdmin(password) {
  let res;
  try {
    res = await fetch('/api/admin/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ password })
    });
  } catch {
    return { ok: false, error: 'No connection. Check the internet and try again.' };
  }
  if (res.ok) {
    setFlag();
    return { ok: true };
  }
  if (res.status === 503) {
    const body = await res.json().catch(() => ({}));
    return {
      ok: false,
      error: body.message || "Admin login isn't set up on the server yet (ADMIN_PASSWORD and ADMIN_SESSION_SECRET in Vercel)."
    };
  }
  if (res.status === 401) return { ok: false, error: 'Incorrect admin password.' };
  return { ok: false, error: 'Could not check the password. Try again.' };
}

// { configured, authenticated } from the server, or { error: true } when the
// server couldn't be reached (offline, a failed request).
export async function serverSession() {
  try {
    const res = await fetch('/api/admin/session', { credentials: 'same-origin', cache: 'no-store' });
    if (!res.ok) return { error: true, status: res.status, configured: false, authenticated: false };
    return await res.json();
  } catch {
    return { error: true, offline: true, configured: false, authenticated: false };
  }
}

export async function logoutAdminServer() {
  try {
    await fetch('/api/admin/session', { method: 'DELETE', credentials: 'same-origin' });
  } catch {
    // ignore
  }
}
