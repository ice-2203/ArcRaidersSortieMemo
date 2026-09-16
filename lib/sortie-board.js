import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const GIST_FILE = 'sorties.json';
const MAX_SORTIES = 200;
const MAX_MEMBERS = 300;
/** Supabase 上の単一行テーブル */
const SUPABASE_BOARD_ID = 1;

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE_FALLBACK = resolve(__dirname, '..', 'data', 'shared-sorties.json');

function supabaseUrl() {
  return String(process.env.SUPABASE_URL || '').trim().replace(/\/$/, '');
}

function supabaseKey() {
  return String(
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || ''
  ).trim();
}

function gistId() {
  return String(process.env.SORTIE_BOARD_GIST_ID || '').trim();
}

function githubToken() {
  return String(
    process.env.SORTIE_GITHUB_TOKEN ||
      process.env.GITHUB_TOKEN ||
      process.env.GH_TOKEN ||
      ''
  ).trim();
}

export function isSupabaseConfigured() {
  return Boolean(supabaseUrl() && supabaseKey());
}

export function isGistConfigured() {
  return Boolean(gistId() && githubToken());
}

export function isBoardStoreConfigured() {
  return isSupabaseConfigured() || isGistConfigured();
}

function emptyBoard() {
  return { sorties: [], members: [], updatedAt: 0 };
}

function sanitizeAvatarValue(raw) {
  const fromUrl = String(raw?.avatarUrl || '').trim();
  const fromData = String(raw?.avatarDataUrl || '').trim();
  for (const v of [fromUrl, fromData]) {
    if (v.startsWith('http') && v.length <= 500) return v;
    if (v.startsWith('data:image/') && v.length <= 14000) return v;
  }
  return '';
}

function sanitizeMemberSnap(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim();
  const name = String(raw.name || '').trim();
  if (!id || !name) return null;
  return {
    id,
    name,
    avatarUrl: sanitizeAvatarValue(raw),
  };
}

/** 共有名簿用（大きい data URL は落とす） */
export function sanitizeMember(raw) {
  const snap = sanitizeMemberSnap(raw);
  if (!snap) return null;
  const discordId = String(raw.discordId || '').trim().slice(0, 40);
  return {
    ...snap,
    id: snap.id.slice(0, 80),
    name: snap.name.slice(0, 80),
    discordId: discordId || null,
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || Number(raw.createdAt) || Date.now(),
  };
}

export function sanitizeSortie(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim();
  if (!id || id.length > 80) return null;
  const parties = Array.isArray(raw.parties)
    ? raw.parties
        .slice(0, 20)
        .map((p) =>
          Array.isArray(p)
            ? [...new Set(p.map((x) => String(x || '').trim()).filter(Boolean))].slice(0, 3)
            : []
        )
    : [[]];
  const roster = {};
  if (raw.roster && typeof raw.roster === 'object') {
    for (const v of Object.values(raw.roster)) {
      const snap = sanitizeMemberSnap(v);
      if (snap) roster[snap.id] = snap;
    }
  }
  return {
    id,
    startAt: String(raw.startAt || ''),
    endAt: String(raw.endAt || ''),
    server: String(raw.server || '').slice(0, 8),
    map: String(raw.map || '').slice(0, 80),
    event: String(raw.event || '').slice(0, 80),
    objective: String(raw.objective || '').slice(0, 200),
    memberIds: parties.flat(),
    parties: parties.length ? parties : [[]],
    slotKey: String(raw.slotKey || '').slice(0, 200),
    trialId: String(raw.trialId || '').slice(0, 80),
    regionSlug: String(raw.regionSlug || '').slice(0, 40),
    imageUrl: String(raw.imageUrl || '').startsWith('http')
      ? String(raw.imageUrl).slice(0, 500)
      : '',
    timingTags: sanitizeTimingTags(raw.timingTags),
    roster,
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || Date.now(),
  };
}

const TIMING_TAG_IDS = new Set(['on_hour', 'last_run']);

function sanitizeTimingTags(raw) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map((x) => String(x || '').trim()).filter((id) => TIMING_TAG_IDS.has(id)))].slice(
    0,
    4
  );
}

export function sanitizeBoard(input) {
  const list = Array.isArray(input?.sorties) ? input.sorties : Array.isArray(input) ? input : [];
  const sorties = [];
  const seen = new Set();
  for (const row of list) {
    const s = sanitizeSortie(row);
    if (!s || seen.has(s.id)) continue;
    seen.add(s.id);
    sorties.push(s);
    if (sorties.length >= MAX_SORTIES) break;
  }
  sorties.sort((a, b) => String(a.startAt).localeCompare(String(b.startAt)));

  const members = [];
  const seenMem = new Set();
  const memList = Array.isArray(input?.members) ? input.members : [];
  for (const row of memList) {
    const m = sanitizeMember(row);
    if (!m || seenMem.has(m.id)) continue;
    seenMem.add(m.id);
    members.push(m);
    if (members.length >= MAX_MEMBERS) break;
  }
  members.sort((a, b) => a.name.localeCompare(b.name, 'ja'));

  return {
    sorties,
    members,
    updatedAt: Number(input?.updatedAt) || Date.now(),
  };
}

function ghHeaders(token, extra = {}) {
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'ArcRaidersSortieMemo',
    Authorization: `Bearer ${token}`,
    ...extra,
  };
}

function supabaseHeaders(extra = {}) {
  const key = supabaseKey();
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function readGistBoard() {
  const id = gistId();
  const token = githubToken();
  const res = await fetch(`https://api.github.com/gists/${id}`, {
    headers: ghHeaders(token),
    cache: 'no-store',
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub Gist 取得失敗 ${res.status}: ${body.slice(0, 180)}`);
  }
  const gist = await res.json();
  const file = gist.files?.[GIST_FILE] || Object.values(gist.files || {})[0];
  const raw = file?.content;
  if (!raw) return emptyBoard();
  try {
    return sanitizeBoard(JSON.parse(raw));
  } catch {
    return emptyBoard();
  }
}

async function readSupabaseBoard() {
  const res = await fetch(
    `${supabaseUrl()}/rest/v1/sortie_board?id=eq.${SUPABASE_BOARD_ID}&select=payload`,
    {
      headers: supabaseHeaders({ Accept: 'application/json' }),
      cache: 'no-store',
    }
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase 取得失敗 ${res.status}: ${body.slice(0, 200)}`);
  }
  const rows = await res.json();
  if (!Array.isArray(rows) || !rows.length) return emptyBoard();
  return sanitizeBoard(rows[0]?.payload);
}

async function writeSupabaseBoard(board) {
  const payload = sanitizeBoard(board);
  payload.updatedAt = Date.now();
  const res = await fetch(`${supabaseUrl()}/rest/v1/sortie_board?id=eq.${SUPABASE_BOARD_ID}`, {
    method: 'PATCH',
    headers: supabaseHeaders({
      Prefer: 'return=representation,resolution=merge-duplicates',
    }),
    body: JSON.stringify({
      payload,
      updated_at: new Date(payload.updatedAt).toISOString(),
    }),
  });
  if (!res.ok) {
    // 行が無いときだけ INSERT
    if (res.status === 200 || res.status === 204) return payload;
    const text = await res.text();
    if (res.status === 404 || /0 rows/i.test(text) || res.status === 406) {
      const ins = await fetch(`${supabaseUrl()}/rest/v1/sortie_board`, {
        method: 'POST',
        headers: supabaseHeaders({ Prefer: 'return=representation' }),
        body: JSON.stringify({
          id: SUPABASE_BOARD_ID,
          payload,
          updated_at: new Date(payload.updatedAt).toISOString(),
        }),
      });
      if (!ins.ok) {
        const body = await ins.text();
        throw new Error(`Supabase 保存失敗 ${ins.status}: ${body.slice(0, 200)}`);
      }
      return payload;
    }
    // PATCH で 0 行更新でも 200 + [] になることがある
    if (res.status === 200) {
      let rows = [];
      try {
        rows = JSON.parse(text);
      } catch {
        rows = [];
      }
      if (Array.isArray(rows) && rows.length === 0) {
        const ins = await fetch(`${supabaseUrl()}/rest/v1/sortie_board`, {
          method: 'POST',
          headers: supabaseHeaders({ Prefer: 'return=representation' }),
          body: JSON.stringify({
            id: SUPABASE_BOARD_ID,
            payload,
            updated_at: new Date(payload.updatedAt).toISOString(),
          }),
        });
        if (!ins.ok) {
          const body = await ins.text();
          throw new Error(`Supabase 保存失敗 ${ins.status}: ${body.slice(0, 200)}`);
        }
        return payload;
      }
      return payload;
    }
    throw new Error(`Supabase 保存失敗 ${res.status}: ${text.slice(0, 200)}`);
  }
  return payload;
}

function readFileBoard() {
  try {
    if (!existsSync(FILE_FALLBACK)) return emptyBoard();
    return sanitizeBoard(JSON.parse(readFileSync(FILE_FALLBACK, 'utf8')));
  } catch {
    return emptyBoard();
  }
}

function writeFileBoard(board) {
  const payload = sanitizeBoard(board);
  payload.updatedAt = Date.now();
  mkdirSync(dirname(FILE_FALLBACK), { recursive: true });
  writeFileSync(FILE_FALLBACK, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

/** Supabase が空なら Gist / ローカルファイルから一度だけ取り込む */
async function migrateIntoSupabaseIfEmpty() {
  const current = await readSupabaseBoard();
  if (current.sorties.length || current.members.length) return current;

  if (isGistConfigured()) {
    try {
      const fromGist = await readGistBoard();
      if (fromGist.sorties.length || fromGist.members.length) {
        console.info('[sortie-board] Gist → Supabase へ移行します');
        return await writeSupabaseBoard(fromGist);
      }
    } catch (e) {
      console.warn('[sortie-board] Gist 移行スキップ:', e.message || e);
    }
  }

  const fromFile = readFileBoard();
  if (fromFile.sorties.length || fromFile.members.length) {
    console.info('[sortie-board] ローカルファイル → Supabase へ移行します');
    return await writeSupabaseBoard(fromFile);
  }

  return current;
}

export async function loadBoard() {
  if (isSupabaseConfigured()) {
    return migrateIntoSupabaseIfEmpty();
  }
  if (isGistConfigured()) {
    console.warn('[sortie-board] Supabase 未設定のため Gist を使用中（非推奨）');
    return readGistBoard();
  }
  return readFileBoard();
}

export async function saveBoard(board) {
  if (isSupabaseConfigured()) {
    return writeSupabaseBoard(board);
  }
  if (isGistConfigured()) {
    writeFileBoard(board);
    throw new Error(
      'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY を設定してください（Gist 保存は停止しました）'
    );
  }
  return writeFileBoard(board);
}
