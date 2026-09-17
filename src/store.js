const STORAGE_KEY = 'arcraiders.sortieMemo.v1';

const SERVERS = [
  { id: 'NA', label: '北アメリカ' },
  { id: 'EU', label: 'ヨーロッパ' },
  { id: 'AS', label: 'アジア' },
  { id: 'SA', label: '南アメリカ' },
  { id: 'OC', label: 'オセアニア' },
];

function uid(prefix = 'id') {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

function emptyState() {
  return { members: [], sorties: [], trialPrefs: {} };
}

function normalizeTrialPrefs(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const [id, pref] of Object.entries(raw)) {
    if (!pref || typeof pref !== 'object') continue;
    out[id] = {
      maps: Array.isArray(pref.maps) ? pref.maps.map(String).filter(Boolean) : [],
      events: Array.isArray(pref.events) ? pref.events.map(String).filter(Boolean) : [],
    };
  }
  return out;
}

export function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyState();
    const parsed = JSON.parse(raw);
    return {
      members: Array.isArray(parsed.members) ? parsed.members : [],
      sorties: Array.isArray(parsed.sorties) ? parsed.sorties : [],
      trialPrefs: normalizeTrialPrefs(parsed.trialPrefs),
    };
  } catch {
    return emptyState();
  }
}

export function saveState(state) {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      members: state.members || [],
      sorties: state.sorties || [],
      trialPrefs: state.trialPrefs || {},
    })
  );
}

export function createMember({ name, avatarDataUrl, avatarUrl = null, discordId = null }) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return null;
  return {
    id: uid('mem'),
    name: trimmed,
    avatarDataUrl: avatarDataUrl || null,
    avatarUrl: avatarUrl || null,
    discordId: discordId || null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export function createSortie(fields = {}) {
  return {
    id: uid('srt'),
    startAt: fields.startAt || '',
    endAt: fields.endAt || '',
    server: fields.server || 'NA',
    map: String(fields.map || '').trim(),
    event: String(fields.event || '').trim(),
    objective: String(fields.objective || '').trim(),
    memberIds: Array.isArray(fields.memberIds) ? fields.memberIds : [],
    parties: Array.isArray(fields.parties) ? fields.parties : [[]],
    partySize: Number(fields.partySize) === 2 ? 2 : 3,
    timingTags: Array.isArray(fields.timingTags) ? fields.timingTags : [],
    roster: fields.roster && typeof fields.roster === 'object' ? fields.roster : {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export function serverLabel(id) {
  return SERVERS.find((s) => s.id === id)?.label || id;
}

export { SERVERS, STORAGE_KEY };
