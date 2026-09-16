import { mapJa, eventJa, trialJa, SERVER_REGIONS } from './names.js';

/** イベントタイマー同様、最大おおよそ10日分まで見る */
const HORIZON_MS = 10 * 24 * 60 * 60 * 1000;
const MF_BASE = 'https://metaforge.app/api/arc-raiders';

function floorHourMs(ms) {
  const d = new Date(ms);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

async function fetchJson(path) {
  // 本番・開発とも同一オリジンの /api/metaforge 経由（ブラウザ CORS 回避）
  const target = `${MF_BASE}${path}`;
  const res = await fetch(`/api/metaforge?url=${encodeURIComponent(target)}`, {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body?.error ? `: ${body.error}` : '';
    } catch {
      /* ignore */
    }
    throw new Error(`MetaForge HTTP ${res.status}${detail}`);
  }
  return await res.json();
}

function unwrapArray(json) {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== 'object') return [];
  for (const key of ['data', 'schedule', 'events', 'items']) {
    if (Array.isArray(json[key])) return json[key];
  }
  return [];
}

function looksEmbarked(t) {
  try {
    return /embarked/i.test(JSON.stringify(t));
  } catch {
    return false;
  }
}

/** MetaForge の未公開プレースホルダー（Currently Unknown 等） */
function looksUnknownPlaceholder(t) {
  if (!t || typeof t !== 'object') return false;
  const id = String(t.id || '').trim();
  const name = String(t.name || '').trim();
  const label = (name || id).toLowerCase();
  if (!label) return Boolean(t.upcoming);
  if (label === 'unknown' || label === 'currently unknown') return true;
  if (/currently\s+unknown/i.test(id) || /currently\s+unknown/i.test(name)) return true;
  const image = String(t.image_url || '').trim();
  if (/UnknownTrial/i.test(image)) return true;
  if (
    t.upcoming &&
    !image &&
    !String(t.guide_link || '').trim() &&
    !String(t.video_link || '').trim()
  ) {
    return true;
  }
  return false;
}

function mapTrial(t) {
  return {
    id: t.trial_id || t.id,
    name: t.name || t.content_name || '',
    nameJa: trialJa(t.name || t.content_name || ''),
    imageUrl: String(t.image_url || '').replace(/^https:\/\//, 'https://'),
    mapNames: Array.isArray(t.map_names) ? t.map_names.map(mapJa).filter(Boolean) : [],
    sortOrder: t.sort_order || 0,
    isUnknownPlaceholder: looksUnknownPlaceholder(t),
    windowStartMs: Number(t.window_start) ? Number(t.window_start) * 1000 : null,
    windowEndMs: Number(t.window_end) ? Number(t.window_end) * 1000 : null,
  };
}

function sortTrials(list) {
  return [...list].sort((a, b) => {
    const ai = Boolean(a.imageUrl) && !a.isUnknownPlaceholder;
    const bi = Boolean(b.imageUrl) && !b.isUnknownPlaceholder;
    if (ai !== bi) return ai ? -1 : 1;
    return (a.sortOrder || 0) - (b.sortOrder || 0);
  });
}

/** @returns {{ current: ReturnType<typeof mapTrial>[], next: ReturnType<typeof mapTrial>[] }} */
export async function fetchWeeklyTrials() {
  const json = await fetchJson('/weekly-trials');
  const rows = unwrapArray(json);
  const current = sortTrials(
    rows
      .filter((t) => t && t.is_active && !looksEmbarked(t) && !looksUnknownPlaceholder(t))
      .map(mapTrial)
  );
  const next = sortTrials(rows.filter((t) => t && t.upcoming).map(mapTrial));
  return { current, next };
}

/** @deprecated use fetchWeeklyTrials */
export async function fetchActiveTrials() {
  const { current } = await fetchWeeklyTrials();
  return current;
}

export async function fetchScheduleSlots(regionSlugs, { fromMs, untilMs } = {}) {
  const targets = regionSlugs?.length ? regionSlugs : SERVER_REGIONS.map((r) => r.slug);
  const now = Date.now();
  const from = Number.isFinite(fromMs) ? fromMs : now;
  const until = Number.isFinite(untilMs) ? untilMs : now + HORIZON_MS;
  const slots = [];

  await Promise.all(
    targets.map(async (slug) => {
      try {
        const json = await fetchJson(`/events-schedule?region=${encodeURIComponent(slug)}`);
        for (const entry of unwrapArray(json)) {
          const start = Number(entry.startTime ?? entry.start_time);
          const end = Number(entry.endTime ?? entry.end_time);
          if (!Number.isFinite(start)) continue;
          const endMs = Number.isFinite(end) ? end : start + 60 * 60 * 1000;
          if (endMs <= from || start >= until) continue;
          const map = mapJa(entry.map);
          const event = eventJa(entry.name);
          if (!map || !event) continue;
          slots.push({
            startMs: floorHourMs(start),
            endMs,
            map,
            event,
            region: slug,
            icon: entry.icon || '',
          });
        }
      } catch (e) {
        console.warn('[schedule]', slug, e);
      }
    })
  );

  slots.sort((a, b) => a.startMs - b.startMs || a.region.localeCompare(b.region));
  return slots;
}

export function slotKey(slot) {
  return `${slot.startMs}|${slot.region}|${slot.map}|${slot.event}`;
}
