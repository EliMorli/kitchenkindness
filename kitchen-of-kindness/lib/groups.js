// Per-day proximity clustering. computeGroups takes the families active on a
// given day and greedily assigns each to a cluster of ~GROUP_SIZE nearest
// neighbors so volunteers can pick up one group per trip.

export const GROUP_SIZE = 4;

export function haversineKm(a, b) {
  const R = 6371;
  const toRad = deg => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const hasCoords = f =>
  typeof f.latitude === 'number' &&
  typeof f.longitude === 'number' &&
  Number.isFinite(f.latitude) &&
  Number.isFinite(f.longitude);

// Returns Map<family_id, groupNumber | null>. Anchor tiebreak is strict
// (minLat → minLng → minId) so refreshes never renumber groups mid-day.
export function computeGroups(families, groupSize = GROUP_SIZE) {
  const result = new Map();
  const withCoords = families.filter(hasCoords);
  const noCoords = families.filter(f => !hasCoords(f));

  const remaining = [...withCoords];
  let groupNum = 1;
  while (remaining.length > 0) {
    remaining.sort(
      (a, b) =>
        a.latitude - b.latitude ||
        a.longitude - b.longitude ||
        Number(a.family_id) - Number(b.family_id)
    );
    const anchor = remaining[0];
    const rest = remaining.slice(1).map(f => ({ f, dist: haversineKm(anchor, f) }));
    rest.sort(
      (a, b) => a.dist - b.dist || Number(a.f.family_id) - Number(b.f.family_id)
    );
    const group = [anchor, ...rest.slice(0, groupSize - 1).map(x => x.f)];
    const groupIds = new Set(group.map(f => f.family_id));
    for (const f of group) result.set(f.family_id, groupNum);
    for (let i = remaining.length - 1; i >= 0; i--) {
      if (groupIds.has(remaining[i].family_id)) remaining.splice(i, 1);
    }
    groupNum += 1;
  }

  for (const f of noCoords) result.set(f.family_id, null);
  return result;
}

export function groupBadgeClass(group) {
  if (group == null) return 'group-badge ungrouped';
  const bucket = ((group - 1) % 10) + 1;
  return `group-badge group-${bucket}`;
}

export function groupLabel(group) {
  return group == null ? 'U' : String(group);
}
