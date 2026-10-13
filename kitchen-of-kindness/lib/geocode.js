// Browser-side address lookup with the Google Maps JS Geocoder (loaded by the
// admin page). Returns { formatted_address, lat, lng } or null. Never throws.

export async function geocodeUS(address) {
  const text = String(address || '').trim();
  if (!text || typeof window === 'undefined' || !window.google?.maps?.Geocoder) return null;
  try {
    const geocoder = new window.google.maps.Geocoder();
    const { results } = await geocoder.geocode({ address: text, componentRestrictions: { country: 'US' } });
    const top = results?.[0];
    if (!top?.geometry?.location) return null;
    return {
      formatted_address: top.formatted_address,
      lat: top.geometry.location.lat(),
      lng: top.geometry.location.lng()
    };
  } catch (err) {
    console.warn('Geocode failed:', err?.code || err);
    return null;
  }
}

export const geocoderAvailable = () => typeof window !== 'undefined' && !!window.google?.maps?.Geocoder;
