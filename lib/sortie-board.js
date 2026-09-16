import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const GIST_FILE = 'sorties.json';
const MAX_SORTIES = 200;
const MAX_MEMBERS = 300;

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE_FALLBACK = resolve(__dirname, '..', 'data', 'shared-sorties.json');

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

export function isBoardStoreConfigured() {
  return Boolean(gistId() && githubToken());
}

function emptyBoard() {
  return { sorties: [], members: [], updatedAt: 0 };
}

function sanitizeAvatarValue(raw) {
  const fromUrl = String(raw?.avatarUrl || '').trim();
  const fromData = String(raw?.avatarDataUrl || '').trim();
  for (const v of [fromUrl, fromData]) {
    if (v.startsWith('http') && v.length <= 500) return v;
    // 共有用に縮小済みの小さい data URL のみ許可
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

async function writeGistBoard(board) {
  const id = gistId();
  const token = githubToken();
  const payload = sanitizeBoard(board);
  payload.updatedAt = Date.now();
  const res = await fetch(`https://api.github.com/gists/${id}`, {
    method: 'PATCH',
    headers: ghHeaders(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      files: {
        [GIST_FILE]: { content: JSON.stringify(payload) },
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub Gist 保存失敗 ${res.status}: ${body.slice(0, 180)}`);
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

export async function loadBoard() {
  if (isBoardStoreConfigured()) return readGistBoard();
  return readFileBoard();
}

export async function saveBoard(board) {
  if (isBoardStoreConfigured()) return writeGistBoard(board);
  return writeFileBoard(board);
}
