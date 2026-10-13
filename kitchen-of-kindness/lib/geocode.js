// Browser-side address lookup with the Google Maps JS Geocoder (loaded by the
// admin page). Never throws. Returns:
//   { formatted_address, lat, lng }   found
//   null                              Google has no match for the address
//   { error: 'CODE' }                 the lookup itself failed (quota, key,
//                                     network): try again later, don't treat
//                                     the address as wrong

export async function geocodeLookup(address) {
  const text = String(address || '').trim();
  if (!text || typeof window === 'undefined' || !window.google?.maps?.Geocoder) return { error: 'UNAVAILABLE' };
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
    // The JS Geocoder rejects with the status in err.code.
    if (err?.code === 'ZERO_RESULTS') return null;
    console.warn('Geocode failed:', err?.code || err);
    return { error: err?.code || 'ERROR' };
  }
}

// Found result or null (no match or failure), for the Add Family form.
export async function geocodeUS(address) {
  const r = await geocodeLookup(address);
  return r && !r.error ? r : null;
}

export const geocoderAvailable = () => typeof window !== 'undefined' && !!window.google?.maps?.Geocoder;
