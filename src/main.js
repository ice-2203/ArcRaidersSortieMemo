import './style.css';
import {
  loadState,
  saveState,
  createMember,
  createSortie,
} from './store.js';
import { fetchWeeklyTrials, fetchScheduleSlots, slotKey } from './metaforge.js';
import { fetchSharedBoard, pushSharedBoard, BoardSyncError } from './sync.js';
import { SERVER_REGIONS, regionAbbr, regionLabel, MAP_OPTIONS, EVENT_OPTIONS, eventType, mapJa } from './names.js';

const WEEK_MODE_KEY = 'arcraiders.sortieMemo.weekMode';
const SCHED_FILTER_KEY = 'arcraiders.sortieMemo.schedFilter';
const MEMBER_FILTER_KEY = 'arcraiders.sortieMemo.memberFilter';
const RECRUIT_FILTER_KEY = 'arcraiders.sortieMemo.recruitFilter';
const DELETED_SORTIES_KEY = 'arcraiders.sortieMemo.deletedSorties';
const BOARD_POLL_MS = 30000;
const TOMBSTONE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function loadWeekMode() {
  try {
    const v = localStorage.getItem(WEEK_MODE_KEY);
    return v === 'next' ? 'next' : 'current';
  } catch {
    return 'current';
  }
}

function loadSchedFilter() {
  try {
    const v = localStorage.getItem(SCHED_FILTER_KEY);
    return v === 'registered' ? 'registered' : 'all';
  } catch {
    return 'all';
  }
}

function saveSchedFilter(filter) {
  try {
    localStorage.setItem(SCHED_FILTER_KEY, filter);
  } catch {
    /* ignore */
  }
}

function loadMemberFilterIds() {
  try {
    const raw = localStorage.getItem(MEMBER_FILTER_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(list) ? list.map(String).filter(Boolean) : []);
  } catch {
    return new Set();
  }
}

function saveMemberFilterIds(ids) {
  try {
    localStorage.setItem(MEMBER_FILTER_KEY, JSON.stringify([...ids]));
  } catch {
    /* ignore */
  }
}

function loadRecruitFilterOnly() {
  try {
    return localStorage.getItem(RECRUIT_FILTER_KEY) === '1';
  } catch {
    return false;
  }
}

function saveRecruitFilterOnly(on) {
  try {
    localStorage.setItem(RECRUIT_FILTER_KEY, on ? '1' : '0');
  } catch {
    /* ignore */
  }
}

let state = loadState();
if (!state.trialPrefs || typeof state.trialPrefs !== 'object') state.trialPrefs = {};
/** @type {any[]} */
let trialsCurrent = [];
/** @type {any[]} */
let trialsNext = [];
let slots = [];
/** @type {Record<string, string>} */
let eventIconByJa = {};
let loadError = '';
let loading = false;
let selectedRegions = SERVER_REGIONS.map((r) => r.slug);
/** @type {'all' | 'registered'} */
let schedFilter = loadSchedFilter();
/** @type {'current' | 'next'} */
let weekMode = loadWeekMode();
/** 出撃のみ表示時のメンバー絞り込み（選んだ人のいずれかが参加している出撃） */
let memberFilterIds = loadMemberFilterIds();
/** レイド一覧：募集枠があるものだけ表示 */
let recruitFilterOnly = loadRecruitFilterOnly();
/** トライアル横レールの scrollLeft（再描画で飛ばないよう保持） */
let trialRailScrollLeft = 0;
/** カード内予定一覧の scrollTop（trialId → 位置） */
const trialSchedScrollTop = new Map();
/** 出撃のみタイムラインの scrollTop */
let registeredTimelineScrollTop = 0;

function captureSchedScrolls() {
  const rail = app.querySelector('.trial-rail');
  if (rail) {
    rail.querySelectorAll('.trial-card[data-trial-id]').forEach((card) => {
      const id = card.dataset.trialId;
      const list = card.querySelector('.mp-time-list');
      if (id && list) trialSchedScrollTop.set(String(id), list.scrollTop);
    });
  }
  const wrap = app.querySelector('.sortie-timeline');
  if (wrap) registeredTimelineScrollTop = wrap.scrollTop;
}

function restoreSchedScrolls() {
  const rail = app.querySelector('.trial-rail');
  if (rail) {
    rail.querySelectorAll('.trial-card[data-trial-id]').forEach((card) => {
      const id = String(card.dataset.trialId || '');
      const list = card.querySelector('.mp-time-list');
      if (!list || !id) return;
      const top = trialSchedScrollTop.get(id);
      if (!Number.isFinite(top) || top <= 0) return;
      const apply = () => {
        list.scrollTop = top;
      };
      apply();
      requestAnimationFrame(() => {
        apply();
        requestAnimationFrame(apply);
      });
      list.addEventListener(
        'scroll',
        () => {
          if (modal) return;
          trialSchedScrollTop.set(id, list.scrollTop);
        },
        { passive: true }
      );
    });
  }
  const wrap = app.querySelector('.sortie-timeline');
  if (wrap && registeredTimelineScrollTop > 0) {
    const apply = () => {
      wrap.scrollTop = registeredTimelineScrollTop;
    };
    apply();
    requestAnimationFrame(() => {
      apply();
      requestAnimationFrame(apply);
    });
    wrap.addEventListener(
      'scroll',
      () => {
        if (modal) return;
        registeredTimelineScrollTop = wrap.scrollTop;
      },
      { passive: true }
    );
  }
}

function visibleTrials() {
  return weekMode === 'next' ? trialsNext : trialsCurrent;
}
/** 出撃メンバー登録ポップを開いている出撃ID */
let partySortieId = null;
let modal = null;
let toastTimer = null;
let clockTimer = null;
let countdownTimer = null;

const app = document.querySelector('#app');
const DEFAULT_PARTY_SIZE = 3;
const PARTY_SIZE_OPTIONS = [
  { size: 2, label: 'デュオ' },
  { size: 3, label: 'トリオ' },
];

/** @param {any} sortie */
function partySizeOf(sortie) {
  const n = Number(sortie?.partySize);
  return n === 2 || n === 3 ? n : DEFAULT_PARTY_SIZE;
}

function partySizeLabel(size) {
  return size === 2 ? 'デュオ' : 'トリオ';
}

/** 編成人数を変更。縮小時は各パーティを切り詰め */
function setSortiePartySize(sortie, size) {
  const next = size === 2 ? 2 : 3;
  const before = (Array.isArray(sortie.parties) ? sortie.parties.flat() : []).length;
  sortie.partySize = next;
  ensureParties(sortie);
  refreshSortieRoster(sortie);
  sortie.updatedAt = Date.now();
  const after = (sortie.parties || []).flat().length;
  return { ok: true, trimmed: Math.max(0, before - after) };
}

/** 1時間枠内の出撃タイミングメモ */
const TIMING_TAGS = [
  { id: 'on_hour', label: '0分開始', hint: '時間ちょうど（例: 20:00）から入る' },
  { id: 'last_run', label: '最終便', hint: '時間の終盤（例: 20:50ごろ）に入る' },
];
const TIMING_TAG_IDS = new Set(TIMING_TAGS.map((t) => t.id));

function normalizeTimingTags(raw) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map((x) => String(x || '').trim()).filter((id) => TIMING_TAG_IDS.has(id)))];
}

function ensureTimingTags(sortie) {
  if (!sortie) return [];
  sortie.timingTags = normalizeTimingTags(sortie.timingTags);
  return sortie.timingTags;
}

function timingTagLabel(id) {
  return TIMING_TAGS.find((t) => t.id === id)?.label || id;
}

function timingTagsLine(sortie) {
  return ensureTimingTags(sortie)
    .map((id) => timingTagLabel(id))
    .join(' / ');
}

function appendTimingTagEls(parent, sortie, { className = 'timing-tag' } = {}) {
  for (const id of ensureTimingTags(sortie)) {
    const el = document.createElement('span');
    el.className = `${className} ${className}--${id}`;
    el.textContent = timingTagLabel(id);
    parent.appendChild(el);
  }
}

function toggleTimingTag(sortie, tagId) {
  if (!sortie || !TIMING_TAG_IDS.has(tagId)) return;
  const cur = ensureTimingTags(sortie);
  sortie.timingTags = cur.includes(tagId) ? cur.filter((id) => id !== tagId) : [...cur, tagId];
  sortie.updatedAt = Date.now();
  persist({ sortieId: sortie.id });
}

function paintTimingTagPicker(host, sortie) {
  if (!host || !sortie) return;
  host.replaceChildren();
  const label = document.createElement('span');
  label.className = 'timing-tag-picker-label';
  label.textContent = '時間帯メモ';
  host.appendChild(label);
  for (const opt of TIMING_TAGS) {
    const on = ensureTimingTags(sortie).includes(opt.id);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `timing-tag-btn timing-tag-btn--${opt.id}${on ? ' is-on' : ''}`;
    btn.textContent = opt.label;
    btn.title = opt.hint;
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const live = state.sorties.find((s) => s.id === sortie.id) || sortie;
      toggleTimingTag(live, opt.id);
      paintTimingTagPicker(host, live);
    });
    host.appendChild(btn);
  }
}

function chunkBy(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** parties: string[][] を正規化し、旧 memberIds からも移行（空パーティは残す） */
function ensureParties(sortie) {
  if (!sortie) return [[]];
  const size = partySizeOf(sortie);
  sortie.partySize = size;
  if (Array.isArray(sortie.parties)) {
    sortie.parties = sortie.parties.map((p) =>
      (Array.isArray(p) ? [...new Set(p.filter(Boolean))] : []).slice(0, size)
    );
    if (!sortie.parties.length) sortie.parties = [[]];
  } else {
    const ids = Array.isArray(sortie.memberIds) ? sortie.memberIds.filter(Boolean) : [];
    sortie.parties = ids.length ? chunkBy(ids, size) : [[]];
  }
  sortie.memberIds = sortie.parties.flat();
  return sortie.parties;
}

function partyMemberLists(sortie) {
  return ensureParties(sortie).map((ids) => ids.map((id) => memberById(id, sortie)).filter(Boolean));
}

/** 募集枠の表示ラベル（例: @1募集中） */
function partyVacancyLabel(open) {
  const n = Math.max(0, Number(open) || 0);
  return n > 0 ? `@${n}募集中` : '';
}

/** タイムライン等の参加者行テキスト（title / Discord用） */
function formatPartyGroupLine(group, size) {
  const names = group.map((m) => m.name).join('・');
  const open = size - group.length;
  const vac = partyVacancyLabel(open);
  if (!vac) return names;
  if (!names) return vac;
  return `${names} ${vac}`;
}

/** 参加者名＋募集バッジを親要素へ追加 */
function appendPartyGroupLine(host, group, size) {
  const names = group.map((m) => m.name).join('・');
  const open = size - group.length;
  if (names) {
    const nameEl = document.createElement('span');
    nameEl.className = 'slot-party-names';
    nameEl.textContent = names;
    host.appendChild(nameEl);
  }
  if (open > 0) {
    const vac = document.createElement('span');
    vac.className = 'slot-party-vac';
    vac.textContent = partyVacancyLabel(open);
    host.appendChild(vac);
  }
}

function sortieMemberIdSet(sortie) {
  ensureParties(sortie);
  return new Set((sortie.memberIds || []).filter(Boolean));
}

/** 選択メンバーのいずれかが参加している出撃か（未選択ならすべて対象） */
function sortieMatchesMemberFilter(sortie, selectedIds = memberFilterIds) {
  if (!selectedIds || selectedIds.size === 0) return true;
  const inSortie = sortieMemberIdSet(sortie);
  for (const id of selectedIds) {
    if (inSortie.has(id)) return true;
  }
  return false;
}

/** デュオ/トリオの空き枠があるか（募集中） */
function sortieIsRecruiting(sortie) {
  const size = partySizeOf(sortie);
  const parties = ensureParties(sortie);
  return parties.some((p) => (Array.isArray(p) ? p.length : 0) < size);
}

function findMemberPartyIndex(sortie, memberId) {
  const parties = ensureParties(sortie);
  return parties.findIndex((p) => p.includes(memberId));
}

function removeMemberFromParties(sortie, memberId) {
  const parties = ensureParties(sortie);
  sortie.parties = parties.map((p) => p.filter((id) => id !== memberId));
  if (!sortie.parties.length) sortie.parties = [[]];
  compactEmptyParties(sortie);
}

/** 名簿の表示名を変更（参加中パーティの表示も更新） */
function applyMemberRename(memberId, nextName) {
  const member = state.members.find((m) => m.id === memberId);
  if (!member) return { ok: false, reason: 'missing' };
  const trimmed = String(nextName || '').trim();
  if (!trimmed) return { ok: false, reason: 'empty' };
  if (trimmed === member.name) return { ok: true, unchanged: true };
  member.name = trimmed;
  member.updatedAt = Date.now();
  persist();
  return { ok: true, name: trimmed };
}

/** 名簿から削除し、全出撃のパーティからも外す */
async function deleteMemberFromRoster(memberId) {
  if (!memberId) return false;
  const member = state.members.find((m) => m.id === memberId);
  if (!member) return false;
  const inParties = state.sorties.some((s) => findMemberPartyIndex(s, memberId) >= 0);
  const label = member.name || 'このメンバー';
  const ok = await openConfirmModal({
    title: '名簿から削除',
    message: inParties
      ? `「${label}」を名簿から削除しますか？参加中のパーティからも外れます。`
      : `「${label}」を名簿から削除しますか？`,
    confirmLabel: '削除する',
    cancelLabel: 'キャンセル',
    danger: true,
  });
  if (!ok) return false;
  state.members = state.members.filter((m) => m.id !== memberId);
  for (const s of state.sorties) {
    removeMemberFromParties(s, memberId);
  }
  persist();
  return true;
}

function addMemberToParty(sortie, memberId, partyIndex) {
  ensureParties(sortie);
  const size = partySizeOf(sortie);
  let idx = partyIndex;
  if (idx == null || idx < 0) idx = 0;
  while (sortie.parties.length <= idx) sortie.parties.push([]);
  const alreadyHere = sortie.parties[idx].includes(memberId);
  if (!alreadyHere && sortie.parties[idx].length >= size) {
    return { ok: false, reason: 'full', partyIndex: idx };
  }
  // 他パーティから外してから入れる
  sortie.parties = sortie.parties.map((p, i) =>
    i === idx ? p : p.filter((id) => id !== memberId)
  );
  if (!sortie.parties[idx].includes(memberId)) {
    if (sortie.parties[idx].length >= size) {
      return { ok: false, reason: 'full', partyIndex: idx };
    }
    sortie.parties[idx].push(memberId);
  }
  compactEmptyParties(sortie);
  // 詰め後にメンバーがいるパーティ番号を返す
  idx = findMemberPartyIndex(sortie, memberId);
  return { ok: true, partyIndex: Math.max(0, idx) };
}

/**
 * 空パーティを整理する。
 * - 通常: 空はすべて除去（1つも無いときは空枠を1つだけ残す）
 * - keepTrailingEmpty: 途中の空は捨て、末尾の空枠は1つ残す（モーダル中の「+ 追加」用）
 */
function compactEmptyParties(sortie, opts = {}) {
  if (!sortie || !Array.isArray(sortie.parties)) return [[]];
  const parties = sortie.parties.map((p) =>
    Array.isArray(p) ? [...new Set(p.filter(Boolean))] : []
  );
  const filled = parties.filter((p) => p.length > 0);
  const keepTrailing =
    opts.keepTrailingEmpty ?? Boolean(modal && partySortieId);
  if (keepTrailing) {
    const wantTrailing = parties.length > 0 && parties[parties.length - 1].length === 0;
    sortie.parties = wantTrailing ? [...filled, []] : filled.length ? filled : [[]];
  } else {
    sortie.parties = filled.length ? filled : [[]];
  }
  sortie.memberIds = sortie.parties.flat();
  return sortie.parties;
}

/** 指定パーティのメンバーをまとめて置き換え（最大 partySize） */
function setPartyMembers(sortie, partyIndex, memberIds) {
  ensureParties(sortie);
  const size = partySizeOf(sortie);
  const ids = [...new Set((memberIds || []).filter(Boolean))].slice(0, size);
  while (sortie.parties.length <= partyIndex) sortie.parties.push([]);
  sortie.parties = sortie.parties.map((p, i) =>
    i === partyIndex ? [] : p.filter((id) => !ids.includes(id))
  );
  sortie.parties[partyIndex] = ids;
  compactEmptyParties(sortie);
}

function addEmptyParty(sortie) {
  ensureParties(sortie);
  // 末尾が空なら増やさずそこを選択
  if (sortie.parties[sortie.parties.length - 1]?.length === 0) {
    return { ok: true, partyIndex: sortie.parties.length - 1 };
  }
  sortie.parties.push([]);
  return { ok: true, partyIndex: sortie.parties.length - 1 };
}

function refreshSortieRoster(sortie) {
  if (!sortie) return;
  ensureParties(sortie);
  // 空パーティはここでは消さない（編集中の「+ 追加」が消えてしまう）
  const next = { ...(sortie.roster && typeof sortie.roster === 'object' ? sortie.roster : {}) };
  const used = new Set(
    (Array.isArray(sortie.parties) ? sortie.parties.flat() : sortie.memberIds || []).filter(Boolean)
  );
  sortie.memberIds = [...used];
  for (const id of used) {
    const local = state.members.find((m) => m.id === id);
    const prev = next[id];
    const src = local || prev;
    if (!src) continue;
    const avatarUrl = sanitizeAvatarForRoster(src);
    next[id] = {
      id: String(src.id),
      name: String(src.name || '').trim() || 'メンバー',
      avatarUrl,
    };
  }
  for (const id of Object.keys(next)) {
    if (!used.has(id)) delete next[id];
  }
  sortie.roster = next;
  sortie.updatedAt = Date.now();
}

let boardPushTimer = null;
let boardPullTimer = null;
let boardSyncing = false;
let boardReady = false;
let boardError = '';
/** ローカル変更の世代。pull 中に進んだらその結果は捨てる */
let boardLocalGen = 0;
/** 未反映の push がある */
let boardPushPending = false;
let boardLastPushAt = 0;
let boardPushChain = Promise.resolve();
/** @type {{ sorties: any[], members: any[], updatedAt: number } | null} */
let cachedRemoteBoard = null;
let cachedRemoteAt = 0;

function rememberRemoteBoard(board) {
  if (!board) return;
  cachedRemoteBoard = {
    sorties: Array.isArray(board.sorties) ? board.sorties : [],
    members: Array.isArray(board.members) ? board.members : [],
    updatedAt: Number(board.updatedAt) || Date.now(),
  };
  cachedRemoteAt = Date.now();
}

async function getRemoteBoardForMerge() {
  // 直近の取得結果があれば再利用（Gist rate limit 対策）
  if (cachedRemoteBoard && Date.now() - cachedRemoteAt < 20000) {
    return cachedRemoteBoard;
  }
  const board = await fetchSharedBoard();
  rememberRemoteBoard(board);
  return board;
}

function loadDeletedSortieMap() {
  try {
    const raw = JSON.parse(localStorage.getItem(DELETED_SORTIES_KEY) || '{}');
    const map = new Map();
    const now = Date.now();
    for (const [id, at] of Object.entries(raw || {})) {
      const ts = Number(at);
      if (!id || !Number.isFinite(ts)) continue;
      if (now - ts < TOMBSTONE_TTL_MS) map.set(String(id), ts);
    }
    return map;
  } catch {
    return new Map();
  }
}

function saveDeletedSortieMap(map) {
  try {
    localStorage.setItem(DELETED_SORTIES_KEY, JSON.stringify(Object.fromEntries(map)));
  } catch {
    /* ignore */
  }
}

/** @type {Map<string, number>} */
let deletedSortieIds = loadDeletedSortieMap();

function markSortieDeleted(sortieId) {
  if (!sortieId) return;
  deletedSortieIds.set(String(sortieId), Date.now());
  saveDeletedSortieMap(deletedSortieIds);
}

function pruneDeletedSortieTombstones(remoteSorties) {
  const remoteIds = new Set((remoteSorties || []).map((s) => String(s.id)));
  let changed = false;
  for (const id of [...deletedSortieIds.keys()]) {
    if (!remoteIds.has(id)) {
      deletedSortieIds.delete(id);
      changed = true;
    }
  }
  if (changed) saveDeletedSortieMap(deletedSortieIds);
}

function noteLocalBoardChange() {
  boardLocalGen += 1;
  boardPushPending = true;
}

function mergeSortieLists(remoteList, localList) {
  const map = new Map();
  for (const s of remoteList || []) {
    const id = String(s?.id || '');
    if (!id || deletedSortieIds.has(id)) continue;
    map.set(id, s);
  }
  for (const s of localList || []) {
    const id = String(s?.id || '');
    if (!id || deletedSortieIds.has(id)) continue;
    const prev = map.get(id);
    if (!prev || Number(s.updatedAt || 0) >= Number(prev.updatedAt || 0)) {
      map.set(id, s);
    }
  }
  return [...map.values()];
}

function mergeMemberLists(remoteList, localList) {
  const map = new Map();
  for (const m of remoteList || []) {
    const id = String(m?.id || '');
    if (!id) continue;
    map.set(id, m);
  }
  for (const m of localList || []) {
    const id = String(m?.id || '');
    if (!id) continue;
    const prev = map.get(id);
    const localTs = Number(m.updatedAt || m.createdAt || 0);
    const prevTs = Number(prev?.updatedAt || prev?.createdAt || 0);
    if (!prev || localTs >= prevTs) map.set(id, m);
  }
  return [...map.values()];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function persist(opts = {}) {
  if (opts.sortieId) {
    const s = state.sorties.find((x) => x.id === opts.sortieId);
    if (s) refreshSortieRoster(s);
  } else {
    for (const s of state.sorties) refreshSortieRoster(s);
  }
  saveState(state);
  if (!opts.skipSync && boardReady) {
    noteLocalBoardChange();
    queueBoardPush();
  }
}

function queueBoardPush() {
  boardPushPending = true;
  clearTimeout(boardPushTimer);
  boardPushTimer = setTimeout(() => {
    enqueueBoardPush().catch(() => {});
  }, 250);
}

/** 直列化した push（複数端末の競合を減らすため取得→マージ→保存） */
function enqueueBoardPush() {
  boardPushPending = true;
  const run = async () => {
    await flushBoardPushWithRetry();
  };
  boardPushChain = boardPushChain.then(run, run);
  return boardPushChain;
}

async function flushBoardPushWithRetry() {
  const maxAttempts = 4;
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const gen = boardLocalGen;
    try {
      await pushBoardNow();
      if (boardLocalGen === gen) boardPushPending = false;
      return;
    } catch (e) {
      lastErr = e;
      boardError = String(e.message || e);
      console.warn('[board push]', attempt, e);
      const retryable = e instanceof BoardSyncError ? e.retryable : /rate limit|429|403|503|502/i.test(String(e.message || e));
      if (!retryable || attempt === maxAttempts) break;
      await sleep(Math.min(8000, 700 * 2 ** (attempt - 1)));
      // リトライ前に新しいローカル変更があればそれを載せる
    }
  }
  boardPushPending = false;
  throw lastErr || new Error('共有ボードの保存に失敗しました');
}

async function pushBoardNow() {
  boardSyncing = true;
  const gen = boardLocalGen;
  try {
    for (const s of state.sorties) {
      compactEmptyParties(s, { keepTrailingEmpty: false });
      reconcileSortieAgainstMembers(s);
      refreshSortieRoster(s);
    }

    // 他端末の変更を取り込みつつ、ローカル削除・更新を優先マージ
    let remote = { sorties: [], members: [], updatedAt: 0 };
    try {
      remote = await getRemoteBoardForMerge();
    } catch (e) {
      console.warn('[board push] remote fetch skipped', e);
      if (cachedRemoteBoard) remote = cachedRemoteBoard;
    }

    const mergedSorties = mergeSortieLists(remote.sorties, state.sorties);
    const mergedMembers = mergeMemberLists(remote.members, state.members);

    const board = await pushSharedBoard({
      sorties: mergedSorties,
      members: mergedMembers,
    });

    // 古い API が partySize を落とす場合に備え、送信分を戻す
    const sentById = new Map(mergedSorties.map((s) => [String(s.id), s]));
    if (Array.isArray(board.sorties)) {
      board.sorties = board.sorties.map((s) => {
        const sent = sentById.get(String(s.id));
        if (!sent) return s;
        const remoteSize = Number(s.partySize);
        if (remoteSize === 2 || remoteSize === 3) return s;
        return { ...s, partySize: partySizeOf(sent) };
      });
    }

    rememberRemoteBoard(board);
    pruneDeletedSortieTombstones(board.sorties);
    boardLastPushAt = Date.now();

    // push 中にさらにローカル変更がなければサーバ結果を反映
    if (boardLocalGen === gen) {
      applySharedBoard(board);
      boardPushPending = false;
    } else {
      // 新しい変更があるのでローカル一覧は維持し、削除墓石だけ同期結果に合わせる
      state.sorties = state.sorties.filter((s) => !deletedSortieIds.has(String(s.id)));
      saveState(state);
    }
    boardError = '';
  } finally {
    boardSyncing = false;
  }
}

async function pullBoard({ migrateLocal = false } = {}) {
  if (boardPushPending || boardSyncing) return;
  if (Date.now() - boardLastPushAt < 4000) return;

  const genAtStart = boardLocalGen;
  const localSorties = Array.isArray(state.sorties) ? state.sorties.slice() : [];
  const localMembers = Array.isArray(state.members) ? state.members.slice() : [];
  const board = await fetchSharedBoard();
  // 取得中に解除・編集していたら古い共有で上書きしない
  if (genAtStart !== boardLocalGen || boardPushPending) return;

  const boardHasSorties = Boolean(board.sorties?.length);
  const boardHasMembers = Boolean(board.members?.length);

  // 共有ボードが完全に空のときだけ、端末データを初回アップロード
  if (migrateLocal && !boardHasSorties && !boardHasMembers && (localSorties.length || localMembers.length)) {
    state.sorties = localSorties;
    state.members = localMembers;
    boardReady = true;
    noteLocalBoardChange();
    await enqueueBoardPush();
    return;
  }

  boardReady = true;
  applySharedBoard(board, { repairPush: true });
  rememberRemoteBoard(board);
  pruneDeletedSortieTombstones(board.sorties);
  boardError = '';
}

function startBoardPolling() {
  clearInterval(boardPullTimer);
  boardPullTimer = setInterval(() => {
    if (document.hidden || boardSyncing || boardPushPending || (modal && partySortieId)) return;
    pullBoard()
      .then(() => refreshUi())
      .catch((e) => {
        console.warn('[board pull]', e);
      });
  }, BOARD_POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !boardPushPending && !(modal && partySortieId)) {
      pullBoard()
        .then(() => refreshUi())
        .catch(() => {});
    }
  });
}

/** 終了時刻を過ぎた出撃を削除。削除したら true */
function pruneExpiredSorties(now = Date.now()) {
  const before = state.sorties.length;
  state.sorties = state.sorties.filter((s) => {
    const endMs = new Date(s.endAt).getTime();
    if (Number.isFinite(endMs)) return endMs > now;
    const startMs = new Date(s.startAt).getTime();
    if (Number.isFinite(startMs)) return startMs + 3600000 > now;
    return false;
  });
  if (state.sorties.length === before) return false;
  if (partySortieId && !state.sorties.some((s) => s.id === partySortieId)) {
    closeModal();
  }
  persist();
  return true;
}

function showToast(message) {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  document.body.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 2200);
}

/** 既存モーダルの上に重ねる確認ダイアログ（ブラウザ confirm は使わない） */
function openConfirmModal({
  title = '確認',
  message = '',
  confirmLabel = 'OK',
  cancelLabel = 'キャンセル',
  danger = false,
} = {}) {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop modal-backdrop--confirm';
    const modalEl = document.createElement('div');
    modalEl.className = 'modal modal-confirm';
    modalEl.innerHTML = `
      <h3>${esc(title)}</h3>
      <p class="confirm-message">${esc(message)}</p>
      <div class="modal-actions">
        <button type="button" class="btn modal-close" data-act="cancel">${esc(cancelLabel)}</button>
        <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-act="ok">${esc(
          confirmLabel
        )}</button>
      </div>
    `;
    const finish = (ok) => {
      backdrop.remove();
      resolve(ok);
    };
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) finish(false);
    });
    modalEl.querySelector('[data-act="cancel"]').addEventListener('click', () => finish(false));
    modalEl.querySelector('[data-act="ok"]').addEventListener('click', () => finish(true));
    backdrop.appendChild(modalEl);
    document.body.appendChild(backdrop);
    requestAnimationFrame(() => modalEl.querySelector('[data-act="ok"]')?.focus());
  });
}

/** 既存モーダルの上に重ねる1行入力ダイアログ（ブラウザ prompt は使わない） */
function openPromptModal({
  title = '入力',
  label = '',
  initialValue = '',
  confirmLabel = 'OK',
  cancelLabel = 'キャンセル',
  placeholder = '',
} = {}) {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop modal-backdrop--confirm';
    const modalEl = document.createElement('div');
    modalEl.className = 'modal modal-confirm modal-prompt';
    modalEl.innerHTML = `
      <h3>${esc(title)}</h3>
      <div class="field">
        <label for="prompt-input">${esc(label || '内容')}</label>
        <input id="prompt-input" type="text" data-prompt-input value="${esc(initialValue)}" placeholder="${esc(
          placeholder
        )}" autocomplete="off" />
      </div>
      <div class="modal-actions">
        <button type="button" class="btn modal-close" data-act="cancel">${esc(cancelLabel)}</button>
        <button type="button" class="btn btn-primary" data-act="ok">${esc(confirmLabel)}</button>
      </div>
    `;
    const input = modalEl.querySelector('[data-prompt-input]');
    const finish = (value) => {
      backdrop.remove();
      resolve(value);
    };
    const submit = () => finish(String(input.value || ''));
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) finish(null);
    });
    modalEl.querySelector('[data-act="cancel"]').addEventListener('click', () => finish(null));
    modalEl.querySelector('[data-act="ok"]').addEventListener('click', submit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(null);
      }
    });
    backdrop.appendChild(modalEl);
    document.body.appendChild(backdrop);
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  });
}

async function renameMemberFromRoster(memberId) {
  const member = state.members.find((m) => m.id === memberId);
  if (!member) return false;
  const next = await openPromptModal({
    title: '名前を変更',
    label: '新しい名前',
    initialValue: member.name || '',
    confirmLabel: '保存',
    placeholder: '名前',
  });
  if (next == null) return false;
  const res = applyMemberRename(memberId, next);
  if (!res.ok) {
    if (res.reason === 'empty') showToast('名前を入れてください');
    return false;
  }
  if (!res.unchanged) showToast(`「${res.name}」に変更しました`);
  return true;
}

function sanitizeAvatarForRoster(src) {
  const v = String(src?.avatarDataUrl || src?.avatarUrl || '').trim();
  if (v.startsWith('http') && v.length <= 500) return v;
  if (v.startsWith('data:image/') && v.length <= 14000) return v;
  return '';
}

function applyMemberAvatar(memberId, dataUrl) {
  const member = state.members.find((m) => m.id === memberId);
  if (!member) return false;
  if (!dataUrl) {
    member.avatarDataUrl = null;
    member.avatarUrl = null;
  } else if (dataUrl.startsWith('http')) {
    member.avatarUrl = dataUrl.slice(0, 500);
    member.avatarDataUrl = null;
  } else {
    member.avatarDataUrl = dataUrl;
    member.avatarUrl = dataUrl.length <= 14000 ? dataUrl : null;
  }
  member.updatedAt = Date.now();
  persist();
  return true;
}

/** 画像を正方形に切り出して小さい data URL にする（共有ボード用） */
function readImageAsAvatarDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (!file || !String(file.type || '').startsWith('image/')) {
      reject(new Error('画像ファイルを選んでください'));
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      reject(new Error('画像が大きすぎます（8MBまで）'));
      return;
    }
    const objUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(objUrl);
      const tryEncode = (size, quality) => {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        const scale = Math.max(size / img.naturalWidth, size / img.naturalHeight);
        const w = img.naturalWidth * scale;
        const h = img.naturalHeight * scale;
        ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
        return canvas.toDataURL('image/jpeg', quality);
      };
      let dataUrl = tryEncode(96, 0.72);
      if (!dataUrl) {
        reject(new Error('画像の変換に失敗しました'));
        return;
      }
      let q = 0.72;
      while (dataUrl.length > 12000 && q > 0.45) {
        q -= 0.08;
        dataUrl = tryEncode(96, q) || dataUrl;
      }
      if (dataUrl.length > 14000) dataUrl = tryEncode(72, 0.55) || dataUrl;
      if (dataUrl.length > 14000) {
        reject(new Error('画像を十分に小さくできませんでした'));
        return;
      }
      resolve(dataUrl);
    };
    img.onerror = () => {
      URL.revokeObjectURL(objUrl);
      reject(new Error('画像を読み込めませんでした'));
    };
    img.src = objUrl;
  });
}

async function editMemberAvatarFromRoster(memberId) {
  const member = state.members.find((m) => m.id === memberId);
  if (!member) return false;
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop modal-backdrop--confirm';
    const modalEl = document.createElement('div');
    modalEl.className = 'modal modal-confirm modal-avatar-edit';
    modalEl.tabIndex = -1;

    const applyFromFile = async (file) => {
      if (!file) return;
      try {
        const dataUrl = await readImageAsAvatarDataUrl(file);
        applyMemberAvatar(memberId, dataUrl);
        showToast('アイコンを更新しました');
        paint();
      } catch (err) {
        showToast(String(err.message || err));
      }
    };

    const applyFromClipboard = async () => {
      try {
        if (navigator.clipboard?.read) {
          const items = await navigator.clipboard.read();
          for (const item of items) {
            const type = item.types.find((t) => t.startsWith('image/'));
            if (!type) continue;
            const blob = await item.getType(type);
            await applyFromFile(new File([blob], 'clipboard.png', { type: blob.type || type }));
            return;
          }
          showToast('クリップボードに画像がありません');
          return;
        }
        showToast('Ctrl+V / ⌘V で画像を貼り付けてください');
      } catch (err) {
        const msg = String(err.message || err);
        if (/denied|permission|not allowed/i.test(msg)) {
          showToast('クリップボードの許可が必要です。Ctrl+V / ⌘V でも貼れます');
        } else {
          showToast(msg || '貼り付けに失敗しました');
        }
      }
    };

    const onPaste = (e) => {
      const items = e.clipboardData?.items;
      if (!items?.length) return;
      for (const item of items) {
        if (!item.type.startsWith('image/')) continue;
        e.preventDefault();
        const file = item.getAsFile();
        applyFromFile(file);
        return;
      }
    };

    const finish = (ok) => {
      document.removeEventListener('paste', onPaste);
      backdrop.remove();
      resolve(ok);
    };

    const paint = () => {
      const live = state.members.find((m) => m.id === memberId) || member;
      const src = live.avatarDataUrl || live.avatarUrl;
      const isMac = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || '');
      const modKey = isMac ? '⌘' : 'Ctrl';
      modalEl.innerHTML = `
        <h3>アイコンを変更</h3>
        <p class="hint avatar-edit-name">${esc(live.name || '')}</p>
        <div class="avatar-edit-preview" data-preview></div>
        <div class="avatar-drop" data-drop tabindex="0" role="button" aria-label="画像をドロップ、クリック、または貼り付け">
          <input type="file" accept="image/*" data-file hidden />
          <p class="avatar-drop-main">
            ここにドロップ / クリックして選択 /
            <kbd class="kbd">${esc(modKey)}</kbd>
            <span class="avatar-drop-plus">+</span>
            <kbd class="kbd">V</kbd>
            で貼り付け
          </p>
          <p class="avatar-drop-sub">画像をコピーしたあと、ここで貼り付けできます</p>
          <button type="button" class="btn avatar-drop-paste" data-act="paste">クリップボードから取り込む</button>
        </div>
        <div class="avatar-edit-footer">
          <button type="button" class="btn btn-ghost" data-act="clear"${src ? '' : ' disabled'}>アイコンを消す</button>
          <button type="button" class="btn modal-close" data-act="close">閉じる</button>
        </div>
      `;
      const preview = modalEl.querySelector('[data-preview]');
      preview.appendChild(avatarNode(live));
      const drop = modalEl.querySelector('[data-drop]');
      const fileInput = modalEl.querySelector('[data-file]');

      backdrop.onclick = (e) => {
        if (e.target === backdrop) finish(false);
      };
      modalEl.querySelector('[data-act="close"]').addEventListener('click', () => finish(true));
      modalEl.querySelector('[data-act="paste"]').addEventListener('click', (e) => {
        e.stopPropagation();
        applyFromClipboard();
      });
      modalEl.querySelector('[data-act="clear"]').addEventListener('click', () => {
        applyMemberAvatar(memberId, null);
        showToast('アイコンを消しました');
        paint();
      });
      fileInput.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        await applyFromFile(file);
      });
      drop.addEventListener('click', (e) => {
        if (e.target.closest('[data-act="paste"]')) return;
        fileInput.click();
      });
      drop.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          fileInput.click();
        }
      });
      drop.addEventListener('dragover', (e) => {
        e.preventDefault();
        drop.classList.add('is-drag');
      });
      drop.addEventListener('dragleave', () => drop.classList.remove('is-drag'));
      drop.addEventListener('drop', async (e) => {
        e.preventDefault();
        drop.classList.remove('is-drag');
        const file = [...(e.dataTransfer?.files || [])].find((f) => f.type.startsWith('image/'));
        if (!file) {
          showToast('画像ファイルをドロップしてください');
          return;
        }
        await applyFromFile(file);
      });
    };

    document.addEventListener('paste', onPaste);
    paint();
    backdrop.appendChild(modalEl);
    document.body.appendChild(backdrop);
    requestAnimationFrame(() => modalEl.focus());
  });
}

async function removeSortieById(sortieId) {
  const ok = await openConfirmModal({
    title: 'レイドを解除',
    message: 'このレイドを解除しますか？',
    confirmLabel: '解除する',
    cancelLabel: 'キャンセル',
    danger: true,
  });
  if (!ok) return false;
  const wasOpen = partySortieId === sortieId;
  markSortieDeleted(sortieId);
  state.sorties = state.sorties.filter((s) => s.id !== sortieId);
  saveState(state);
  // モーダルを閉じる（closeModal の再 persist で競合しないよう直接閉じる）
  if (wasOpen) {
    modal = null;
    partySortieId = null;
    openPartyModal._repaint = null;
    document.querySelectorAll('.modal-backdrop').forEach((el) => el.remove());
  }
  render();
  showToast('レイドを解除しました');

  if (boardReady) {
    noteLocalBoardChange();
    clearTimeout(boardPushTimer);
    try {
      await enqueueBoardPush();
      showToast('共有にも反映しました');
    } catch (e) {
      console.warn('[board push]', e);
      boardError = String(e.message || e);
      const rateLimited = /rate limit|403|429/i.test(boardError);
      showToast(
        rateLimited
          ? '端末では解除済み。共有が混み合っているため自動で再試行します'
          : '端末では解除済み。共有への反映に失敗したため後で再試行します'
      );
      // 墓石があるので他端末の古い取得でもすぐには戻らない。少し置いて再送
      setTimeout(() => {
        if (!boardReady || !deletedSortieIds.size) return;
        noteLocalBoardChange();
        enqueueBoardPush().catch(() => {});
      }, 15000);
    }
  }
  return true;
}

function initials(name) {
  return (String(name || '').trim().slice(0, 1) || '?').toUpperCase();
}

function avatarNode(member) {
  const src = member?.avatarDataUrl || member?.avatarUrl;
  if (src) {
    const img = document.createElement('img');
    img.className = 'avatar';
    img.src = src;
    img.alt = '';
    img.draggable = false;
    img.referrerPolicy = 'no-referrer';
    return img;
  }
  const ph = document.createElement('span');
  ph.className = 'avatar-fallback';
  ph.textContent = initials(member?.name);
  return ph;
}

function toLocalInputValue(ms) {
  const date = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
}

function fmtHm(ms) {
  return new Intl.DateTimeFormat('ja-JP', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(ms));
}

function fmtSlotRange(startMs, endMs) {
  return { start: fmtHm(startMs), end: fmtHm(endMs) };
}

/** イベントタイマーと同じ「9月16日 (水)」形式 */
function fmtDateWeekJa(ms) {
  const d = new Date(ms);
  const week = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
  return `${d.getMonth() + 1}月${d.getDate()}日 (${week})`;
}

/** Discord / クリップボード用の短い日付 */
function fmtDateSlashWeekJa(ms) {
  const d = new Date(ms);
  const week = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
  return `${d.getMonth() + 1}/${d.getDate()}(${week})`;
}

function formatCountdownHmsShort(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${m}m ${String(s).padStart(2, '0')}s`;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

function remainText(startMs, endMs, now = Date.now()) {
  if (now >= endMs) return { text: '—', kind: 'past' };
  if (now >= startMs) return { text: '実施中', kind: 'live' };
  return { text: formatCountdownHmsShort(startMs - now), kind: '' };
}

/** カウントダウン要素に開始/終了を紐づけ、後から1秒更新できるようにする */
function bindCountdownEl(el, startMs, endMs, liveClass = 'is-live') {
  el.dataset.cdStart = String(startMs);
  el.dataset.cdEnd = String(endMs);
  el.dataset.cdLiveClass = liveClass;
  const remain = remainText(startMs, endMs);
  el.textContent = remain.text;
  if (liveClass) el.classList.toggle(liveClass, remain.kind === 'live');
  return el;
}

function tickCountdowns(now = Date.now()) {
  if (!app) return;
  app.querySelectorAll('[data-cd-start][data-cd-end]').forEach((el) => {
    const startMs = Number(el.dataset.cdStart);
    const endMs = Number(el.dataset.cdEnd);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return;
    const liveClass = el.dataset.cdLiveClass || 'is-live';
    const remain = remainText(startMs, endMs, now);
    if (el.textContent !== remain.text) el.textContent = remain.text;
    if (liveClass) el.classList.toggle(liveClass, remain.kind === 'live');
    const host = el.closest('.sortie-time-row, .sortie-overlap-cluster');
    if (host) {
      if (remain.kind === 'live') host.classList.add('is-live');
      else if (remain.kind !== 'live') host.classList.remove('is-live');
    }
  });
}

function createSrvAbbr(slug) {
  const el = document.createElement('span');
  el.className = 'srv-abbr';
  el.dataset.serverRegion = slug;
  el.textContent = regionAbbr(slug);
  el.title = regionLabel(slug);
  return el;
}

function memberById(id, sortie = null) {
  const local = state.members.find((m) => m.id === id);
  if (local) return local;
  if (sortie?.roster?.[id]) return sortie.roster[id];
  for (const s of state.sorties) {
    if (s?.roster?.[id]) return s.roster[id];
  }
  return null;
}

function memberNameKey(name) {
  return String(name || '').trim().toLocaleLowerCase('ja');
}

/**
 * パーティ内のメンバーIDを共有名簿に合わせる。
 * 名簿に無い名前（端末だけの仮登録など）はパーティから外す。
 */
function reconcileSortieAgainstMembers(sortie) {
  if (!sortie) return false;
  ensureParties(sortie);
  const byId = new Map(state.members.map((m) => [m.id, m]));
  const byName = new Map();
  for (const m of state.members) {
    const key = memberNameKey(m.name);
    if (key && !byName.has(key)) byName.set(key, m);
  }
  const resolveId = (id) => {
    if (byId.has(id)) return id;
    const snap = sortie.roster?.[id];
    const match = snap?.name ? byName.get(memberNameKey(snap.name)) : null;
    return match ? match.id : null;
  };
  const before = JSON.stringify(sortie.parties);
  sortie.parties = sortie.parties.map((party) => {
    const next = [];
    const seen = new Set();
    for (const id of party) {
      const resolved = resolveId(id);
      if (!resolved || seen.has(resolved)) continue;
      seen.add(resolved);
      next.push(resolved);
    }
    return next.slice(0, partySizeOf(sortie));
  });
  compactEmptyParties(sortie);
  refreshSortieRoster(sortie);
  return JSON.stringify(sortie.parties) !== before;
}

function applySharedBoard(board, { repairPush = false } = {}) {
  const prevById = new Map((state.sorties || []).map((s) => [String(s.id), s]));
  state.sorties = Array.isArray(board.sorties)
    ? board.sorties
        .filter((s) => s && !deletedSortieIds.has(String(s.id)))
        .map((s) => {
          const prev = prevById.get(String(s.id));
          const remoteSize = Number(s.partySize);
          const prevSize = Number(prev?.partySize);
          // サーバが partySize を落とす／未対応のとき、ローカルのデュオ設定を消さない
          const partySize =
            remoteSize === 2 || remoteSize === 3
              ? remoteSize
              : prevSize === 2 || prevSize === 3
                ? prevSize
                : DEFAULT_PARTY_SIZE;
          return {
            ...s,
            parties: Array.isArray(s.parties)
              ? s.parties.map((p) => (Array.isArray(p) ? [...p].slice(0, partySize) : []))
              : [[]],
            partySize,
            timingTags: normalizeTimingTags(s.timingTags),
            roster: s.roster && typeof s.roster === 'object' ? { ...s.roster } : {},
          };
        })
    : [];
  state.members = Array.isArray(board.members)
    ? board.members.map((m) => {
        const avatarUrl = String(m.avatarUrl || '').trim();
        return {
          ...m,
          avatarUrl: avatarUrl || null,
          avatarDataUrl: avatarUrl.startsWith('data:image/') ? avatarUrl : m.avatarDataUrl || null,
        };
      })
    : [];
  let repaired = false;
  for (const s of state.sorties) {
    compactEmptyParties(s);
    if (reconcileSortieAgainstMembers(s)) repaired = true;
  }
  saveState(state);
  if (repairPush && repaired && boardReady) queueBoardPush();
  if (modal && partySortieId) repaintPartyModal({ light: true });
  return repaired;
}

function isRegisteredSlot(slot, trialId) {
  return !!findSortieForSlot(slot, trialId);
}

function findSortieForSlot(slot, trialId) {
  const key = slotKey(slot);
  return (
    state.sorties.find(
      (s) => s.slotKey === key && (s.trialId == null || s.trialId === trialId)
    ) || null
  );
}

function ensureSortieFromSchedule(trial, slot) {
  const existing = findSortieForSlot(slot, trial.id);
  if (existing) return existing;
  const key = slotKey(slot);
  const sortie = createSortie({
    startAt: toLocalInputValue(slot.startMs),
    endAt: toLocalInputValue(slot.endMs),
    server: regionAbbr(slot.region),
    map: slot.map,
    event: slot.event,
    objective: trial.nameJa || trial.name,
    memberIds: [],
  });
  sortie.slotKey = key;
  sortie.trialId = trial.id;
  sortie.regionSlug = slot.region;
  sortie.imageUrl = trial.imageUrl || '';
  state.sorties.push(sortie);
  persist();
  return sortie;
}

function openSlotParty(trial, slot) {
  const sortie = ensureSortieFromSchedule(trial, slot);
  openPartyModal(sortie.id);
}

function discordCopyText(sortie) {
  const startMs = new Date(sortie.startAt).getTime();
  const endMs = new Date(sortie.endAt).getTime();
  const datePart = Number.isFinite(startMs) ? fmtDateSlashWeekJa(startMs) : '';
  const { start, end } = Number.isFinite(startMs)
    ? fmtSlotRange(startMs, Number.isFinite(endMs) ? endMs : startMs + 3600000)
    : { start: '', end: '' };
  const size = partySizeOf(sortie);
  const groups = partyMemberLists(sortie);
  const filled = groups.filter((g) => g.length);
  const peopleLines =
    filled.length <= 1
      ? (() => {
          const g = filled[0] || [];
          const open = size - g.length;
          const names = g.map((m) => `@${m.name}`).join(' ');
          return open > 0
            ? `${names}${names ? ' ' : ''}${partyVacancyLabel(open)}`.trim()
            : names;
        })()
      : groups
          .map((g, i) => {
            if (!g.length && i > 0) return null;
            const open = size - g.length;
            const names = g.map((m) => `@${m.name}`).join(' ');
            const vac = open > 0 ? ` ${partyVacancyLabel(open)}` : '';
            return `パーティ${i + 1}（${partySizeLabel(size)}）: ${names || partyVacancyLabel(size)}${vac && names ? vac : ''}`;
          })
          .filter(Boolean)
          .join('\n');
  return [
    `${datePart} ${start} - ${end}`.trim(),
    [regionLabel(sortie.regionSlug) || sortie.server, sortie.map, sortie.event]
      .filter(Boolean)
      .join(' '),
    sortie.objective ? `「${sortie.objective}」` : '',
    `編成: ${partySizeLabel(size)}（各${size}人）`,
    timingTagsLine(sortie),
    peopleLines,
  ]
    .filter(Boolean)
    .join('\n');
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast('Discord用テキストをコピーしました');
  } catch {
    showToast('コピーに失敗しました');
  }
}

function closeModal({ keepParty = false } = {}) {
  const closingParty = Boolean(partySortieId) && !keepParty;
  const editedSortieId = closingParty ? partySortieId : null;
  modal = null;
  openPartyModal._repaint = null;
  document.querySelector('.modal-backdrop')?.remove();
  if (!keepParty) {
    partySortieId = null;
  }
  // パーティ編集は閉じるときに空枠を掃除し、共有ボードへ保存＆背面更新
  if (closingParty) {
    const s = editedSortieId ? state.sorties.find((x) => x.id === editedSortieId) : null;
    if (s) compactEmptyParties(s, { keepTrailingEmpty: false });
    persist(editedSortieId ? { sortieId: editedSortieId } : {});
    render();
  }
}

function openModal(node) {
  closeModal({ keepParty: true });
  modal = node;
  document.body.appendChild(node);
}

const HELP_TOPICS = [
  {
    id: 'overview',
    title: 'はじめに',
    summary: 'このサイトでできること',
    body: `
      <p class="help-modal-para">このサイトは、ARC Raiders の<strong>レイド予約・メンバー共有</strong>用ツールです。MetaForge のスケジュールを見ながら時間枠を予約し、参加者やパーティ編成を仲間と共有できます。</p>
      <ul class="help-modal-dot-list">
        <li><strong>すべて</strong> … 今週／来週のトライアルカードと時間枠</li>
        <li><strong>レイド</strong> … 予約済みの一覧（タイムライン）</li>
        <li>予約内容は共有ボード経由で同じ URL を開いた端末と同期されます</li>
      </ul>
    `,
  },
  {
    id: 'schedule',
    title: 'スケジュール（すべて）',
    summary: 'トライアルカードと時間枠',
    body: `
      <p class="help-modal-para">上部の<strong>今週／来週</strong>と<strong>すべて</strong>で、トライアルカードを横に並べて表示します。</p>
      <ul class="help-modal-dot-list">
        <li>カードをタップすると、表示する<strong>マップ／イベント</strong>を選べます（すぐ反映）</li>
        <li>サーバー（NA・EU など）はツールバーのボタンで切り替えます</li>
        <li>時間枠の<strong>予約する</strong>でレイド登録、<strong>編集</strong>でメンバー画面を開きます</li>
      </ul>
    `,
  },
  {
    id: 'reserve',
    title: 'レイドを予約する',
    summary: '時間枠の登録と編集',
    body: `
      <p class="help-modal-para">空き枠の<strong>予約する</strong>を押すと、その時間のレイドが登録され、メンバー編集画面が開きます。</p>
      <ul class="help-modal-dot-list">
        <li>すでに予約済みの枠は青系で表示され、<strong>編集</strong>から内容を変えられます</li>
        <li>実施中の枠は緑系で強調されます</li>
        <li>不要になったらメンバー画面の<strong>レイドを解除</strong>で削除できます</li>
      </ul>
    `,
  },
  {
    id: 'party',
    title: 'メンバーとパーティ',
    summary: 'デュオ／トリオ・名簿',
    body: `
      <p class="help-modal-para">メンバー画面では参加者の追加とパーティ分けができます。</p>
      <ul class="help-modal-dot-list">
        <li><strong>デュオ／トリオ</strong> … 1パーティあたりの人数上限（2人／3人）</li>
        <li>パーティ枠をタップしてメンバーを選ぶか、PCではドラッグでも移動できます</li>
        <li>名簿のアイコンで画像変更、名前変更／×で名簿の編集ができます</li>
        <li><strong>0分開始／最終便</strong> … その時間帯の入り方メモ（レイド一覧で見やすく表示）</li>
        <li>空きがあるときは <strong>@1募集中</strong> のように表示されます</li>
      </ul>
    `,
  },
  {
    id: 'raid-list',
    title: 'レイド一覧と絞り込み',
    summary: 'タイムライン・メンバー・募集中',
    body: `
      <p class="help-modal-para">上部の<strong>レイド</strong>表示では、予約を時間順のタイムラインで見られます。</p>
      <ul class="help-modal-dot-list">
        <li><strong>メンバー: …</strong> … 選んだ人が1人でも参加しているレイドだけ表示</li>
        <li><strong>募集中</strong> … 空き枠があるレイドだけ表示（両方併用可）</li>
        <li>同じ時間・同じメンバーで重なる枠は<strong>重複</strong>としてまとまります</li>
        <li>行の ⋯ メニューから編集／解除ができます</li>
      </ul>
    `,
  },
  {
    id: 'discord',
    title: 'Discord用コピー',
    summary: '募集文の共有',
    body: `
      <p class="help-modal-para">メンバー画面の<strong>Discord用コピー</strong>で、日時・マップ・編成・参加者・募集枠入りのテキストをクリップボードにコピーできます。そのまま Discord の募集に貼り付けて使えます。</p>
    `,
  },
  {
    id: 'notes',
    title: '注意事項',
    summary: '出典と非公式であること',
    body: `
      <p class="help-modal-para">スケジュール情報の出典は <a href="https://metaforge.app/arc-raiders" target="_blank" rel="noopener noreferrer">MetaForge</a> です。ゲーム内や公式情報と異なる場合は、公式情報を優先してください。</p>
      <p class="help-modal-para">本サイトは非公式のファンメイドツールであり、公式・Embark とは無関係です。</p>
    `,
  },
];

function openHelpModal(topicId = null) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeModal();
  });

  const modalEl = document.createElement('div');
  modalEl.className = 'modal modal-help';
  modalEl.setAttribute('role', 'dialog');
  modalEl.setAttribute('aria-modal', 'true');
  modalEl.setAttribute('aria-labelledby', 'help-modal-title');

  const paint = (activeId) => {
    const topic = HELP_TOPICS.find((t) => t.id === activeId) || null;
    modalEl.innerHTML = `
      <div class="party-modal-head">
        <h3 id="help-modal-title">${topic ? esc(topic.title) : 'このサイトの使い方'}</h3>
        <button type="button" class="btn modal-close" data-act="close">閉じる</button>
      </div>
      <div class="help-modal-body" data-body></div>
    `;
    const body = modalEl.querySelector('[data-body]');
    if (!topic) {
      const intro = document.createElement('p');
      intro.className = 'help-modal-intro';
      intro.textContent =
        '知りたい項目を選んでください。レイドの予約からメンバー編成、絞り込みまでまとめています。';
      body.appendChild(intro);
      const list = document.createElement('div');
      list.className = 'help-modal-topic-list';
      for (const t of HELP_TOPICS) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'help-modal-topic-btn';
        btn.innerHTML = `<span class="help-modal-topic-btn-title">${esc(t.title)}</span><span class="help-modal-topic-btn-summary">${esc(t.summary)}</span>`;
        btn.addEventListener('click', () => paint(t.id));
        list.appendChild(btn);
      }
      body.appendChild(list);
      const note = document.createElement('p');
      note.className = 'help-modal-note';
      note.textContent =
        '※ スケジュールの出典は MetaForge です。ゲーム内や公式と異なる場合は公式情報を優先してください。';
      body.appendChild(note);
    } else {
      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'help-modal-back-btn';
      back.textContent = '← 一覧に戻る';
      back.addEventListener('click', () => paint(null));
      body.appendChild(back);
      const detail = document.createElement('div');
      detail.className = 'help-modal-detail';
      detail.innerHTML = topic.body;
      body.appendChild(detail);
    }
    modalEl.querySelector('[data-act="close"]').addEventListener('click', () => closeModal());
  };

  paint(topicId);
  backdrop.appendChild(modalEl);
  openModal(backdrop);
}

function openAboutModal() {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeModal();
  });
  const modalEl = document.createElement('div');
  modalEl.className = 'modal modal-help';
  modalEl.setAttribute('role', 'dialog');
  modalEl.setAttribute('aria-modal', 'true');
  modalEl.innerHTML = `
    <div class="party-modal-head">
      <h3>このサイトについて</h3>
      <button type="button" class="btn modal-close" data-act="close">閉じる</button>
    </div>
    <div class="help-modal-body">
      <p class="help-modal-para">本サイトは、個人クリエイター「あいすおじ」が制作・公開している、ARC Raiders 向けの無料ユーティリティです。週次トライアルのスケジュールを見ながらレイド枠を予約し、参加者やパーティ編成を共有できます。</p>
      <p class="help-modal-para">スケジュール情報は MetaForge を参照しています。ゲーム内や公式情報と異なる場合は、公式情報を優先してください。非公式のファンメイドツールであり、公式とは無関係です。</p>
    </div>
  `;
  modalEl.querySelector('[data-act="close"]').addEventListener('click', () => closeModal());
  backdrop.appendChild(modalEl);
  openModal(backdrop);
}

async function loadSchedule() {
  loading = true;
  loadError = '';
  render();
  try {
    const [weekly, s] = await Promise.all([
      fetchWeeklyTrials(),
      fetchScheduleSlots(selectedRegions),
    ]);
    trialsCurrent = weekly.current;
    trialsNext = weekly.next;
    slots = s;
    const icons = {};
    for (const slot of s) {
      if (slot.event && slot.icon && !icons[slot.event]) icons[slot.event] = slot.icon;
    }
    eventIconByJa = icons;
  } catch (e) {
    loadError = String(e.message || e);
    trialsCurrent = [];
    trialsNext = [];
    slots = [];
  } finally {
    loading = false;
    refreshUi();
  }
}

function setWeekMode(mode) {
  weekMode = mode === 'next' ? 'next' : 'current';
  try {
    localStorage.setItem(WEEK_MODE_KEY, weekMode);
  } catch {
    /* ignore */
  }
  render();
}

function refreshUi() {
  // モーダル表示中に丸ごと描画し直すと入力や横スクロール位置が消える
  if (modal) {
    if (partySortieId && !state.sorties.some((s) => s.id === partySortieId)) {
      closeModal();
      render();
    }
    return;
  }
  const keepParty = partySortieId;
  render();
  if (keepParty && state.sorties.some((s) => s.id === keepParty)) {
    openPartyModal(keepParty);
  }
}

/** 横レールを壊さず、指定トライアルのカードだけ差し替える */
function refreshTrialCardInRail(trialId, scrollLeft) {
  const rail = app.querySelector('.trial-rail');
  if (!rail) {
    render({ keepRailScroll: scrollLeft });
    return false;
  }
  const keep = Number.isFinite(scrollLeft) ? scrollLeft : trialRailScrollLeft;
  const trial = visibleTrials().find((t) => String(t.id) === String(trialId));
  const old = rail.querySelector(`[data-trial-id="${CSS.escape(String(trialId))}"]`);
  if (!trial || !old) {
    render({ keepRailScroll: keep });
    return false;
  }
  const oldList = old.querySelector('.mp-time-list');
  if (oldList) trialSchedScrollTop.set(String(trialId), oldList.scrollTop);
  const keepSchedTop = trialSchedScrollTop.get(String(trialId)) || 0;
  // 差し替え中に scroll-snap が先頭へ吸着しないようにする
  const prevSnap = rail.style.scrollSnapType;
  rail.style.scrollSnapType = 'none';
  const next = renderTrialCard(trial);
  old.replaceWith(next);
  const nextList = next.querySelector('.mp-time-list');
  const restore = () => {
    rail.scrollLeft = keep;
    trialRailScrollLeft = keep;
    if (nextList && keepSchedTop > 0) nextList.scrollTop = keepSchedTop;
  };
  restore();
  requestAnimationFrame(() => {
    restore();
    requestAnimationFrame(() => {
      restore();
      // snap は戻さず維持（戻すと iOS で先頭カードへ飛ぶことがある）
      if (prevSnap && prevSnap !== 'none') {
        // 位置確定後にだけ復帰
        setTimeout(() => {
          restore();
          rail.style.scrollSnapType = prevSnap;
        }, 50);
      }
    });
  });
  if (nextList) {
    nextList.addEventListener(
      'scroll',
      () => {
        if (modal) return;
        trialSchedScrollTop.set(String(trialId), nextList.scrollTop);
      },
      { passive: true }
    );
  }
  return true;
}

/** 出撃メンバーモーダルが開いていれば中身だけ描き直し（入力欄を潰さない） */
function repaintPartyModal(opts = {}) {
  if (!modal || !partySortieId) return false;
  if (typeof openPartyModal._repaint !== 'function') return false;
  if (!state.sorties.some((s) => s.id === partySortieId)) {
    closeModal();
    return true;
  }
  openPartyModal._repaint(opts);
  return true;
}

function removeSortieMember(sortieId, memberId) {
  const sortie = state.sorties.find((s) => s.id === sortieId);
  if (!sortie || !memberId) return;
  removeMemberFromParties(sortie, memberId);
  persist({ skipSync: true, sortieId });
  if (!repaintPartyModal({ light: true })) {
    render();
    openPartyModal(sortieId);
  }
}

function placeSortieMember(sortieId, memberId, partyIndex, { toggleIfSame = true } = {}) {
  const sortie = state.sorties.find((s) => s.id === sortieId);
  if (!sortie || !memberId) return;
  ensureParties(sortie);
  const size = partySizeOf(sortie);
  const current = findMemberPartyIndex(sortie, memberId);
  if (current === partyIndex) {
    if (toggleIfSame) {
      removeMemberFromParties(sortie, memberId);
      persist({ skipSync: true, sortieId });
      if (!repaintPartyModal({ light: true })) {
        render();
        openPartyModal(sortieId);
      }
    }
    return;
  }
  const target = ensureParties(sortie)[partyIndex];
  if (target && target.length >= size && current !== partyIndex) {
    showToast(`パーティ${partyIndex + 1}は満員です（最大${size}人・${partySizeLabel(size)}）`);
    return;
  }
  const res = addMemberToParty(sortie, memberId, partyIndex);
  if (!res.ok) {
    showToast(`パーティ${partyIndex + 1}は満員です（最大${size}人・${partySizeLabel(size)}）`);
    return;
  }
  persist({ skipSync: true, sortieId });
  if (!repaintPartyModal({ light: true })) {
    render();
    openPartyModal(sortieId);
  }
}

const MEMBER_DRAG_TYPE = 'application/x-sortie-member';

function openPartyModal(sortieId) {
  const sortie = state.sorties.find((s) => s.id === sortieId);
  if (!sortie) {
    partySortieId = null;
    return;
  }
  partySortieId = sortieId;
  ensureParties(sortie);

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeModal();
  });

  const startMs = new Date(sortie.startAt).getTime();
  const endMs = new Date(sortie.endAt).getTime();
  const remain = remainText(
    Number.isFinite(startMs) ? startMs : 0,
    Number.isFinite(endMs) ? endMs : 0
  );
  const { start, end } = Number.isFinite(startMs)
    ? fmtSlotRange(startMs, Number.isFinite(endMs) ? endMs : startMs + 3600000)
    : { start: '—', end: '—' };

  const modalEl = document.createElement('div');
  modalEl.className = 'modal modal-party';
  const initialSize = partySizeOf(sortie);
  modalEl.innerHTML = `
    <div class="party-modal-head">
      <h3>レイドメンバー</h3>
      <button type="button" class="btn modal-close" data-act="close">閉じる</button>
    </div>
    <div class="party-summary">
      <div class="party-summary-title">${esc(sortie.objective || '（内容未設定）')}</div>
      <div class="party-summary-meta" data-meta></div>
      <div class="timing-tag-picker" data-timing-tags></div>
      <div class="party-size-row">
        <span class="party-size-row-label">編成</span>
        <div class="seg party-size-seg" role="group" aria-label="編成人数" data-party-size-seg>
          ${PARTY_SIZE_OPTIONS.map(
            (o) =>
              `<button type="button" class="seg-btn${o.size === initialSize ? ' is-on' : ''}" data-party-size="${o.size}">${o.label}</button>`
          ).join('')}
        </div>
      </div>
    </div>
    <p class="hint party-howto" data-party-howto></p>
    <div class="party-modal-grid">
      <section class="party-pane">
        <div class="party-pane-head">
          <div class="party-pane-label">パーティ</div>
          <button type="button" class="btn party-add-btn" data-add-party>+ 追加</button>
        </div>
        <div class="party-list party-list--modal" data-party></div>
      </section>
      <section class="party-pane">
        <div class="party-pane-head">
          <div class="party-pane-label">メンバー名簿</div>
        </div>
        <div class="member-add-row">
          <input data-name placeholder="名前を追加" />
          <button type="button" class="btn" data-add>追加</button>
        </div>
        <div class="member-pick-list" data-members></div>
      </section>
    </div>
    <div class="modal-actions party-modal-actions">
      <button type="button" class="btn btn-primary" data-act="copy">Discord用コピー</button>
      <button type="button" class="btn btn-danger btn-danger-strong" data-act="remove">レイドを解除</button>
    </div>
    <div class="party-fill-sheet" data-fill-sheet hidden></div>
  `;

  const meta = modalEl.querySelector('[data-meta]');
  if (sortie.regionSlug) meta.appendChild(createSrvAbbr(sortie.regionSlug));
  const time = document.createElement('span');
  time.className = 'party-summary-time';
  time.textContent = `${start} - ${end}  ${Number.isFinite(startMs) ? fmtDateWeekJa(startMs) : ''}  ${remain.text}`;
  meta.appendChild(time);
  if (sortie.event) {
    const ev = document.createElement('span');
    ev.className = 'tag';
    ev.textContent = sortie.event;
    meta.appendChild(ev);
  }
  if (sortie.map) {
    const map = document.createElement('span');
    map.className = 'tag';
    map.textContent = sortie.map;
    meta.appendChild(map);
  }

  const getSortie = () => state.sorties.find((s) => s.id === sortieId) || sortie;

  const paintPartyHowto = () => {
    const how = modalEl.querySelector('[data-party-howto]');
    if (!how) return;
    const size = partySizeOf(getSortie());
    how.textContent = `パーティをタップしてメンバーを選びます（${partySizeLabel(size)}・各${size}人）。名簿はアイコン＝画像、名前変更／×＝名簿の編集。PCはドラッグでも移動できます。`;
  };

  const paintPartySizeSeg = () => {
    const size = partySizeOf(getSortie());
    modalEl.querySelectorAll('[data-party-size]').forEach((btn) => {
      const n = Number(btn.getAttribute('data-party-size'));
      btn.classList.toggle('is-on', n === size);
    });
  };

  paintTimingTagPicker(modalEl.querySelector('[data-timing-tags]'), getSortie());
  paintPartyHowto();
  paintPartySizeSeg();
  modalEl.querySelectorAll('[data-party-size]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const next = Number(btn.getAttribute('data-party-size'));
      if (next !== 2 && next !== 3) return;
      const live = getSortie();
      if (!live) return;
      if (partySizeOf(live) === next) return;
      const { trimmed } = setSortiePartySize(live, next);
      // 先にローカル反映を確定し、同期は後追い（古いAPIに消されないよう apply 側でも保護）
      persist({ sortieId });
      paintPartySizeSeg();
      paintPartyHowto();
      if (fillPartyIndex != null) {
        const size = partySizeOf(live);
        if (fillSelected.size > size) {
          fillSelected = new Set([...fillSelected].slice(0, size));
        }
        paintFillSheet();
      }
      paintParties();
      updateMemberMarks();
      if (trimmed) showToast(`編成を${partySizeLabel(next)}に変更（${trimmed}人を外しました）`);
      else showToast(`編成を${partySizeLabel(next)}に変更しました`);
    });
  });
  const fillSheet = modalEl.querySelector('[data-fill-sheet]');
  let fillPartyIndex = null;
  /** @type {Set<string>} パーティ編集シート上の選択中メンバー */
  let fillSelected = new Set();

  const closeFillSheet = () => {
    const wasOpen = fillPartyIndex != null;
    fillPartyIndex = null;
    fillSelected = new Set();
    fillSheet.hidden = true;
    fillSheet.replaceChildren();
    // モーダル中は末尾の空枠（+ 追加）を残し、途中の空だけ詰める
    if (wasOpen) {
      compactEmptyParties(getSortie(), { keepTrailingEmpty: true });
      persist({ skipSync: true, sortieId });
      paintParties();
      updateMemberMarks();
    }
  };

  const bindMemberDrag = (el, memberId) => {
    el.draggable = true;
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData(MEMBER_DRAG_TYPE, memberId);
      e.dataTransfer.setData('text/plain', memberId);
      e.dataTransfer.effectAllowed = 'move';
      el.classList.add('is-dragging');
    });
    el.addEventListener('dragend', () => el.classList.remove('is-dragging'));
  };

  const bindPartyDrop = (el, partyIndex) => {
    el.addEventListener('dragover', (e) => {
      const types = [...e.dataTransfer.types];
      if (!types.includes(MEMBER_DRAG_TYPE) && !types.includes('text/plain')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      el.classList.add('is-drop');
    });
    el.addEventListener('dragleave', () => el.classList.remove('is-drop'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('is-drop');
      const id =
        e.dataTransfer.getData(MEMBER_DRAG_TYPE) || e.dataTransfer.getData('text/plain');
      if (!id) return;
      placeSortieMember(sortieId, id, partyIndex, { toggleIfSame: false });
    });
  };

  const applyFillSelection = () => {
    if (fillPartyIndex == null) return;
    const gi = fillPartyIndex;
    const count = Math.min(fillSelected.size, partySizeOf(getSortie()));
    const live = getSortie();
    setPartyMembers(live, gi, [...fillSelected]);
    persist({ sortieId });
    closeFillSheet();
    if (!repaintPartyModal()) {
      render();
      openPartyModal(sortieId);
    }
    showToast(`パーティ${gi + 1}を更新しました（${count}/${partySizeOf(getSortie())}）`);
  };

  const paintFillSheet = () => {
    if (fillPartyIndex == null) return;
    const live = getSortie();
    ensureParties(live);
    if (fillPartyIndex < 0 || fillPartyIndex >= live.parties.length) {
      closeFillSheet();
      return;
    }
    const gi = fillPartyIndex;
    const selectedCount = fillSelected.size;
    fillSheet.hidden = false;
    fillSheet.replaceChildren();

    const head = document.createElement('div');
    head.className = 'party-fill-head';
    head.innerHTML = `
      <div>
        <div class="party-fill-title">パーティ ${gi + 1}</div>
        <div class="hint">最大${partySizeOf(getSortie())}人まで選んで確定（${selectedCount}/${partySizeOf(getSortie())}）</div>
      </div>
      <button type="button" class="btn modal-close" data-fill-close>戻る</button>
    `;
    head.querySelector('[data-fill-close]').addEventListener('click', closeFillSheet);

    const addRow = document.createElement('div');
    addRow.className = 'member-add-row';
    addRow.innerHTML = `
      <input data-fill-name placeholder="名前を追加" />
      <button type="button" class="btn" data-fill-add>追加</button>
    `;
    const fillName = addRow.querySelector('[data-fill-name]');
    const doFillAdd = () => {
      const member = createMember({ name: fillName.value });
      if (!member) return showToast('名前を入れてください');
      state.members.push(member);
      persist();
      if (fillSelected.size < partySizeOf(getSortie())) fillSelected.add(member.id);
      else showToast(`選択は最大${partySizeOf(getSortie())}人です（名簿には追加済み）`);
      fillName.value = '';
      paintFillSheet();
      fillSheet.querySelector('[data-fill-name]')?.focus();
    };
    addRow.querySelector('[data-fill-add]').addEventListener('click', doFillAdd);
    fillName.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doFillAdd();
    });

    const list = document.createElement('div');
    list.className = 'party-fill-list';
    const sorted = [...state.members].sort((a, b) => a.name.localeCompare(b.name, 'ja'));
    if (!sorted.length) {
      list.innerHTML = '<p class="hint">名簿が空です。上で名前を追加してください。</p>';
    } else {
      for (const m of sorted) {
        const partyIdx = findMemberPartyIndex(live, m.id);
        const selected = fillSelected.has(m.id);
        const full = !selected && fillSelected.size >= partySizeOf(getSortie());
        const row = document.createElement('button');
        row.type = 'button';
        row.className = `member-pick${selected ? ' is-on' : ''}${full ? ' is-disabled' : ''}`;
        row.disabled = full;
        const check = document.createElement('span');
        check.className = `pick-check${selected ? ' is-on' : ''}`;
        check.setAttribute('aria-hidden', 'true');
        check.textContent = selected ? '✓' : '';
        row.appendChild(check);
        row.appendChild(avatarNode(m));
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = m.name;
        const mark = document.createElement('span');
        mark.className = 'pick-mark';
        if (selected) mark.textContent = '選択中';
        else if (partyIdx >= 0 && partyIdx !== gi) mark.textContent = `P${partyIdx + 1}から`;
        else if (full) mark.textContent = '上限';
        else mark.textContent = '選択';
        row.append(name, mark);
        row.addEventListener('click', () => {
          if (selected) {
            fillSelected.delete(m.id);
          } else {
            if (fillSelected.size >= partySizeOf(getSortie())) {
              showToast(`最大${partySizeOf(getSortie())}人までです`);
              return;
            }
            fillSelected.add(m.id);
          }
          paintFillSheet();
        });
        list.appendChild(row);
      }
    }

    const actions = document.createElement('div');
    actions.className = 'party-fill-actions';
    actions.innerHTML = `
      <button type="button" class="btn" data-fill-clear>選択クリア</button>
      <button type="button" class="btn btn-primary" data-fill-apply>確定（${selectedCount}/${partySizeOf(getSortie())}）</button>
    `;
    actions.querySelector('[data-fill-clear]').addEventListener('click', () => {
      fillSelected = new Set();
      paintFillSheet();
    });
    actions.querySelector('[data-fill-apply]').addEventListener('click', applyFillSelection);

    fillSheet.append(head, addRow, list, actions);
  };

  const openFillSheet = (partyIndex) => {
    fillPartyIndex = partyIndex;
    const live = getSortie();
    ensureParties(live);
    const size = partySizeOf(live);
    fillSelected = new Set((live.parties[partyIndex] || []).slice(0, size));
    paintFillSheet();
  };

  const paintParties = () => {
    const live = getSortie();
    ensureParties(live);
    const size = partySizeOf(live);
    const partyEl = modalEl.querySelector('[data-party]');
    partyEl.replaceChildren();
    const groups = partyMemberLists(live);
    groups.forEach((group, gi) => {
      const open = size - group.length;
      const block = document.createElement('div');
      block.className = 'party-group';
      block.tabIndex = 0;
      block.setAttribute('role', 'button');
      block.setAttribute(
        'aria-label',
        `パーティ${gi + 1}のメンバーを編集（${group.length}/${size}・${partySizeLabel(size)}）`
      );
      bindPartyDrop(block, gi);

      const head = document.createElement('div');
      head.className = 'party-group-head';
      const openLabel = open > 0 ? ` · 空き${open}` : '';
      head.innerHTML = `<span>パーティ ${gi + 1}<span class="party-group-size">${partySizeLabel(size)}</span></span><span class="party-group-count">${group.length}/${size}${openLabel}</span>`;
      block.appendChild(head);

      const chips = document.createElement('div');
      chips.className = 'party-group-chips';
      if (!group.length) {
        const empty = document.createElement('div');
        empty.className = 'party-empty';
        empty.textContent = `タップして募集（${partySizeLabel(size)}）`;
        chips.appendChild(empty);
      } else {
        for (const m of group) {
          const chip = document.createElement('div');
          chip.className = 'party-chip';
          chip.appendChild(avatarNode(m));
          const name = document.createElement('span');
          name.textContent = m.name;
          const rm = document.createElement('button');
          rm.type = 'button';
          rm.className = 'party-chip-remove';
          rm.setAttribute('aria-label', `${m.name}を外す`);
          rm.textContent = '×';
          rm.addEventListener('click', (e) => {
            e.stopPropagation();
            removeSortieMember(sortieId, m.id);
          });
          chip.append(name, rm);
          bindMemberDrag(chip, m.id);
          chip.addEventListener('click', (e) => {
            if (e.target === rm || rm.contains(e.target)) return;
            e.stopPropagation();
            openFillSheet(gi);
          });
          chips.appendChild(chip);
        }
        if (open > 0) {
          const vac = document.createElement('div');
          vac.className = 'party-empty party-empty--slot';
          vac.textContent = `空き ${open}`;
          chips.appendChild(vac);
        }
      }
      block.appendChild(chips);

      block.addEventListener('click', () => openFillSheet(gi));
      block.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openFillSheet(gi);
        }
      });
      partyEl.appendChild(block);
    });
  };

  const paintMembers = () => {
    const live = getSortie();
    const membersEl = modalEl.querySelector('[data-members]');
    membersEl.replaceChildren();
    const sorted = [...state.members].sort((a, b) => a.name.localeCompare(b.name, 'ja'));
    if (!sorted.length) {
      membersEl.innerHTML = '<p class="hint">名簿が空です。上で追加するか、パーティから追加してください。</p>';
      return;
    }
    for (const m of sorted) {
      const partyIdx = findMemberPartyIndex(live, m.id);
      const row = document.createElement('div');
      row.dataset.memberId = m.id;
      row.className = `member-pick${partyIdx >= 0 ? ' is-on' : ''}`;

      const avWrap = document.createElement('button');
      avWrap.type = 'button';
      avWrap.className = 'member-pick-avatar';
      avWrap.title = 'アイコンを変更';
      avWrap.setAttribute('aria-label', `${m.name}のアイコンを変更`);
      avWrap.appendChild(avatarNode(m));
      avWrap.addEventListener('click', async (e) => {
        e.stopPropagation();
        await editMemberAvatarFromRoster(m.id);
        if (!repaintPartyModal()) {
          render();
          openPartyModal(sortieId);
        }
      });

      const main = document.createElement('button');
      main.type = 'button';
      main.className = 'member-pick-main';
      main.title = partyIdx >= 0 ? 'タップでこのレイドから外す' : '追加したいパーティをタップしてください';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = m.name;
      const mark = document.createElement('span');
      mark.className = `pick-mark${partyIdx >= 0 ? ' is-placed' : ''}`;
      mark.textContent = partyIdx >= 0 ? `P${partyIdx + 1}` : '未配置';
      main.append(name, mark);
      main.addEventListener('click', () => {
        if (partyIdx >= 0) {
          removeSortieMember(sortieId, m.id);
          return;
        }
        showToast('追加したいパーティをタップしてください');
      });

      const more = document.createElement('div');
      more.className = 'member-pick-more';
      const rename = document.createElement('button');
      rename.type = 'button';
      rename.className = 'member-pick-icon-btn';
      rename.setAttribute('aria-label', `${m.name}の名前を変更`);
      rename.title = '名前を変更';
      rename.textContent = '名前変更';
      rename.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!(await renameMemberFromRoster(m.id))) return;
        if (!repaintPartyModal()) {
          render();
          openPartyModal(sortieId);
        }
      });
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'member-pick-icon-btn is-danger';
      del.setAttribute('aria-label', `${m.name}を名簿から削除`);
      del.title = '名簿から削除';
      del.textContent = '×';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!(await deleteMemberFromRoster(m.id))) return;
        if (!repaintPartyModal()) {
          render();
          openPartyModal(sortieId);
        }
        showToast(`${m.name} を名簿から削除しました`);
      });
      more.append(rename, del);

      row.append(avWrap, main, more);
      bindMemberDrag(row, m.id);
      membersEl.appendChild(row);
    }
  };

  /** メンバー行は残して印だけ更新（入れ替え連打を軽くする） */
  const updateMemberMarks = () => {
    const live = getSortie();
    const membersEl = modalEl.querySelector('[data-members]');
    const rows = membersEl.querySelectorAll('[data-member-id]');
    if (!rows.length) {
      paintMembers();
      return;
    }
    for (const row of rows) {
      const id = row.getAttribute('data-member-id');
      const partyIdx = findMemberPartyIndex(live, id);
      row.className = `member-pick${partyIdx >= 0 ? ' is-on' : ''}`;
      const mark = row.querySelector('.pick-mark');
      if (mark) {
        mark.textContent = partyIdx >= 0 ? `P${partyIdx + 1}` : '未配置';
        mark.classList.toggle('is-placed', partyIdx >= 0);
      }
      const main = row.querySelector('.member-pick-main');
      if (main) {
        main.title = partyIdx >= 0 ? 'タップでこのレイドから外す' : '追加したいパーティをタップしてください';
      }
    }
  };

  paintParties();
  paintMembers();
  if (openPartyModal._pendingFill != null) {
    const pending = openPartyModal._pendingFill;
    openPartyModal._pendingFill = null;
    openFillSheet(pending);
  }

  openPartyModal._repaint = (opts = {}) => {
    if (!getSortie()) {
      closeModal();
      return;
    }
    paintPartySizeSeg();
    paintPartyHowto();
    paintParties();
    if (opts.light) updateMemberMarks();
    else paintMembers();
    if (fillPartyIndex != null) paintFillSheet();
  };

  const nameInput = modalEl.querySelector('[data-name]');
  const focusNameInput = () => {
    modal?.querySelector?.('[data-name]')?.focus();
  };
  const doAdd = () => {
    const member = createMember({ name: nameInput.value });
    if (!member) return showToast('名前を入れてください');
    state.members.push(member);
    nameInput.value = '';
    persist();
    if (!repaintPartyModal()) {
      render();
      openPartyModal(sortieId);
    }
    showToast(`${member.name} を名簿に追加しました`);
    queueMicrotask(focusNameInput);
  };
  modalEl.querySelector('[data-add]').addEventListener('click', doAdd);
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doAdd();
  });

  modalEl.querySelector('[data-add-party]').addEventListener('click', () => {
    const live = getSortie();
    const before = ensureParties(live).length;
    const res = addEmptyParty(live);
    persist({ skipSync: true, sortieId });
    if (!repaintPartyModal()) {
      openPartyModal(sortieId);
      return;
    }
    openFillSheet(res.partyIndex);
    if (ensureParties(getSortie()).length > before) {
      showToast(`パーティ${res.partyIndex + 1}を追加しました`);
    }
  });

  modalEl.querySelector('[data-act="close"]').addEventListener('click', () => closeModal());
  modalEl.querySelector('[data-act="copy"]').addEventListener('click', () => {
    copyText(discordCopyText(getSortie()));
  });
  modalEl.querySelector('[data-act="remove"]').addEventListener('click', () => {
    removeSortieById(sortieId);
  });

  backdrop.appendChild(modalEl);
  openModal(backdrop);
}

function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function getTrialPrefs(trialId) {
  const p = state.trialPrefs?.[trialId];
  return {
    maps: Array.isArray(p?.maps) ? [...p.maps] : [],
    events: Array.isArray(p?.events) ? [...p.events] : [],
  };
}

function prefsAxisIsAll(arr) {
  return Array.isArray(arr) && arr.length === 1 && arr[0] === 'all';
}

function prefsAxisMeansAll(arr) {
  if (!arr || !arr.length) return true;
  return prefsAxisIsAll(arr);
}

function prefsIsUnset(prefs) {
  return !prefs.maps.length && !prefs.events.length;
}

function formatTrialPrefsMetaLine(prefs) {
  if (prefsIsUnset(prefs)) return 'マップ・イベント未設定（カードをタップ）';
  const mapsAll = prefsAxisMeansAll(prefs.maps);
  const evAll = prefsAxisMeansAll(prefs.events);
  if (mapsAll && evAll) return 'すべてのマップ / すべてのイベント';
  if (!mapsAll && !evAll) {
    return `${prefs.maps.join('・')} / ${prefs.events.join('・')}`;
  }
  if (!mapsAll) return `${prefs.maps.join('・')} / すべてのイベント`;
  return `すべてのマップ / ${prefs.events.join('・')}`;
}

function prefsToSelSets(prefs) {
  const maps = new Set();
  const events = new Set();
  if (prefsIsUnset(prefs)) return { maps, events };
  if (!prefs.maps.length || prefsAxisIsAll(prefs.maps)) maps.add('all');
  else prefs.maps.forEach((m) => { if (m !== 'all') maps.add(m); });
  if (!prefs.events.length || prefsAxisIsAll(prefs.events)) events.add('all');
  else prefs.events.forEach((e) => { if (e !== 'all') events.add(e); });
  return { maps, events };
}

function selSetsToPrefs(selMaps, selEvents, mapKeys, eventKeys) {
  const mapsUnset = !selMaps.size;
  const evUnset = !selEvents.size;
  if (mapsUnset && evUnset) return { maps: [], events: [] };
  const mapsAll = mapsUnset || isChipAllSelected(selMaps, mapKeys);
  const evAll = evUnset || isChipAllSelected(selEvents, eventKeys);
  if (mapsAll && evAll) return { maps: ['all'], events: ['all'] };
  return {
    maps: mapsAll ? [] : [...selMaps].filter((k) => k !== 'all'),
    events: evAll ? [] : [...selEvents].filter((k) => k !== 'all'),
  };
}

function isChipAllSelected(selSet, allKeys) {
  if (!selSet || !selSet.size) return false;
  if (selSet.has('all')) return true;
  return allKeys.length > 0 && allKeys.every((k) => selSet.has(k));
}

function chipOptionSelected(selSet, key, allKeys) {
  if (key === 'all') return isChipAllSelected(selSet, allKeys);
  if (selSet && selSet.has('all')) return false;
  return !!(selSet && selSet.has(key));
}

function compactChipSet(selSet, allKeys) {
  if (!selSet.size) return new Set(['all']);
  if (allKeys.length && allKeys.every((k) => selSet.has(k))) return new Set(['all']);
  return selSet;
}

function toggleChipSelection(selSet, key, allKeys) {
  if (key === 'all') return new Set(['all']);
  const next = new Set([...(selSet || [])].filter((k) => k !== 'all'));
  if (next.has(key)) next.delete(key);
  else next.add(key);
  if (!next.size) return new Set(['all']);
  return compactChipSet(next, allKeys);
}

function availableMapsForTrial(trial) {
  const base = MAP_OPTIONS.slice();
  const seen = new Set(base);
  for (const raw of [...(trial.mapNames || []), ...slots.map((s) => s.map)]) {
    const m = mapJa(raw);
    if (!m || seen.has(m)) continue;
    seen.add(m);
    // 既知マップ以外だけ末尾に追加（通常は mapJa で吸収される）
    if (!MAP_OPTIONS.includes(m)) base.push(m);
  }
  return base;
}

function availableEventsForTrial() {
  const seen = new Set(EVENT_OPTIONS);
  const ordered = EVENT_OPTIONS.slice();
  for (const s of slots) {
    if (s.event && !seen.has(s.event)) {
      seen.add(s.event);
      ordered.push(s.event);
    }
  }
  return ordered;
}

function getEventIconUrl(jaName) {
  const key = String(jaName || '').trim();
  if (!key) return null;
  if (eventIconByJa[key]) return eventIconByJa[key];
  const legacy =
    key === '寒波' ? 'コールドスナップ' : key === '収穫の季節' ? '豊かな開花' : '';
  return legacy && eventIconByJa[legacy] ? eventIconByJa[legacy] : null;
}

function iconSvg(kind) {
  const base =
    'width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"';
  switch (kind) {
    case 'major':
      return `<svg ${base}><path d="M7.2 3.6 16.8 3.6 21.6 12 16.8 20.4 7.2 20.4 2.4 12 7.2 3.6Z" stroke="currentColor" stroke-width="2"/><path d="M12 8.2v6.1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M12 16.9h.01" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>`;
    case 'minor':
      return `<svg ${base}><circle cx="12" cy="12" r="7" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="2.2" fill="currentColor"/></svg>`;
    case 'act':
      return `<svg ${base}><path d="M13 2 4 14h7l-1 8 10-14h-7l0-6Z" fill="currentColor"/></svg>`;
    case 'more':
      return `<svg ${base} aria-hidden="true"><circle cx="12" cy="5" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="19" r="1.6" fill="currentColor"/></svg>`;
    case 'edit':
      return `<svg ${base} aria-hidden="true"><path d="M4 20h4l10.5-10.5-4-4L4 16v4Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="m13.5 5.5 4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;
    case 'trash':
      return `<svg ${base} aria-hidden="true"><path d="M5 7h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M9 7V5h6v2" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M8 7l1 12h6l1-12" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>`;
    case 'all':
    default:
      return `<svg ${base}><circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="2"/><path d="M12 7v10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M7 12h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
  }
}

function closeAllSortieMenus(except = null) {
  document.querySelectorAll('.sortie-row-menu').forEach((menu) => {
    if (except && menu === except) return;
    const toggle = menu.querySelector('.sortie-row-menu-toggle');
    const panel = menu.querySelector('.sortie-row-menu-panel');
    if (toggle) toggle.setAttribute('aria-expanded', 'false');
    if (panel) panel.hidden = true;
  });
}

function renderSortieRowMenu(sortie) {
  const menu = document.createElement('div');
  menu.className = 'sortie-row-menu';

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'sortie-row-menu-toggle';
  toggle.setAttribute('aria-haspopup', 'menu');
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-label', '操作メニュー');
  toggle.title = '操作';
  toggle.innerHTML = iconSvg('more');

  const panel = document.createElement('div');
  panel.className = 'sortie-row-menu-panel';
  panel.setAttribute('role', 'menu');
  panel.hidden = true;

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'sortie-row-menu-item';
  editBtn.setAttribute('role', 'menuitem');
  editBtn.innerHTML = `${iconSvg('edit')}<span>編集</span>`;
  editBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeAllSortieMenus();
    openPartyModal(sortie.id);
  });

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'sortie-row-menu-item is-danger';
  removeBtn.setAttribute('role', 'menuitem');
  removeBtn.innerHTML = `${iconSvg('trash')}<span>解除</span>`;
  removeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeAllSortieMenus();
    removeSortieById(sortie.id);
  });

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = panel.hidden;
    closeAllSortieMenus(menu);
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  panel.append(editBtn, removeBtn);
  menu.append(toggle, panel);
  return menu;
}

function renderLoadingSkeleton(kind) {
  const wrap = document.createElement('div');
  wrap.className = 'ui-skeleton-wrap';
  wrap.setAttribute('aria-busy', 'true');
  wrap.setAttribute('aria-label', '読み込み中');

  if (kind === 'rail') {
    const rail = document.createElement('div');
    rail.className = 'ui-skeleton-rail';
    for (let i = 0; i < 3; i++) {
      const card = document.createElement('div');
      card.className = 'ui-skeleton ui-skeleton-card';
      rail.appendChild(card);
    }
    wrap.appendChild(rail);
    return wrap;
  }

  for (let d = 0; d < 2; d++) {
    const day = document.createElement('div');
    day.className = 'ui-skeleton ui-skeleton-day';
    wrap.appendChild(day);
    for (let r = 0; r < 3; r++) {
      const row = document.createElement('div');
      row.className = 'ui-skeleton ui-skeleton-row';
      wrap.appendChild(row);
    }
  }
  return wrap;
}

function appendEventIcon(host, label, kind) {
  const ico = document.createElement('span');
  const iconUrl = kind !== 'all' ? getEventIconUrl(label) : null;
  if (iconUrl) {
    ico.className = 'ev-ico img';
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.alt = '';
    img.src = iconUrl;
    img.onerror = () => {
      ico.className = `ev-ico ${kind || ''}`.trim();
      ico.innerHTML = iconSvg(kind);
    };
    ico.appendChild(img);
  } else {
    ico.className = `ev-ico ${kind || ''}`.trim();
    ico.innerHTML = iconSvg(kind);
  }
  host.appendChild(ico);
}

function setEventNameWithIcon(el, label, kind) {
  el.replaceChildren();
  appendEventIcon(el, label, kind);
  const txt = document.createElement('span');
  txt.textContent = label;
  el.appendChild(txt);
}

function slotMatchesTrialPrefs(slot, prefs) {
  if (prefsIsUnset(prefs)) return false;
  const mapOk = prefsAxisMeansAll(prefs.maps) || prefs.maps.includes(slot.map);
  const evOk = prefsAxisMeansAll(prefs.events) || prefs.events.includes(slot.event);
  return mapOk && evOk;
}

function saveTrialPrefs(trialId, mapsSet, eventsSet, mapKeys, eventKeys) {
  if (!state.trialPrefs) state.trialPrefs = {};
  const payload = selSetsToPrefs(mapsSet, eventsSet, mapKeys, eventKeys);
  if (!payload.maps.length && !payload.events.length) {
    delete state.trialPrefs[trialId];
  } else {
    state.trialPrefs[trialId] = payload;
  }
  persist();
}

function openTrialPrefsModal(trial) {
  const rail = app.querySelector('.trial-rail');
  // モーダル表示中に iOS が背面 scrollLeft を 0 にすることがあるので、開いた瞬間の値を固定保持する
  const savedRailScroll = rail ? rail.scrollLeft : trialRailScrollLeft;
  trialRailScrollLeft = savedRailScroll;

  const prefs = getTrialPrefs(trial.id);
  const initial = prefsToSelSets(prefs);
  let selMaps = initial.maps;
  let selEvents = initial.events;
  const mapKeys = availableMapsForTrial(trial);
  const eventKeys = availableEventsForTrial();

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const finish = () => {
    saveTrialPrefs(trial.id, selMaps, selEvents, mapKeys, eventKeys);
    closeModal();
    // レール全体を作り直すと横スクロールが飛ぶので、該当カードだけ差し替える
    refreshTrialCardInRail(trial.id, savedRailScroll);
  };

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) finish();
  });

  const modalEl = document.createElement('div');
  modalEl.className = 'modal modal-trial-prefs';
  modalEl.innerHTML = `
    <div class="party-modal-head">
      <h3>マップ・イベント</h3>
      <button type="button" class="btn modal-close" data-act="close">閉じる</button>
    </div>
    <div class="trial-prefs-hero">
      ${
        trial.imageUrl
          ? `<img src="${esc(trial.imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
          : ''
      }
      <div class="trial-prefs-hero-title">${esc(trial.nameJa || trial.name)}</div>
    </div>
    <p class="hint trial-prefs-hint">選択するとすぐ反映されます。両方とも未選択にすると枠は出ません。</p>
    <div class="chip-section">
      <div class="chip-section-title">マップ</div>
      <div class="ev-map-picker" data-maps></div>
    </div>
    <div class="chip-section">
      <div class="chip-section-title">イベント</div>
      <div class="ev-picker" data-events></div>
    </div>
    <div class="modal-actions">
      <button type="button" class="btn btn-primary" data-act="close-save">保存して閉じる</button>
      <button type="button" class="btn" data-act="reset">リセット</button>
    </div>
  `;

  const mapsHost = modalEl.querySelector('[data-maps]');
  const eventsHost = modalEl.querySelector('[data-events]');

  const apply = () => {
    saveTrialPrefs(trial.id, selMaps, selEvents, mapKeys, eventKeys);
    paint();
    // 背面は閉じるときにまとめて更新（毎回 render すると操作感が戻される）
  };

  const paint = () => {
    mapsHost.replaceChildren();
    const allMap = document.createElement('button');
    allMap.type = 'button';
    allMap.className = `ev-map-btn pick-all${chipOptionSelected(selMaps, 'all', mapKeys) ? ' sel' : ''}`;
    allMap.textContent = 'すべて';
    allMap.addEventListener('click', () => {
      selMaps = toggleChipSelection(selMaps, 'all', mapKeys);
      apply();
    });
    mapsHost.appendChild(allMap);
    for (const key of mapKeys) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `ev-map-btn${chipOptionSelected(selMaps, key, mapKeys) ? ' sel' : ''}`;
      b.textContent = key;
      b.addEventListener('click', () => {
        selMaps = toggleChipSelection(selMaps, key, mapKeys);
        apply();
      });
      mapsHost.appendChild(b);
    }

    eventsHost.replaceChildren();
    const allEv = document.createElement('button');
    allEv.type = 'button';
    allEv.className = `ev-pick-btn pick-all${chipOptionSelected(selEvents, 'all', eventKeys) ? ' sel' : ''}`;
    appendEventIcon(allEv, '', 'all');
    const allLbl = document.createElement('span');
    allLbl.className = 'lbl';
    allLbl.textContent = 'すべて';
    allEv.appendChild(allLbl);
    allEv.addEventListener('click', () => {
      selEvents = toggleChipSelection(selEvents, 'all', eventKeys);
      apply();
    });
    eventsHost.appendChild(allEv);
    for (const key of eventKeys) {
      const t = eventType(key);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `ev-pick-btn pick-${t}${chipOptionSelected(selEvents, key, eventKeys) ? ' sel' : ''}`;
      appendEventIcon(b, key, t);
      const lbl = document.createElement('span');
      lbl.className = 'lbl';
      lbl.textContent = key;
      b.appendChild(lbl);
      b.addEventListener('click', () => {
        selEvents = toggleChipSelection(selEvents, key, eventKeys);
        apply();
      });
      eventsHost.appendChild(b);
    }
  };

  paint();

  modalEl.querySelector('[data-act="close"]').addEventListener('click', finish);
  modalEl.querySelector('[data-act="close-save"]').addEventListener('click', finish);
  modalEl.querySelector('[data-act="reset"]').addEventListener('click', () => {
    selMaps = new Set();
    selEvents = new Set();
    apply();
    showToast('マップ・イベントをリセットしました');
  });

  backdrop.appendChild(modalEl);
  openModal(backdrop);
}

function renderTrialCard(trial) {
  const card = document.createElement('article');
  card.className = 'trial-card';
  card.dataset.trialId = trial.id;
  const prefs = getTrialPrefs(trial.id);
  const unset = prefsIsUnset(prefs);

  const imgw = document.createElement('div');
  imgw.className = 'trial-card-imgwrap';
  if (trial.imageUrl) {
    const img = document.createElement('img');
    img.src = trial.imageUrl;
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    imgw.appendChild(img);
  } else {
    const ph = document.createElement('span');
    ph.style.cssText = 'font-family:var(--fmono);font-size:10px;color:var(--text3)';
    ph.textContent = 'NO IMG';
    imgw.appendChild(ph);
  }

  const body = document.createElement('div');
  body.className = 'trial-card-body';
  const title = document.createElement('div');
  title.className = 'trial-card-title';
  title.textContent = trial.nameJa || trial.name;
  const meta = document.createElement('div');
  meta.className = 'trial-card-meta';
  const metaText = document.createElement('span');
  metaText.className = 'trial-card-meta-text';
  metaText.textContent = formatTrialPrefsMetaLine(prefs);
  meta.appendChild(metaText);
  body.append(title, meta);

  const openPrefs = () => openTrialPrefsModal(trial);
  imgw.addEventListener('click', openPrefs);
  body.addEventListener('click', openPrefs);
  imgw.title = 'マップ・イベントを選ぶ';
  body.title = 'マップ・イベントを選ぶ';

  const sched = document.createElement('div');
  sched.className = 'trial-card-sched';
  sched.addEventListener('click', (e) => e.stopPropagation());

  if (unset) {
    const empty = document.createElement('div');
    empty.className = 'trial-slot-empty';
    const msg = document.createElement('p');
    msg.textContent = 'マップとイベントを選ぶと、予約できる時間枠が表示されます';
    const setup = document.createElement('button');
    setup.type = 'button';
    setup.className = 'btn btn-primary trial-setup-cta';
    setup.textContent = 'マップを設定';
    setup.addEventListener('click', openPrefs);
    empty.append(msg, setup);
    sched.appendChild(empty);
    card.append(imgw, body, sched);
    return card;
  }

  const list = document.createElement('div');
  list.className = 'mp-time-list';

  let visible = slots.filter((slot) => slotMatchesTrialPrefs(slot, prefs));
  if (schedFilter === 'registered') {
    visible = visible.filter((slot) => isRegisteredSlot(slot, trial.id));
  }

  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'trial-slot-empty';
    if (loading) {
      empty.classList.add('is-skeleton');
      for (let i = 0; i < 3; i++) {
        const sk = document.createElement('div');
        sk.className = 'ui-skeleton ui-skeleton-slot';
        empty.appendChild(sk);
      }
    } else {
      empty.textContent =
        schedFilter === 'registered'
          ? 'レイド登録がありません'
          : 'この条件では表示できる枠がありません';
    }
    sched.appendChild(empty);
  } else {
    for (const slot of visible.slice(0, 40)) {
      const remain = remainText(slot.startMs, slot.endMs);
      const sortie = findSortieForSlot(slot, trial.id);
      const registered = !!sortie;
      const { start, end } = fmtSlotRange(slot.startMs, slot.endMs);
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'mp-time-item';
      if (remain.kind === 'live') row.classList.add('is-live');
      if (registered) row.classList.add('is-registered');
      else row.classList.add('is-open');

      const row1 = document.createElement('div');
      row1.className = 'trial-sched-row1';
      const row1Main = document.createElement('div');
      row1Main.className = 'trial-sched-row1-main';
      const range = document.createElement('span');
      range.className = 'mp-time-range';
      range.innerHTML = `<span class="t-s">${esc(start)}</span><span class="t-dash">-</span><span class="t-e">${esc(end)}</span>`;
      const date = document.createElement('span');
      date.className = 't-date';
      date.textContent = fmtDateWeekJa(slot.startMs);
      row1Main.append(range, date);
      const cd = document.createElement('span');
      cd.className = 'trial-sched-cd';
      bindCountdownEl(cd, slot.startMs, slot.endMs, 'trial-sched-cd--live');
      row1.append(row1Main, cd);

      const row2 = document.createElement('div');
      row2.className = 'trial-sched-row2';
      row2.appendChild(createSrvAbbr(slot.region));
      const evLine = document.createElement('div');
      evLine.className = 'trial-ev-line';
      setEventNameWithIcon(
        evLine,
        slot.event,
        remain.kind === 'live' ? 'act' : eventType(slot.event)
      );
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = slot.map;
      row2.append(evLine, tag);

      const foot = document.createElement('div');
      foot.className = 'slot-foot';
      if (registered) {
        const party = document.createElement('div');
        party.className = 'slot-party';
        const size = partySizeOf(sortie);
        const groups = partyMemberLists(sortie);
        const hasAnyone = groups.some((g) => g.length);
        const form = document.createElement('span');
        form.className = 'slot-party-form';
        form.textContent = partySizeLabel(size);
        party.appendChild(form);
        if (hasAnyone) {
          groups.forEach((group, gi) => {
            if (!group.length && groups.length === 1) return;
            if (!group.length) return;
            const row = document.createElement('div');
            row.className = 'slot-party-group';
            if (groups.filter((g) => g.length).length > 1) {
              const mark = document.createElement('span');
              mark.className = 'slot-party-gmark';
              mark.textContent = `${gi + 1}`;
              row.appendChild(mark);
            }
            const names = document.createElement('span');
            names.className = 'slot-party-line';
            appendPartyGroupLine(names, group, size);
            names.title = groups
              .filter((g) => g.length)
              .map((g, i) => `P${i + 1}: ${formatPartyGroupLine(g, size)}`)
              .join('\n');
            row.appendChild(names);
            party.appendChild(row);
          });
        } else {
          const none = document.createElement('span');
          none.className = 'slot-party-vac';
          none.textContent = partyVacancyLabel(size);
          party.appendChild(none);
        }
        foot.appendChild(party);
      }
      const cta = document.createElement('div');
      cta.className = 'slot-cta';
      if (registered) {
        cta.textContent = '編集';
        cta.title = 'メンバーを編集';
      } else {
        cta.textContent = '予約する';
        cta.title = 'この時間枠でレイドを予約';
      }
      foot.appendChild(cta);

      row.append(row1, row2, foot);
      row.addEventListener('click', () => openSlotParty(trial, slot));
      list.appendChild(row);
    }
    sched.appendChild(list);
  }

  card.append(imgw, body, sched);
  return card;
}

/** 出撃のみ：メンバー絞り込みピッカー（選択した時点で反映） */
function openMemberFilterModal() {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop modal-backdrop--confirm';
  const modalEl = document.createElement('div');
  modalEl.className = 'modal modal-member-filter';

  const applyLive = () => {
    saveMemberFilterIds(memberFilterIds);
    render();
  };

  const paint = () => {
    const listEl = modalEl.querySelector('[data-list]');
    const keepScroll = listEl?.scrollTop || 0;
    const sorted = [...state.members].sort((a, b) => a.name.localeCompare(b.name, 'ja'));
    modalEl.innerHTML = `
      <div class="party-modal-head">
        <h3>メンバーで絞り込み</h3>
        <button type="button" class="btn modal-close" data-act="close">閉じる</button>
      </div>
      <p class="hint">選んだ人が1人でも参加しているレイドを表示します（${memberFilterIds.size}人選択中）</p>
      <div class="member-filter-pick-list" data-list></div>
      <div class="modal-actions">
        <button type="button" class="btn" data-act="clear"${memberFilterIds.size ? '' : ' disabled'}>クリア</button>
      </div>
    `;
    const list = modalEl.querySelector('[data-list]');
    if (!sorted.length) {
      list.innerHTML = '<p class="hint">名簿が空です</p>';
    } else {
      for (const m of sorted) {
        const on = memberFilterIds.has(m.id);
        const row = document.createElement('button');
        row.type = 'button';
        row.className = `member-pick${on ? ' is-on' : ''}`;
        const check = document.createElement('span');
        check.className = `pick-check${on ? ' is-on' : ''}`;
        check.setAttribute('aria-hidden', 'true');
        check.textContent = on ? '✓' : '';
        row.appendChild(check);
        row.appendChild(avatarNode(m));
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = m.name;
        row.appendChild(name);
        row.addEventListener('click', () => {
          if (memberFilterIds.has(m.id)) memberFilterIds.delete(m.id);
          else memberFilterIds.add(m.id);
          applyLive();
          paint();
        });
        list.appendChild(row);
      }
    }
    list.scrollTop = keepScroll;
    modalEl.querySelector('[data-act="close"]').addEventListener('click', () => backdrop.remove());
    modalEl.querySelector('[data-act="clear"]').addEventListener('click', () => {
      if (!memberFilterIds.size) return;
      memberFilterIds = new Set();
      applyLive();
      paint();
    });
  };

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) backdrop.remove();
  });
  paint();
  backdrop.appendChild(modalEl);
  document.body.appendChild(backdrop);
}

function memberFilterSummaryText() {
  if (!memberFilterIds.size) return 'メンバーで絞り込み';
  const names = state.members
    .filter((m) => memberFilterIds.has(m.id))
    .sort((a, b) => a.name.localeCompare(b.name, 'ja'))
    .map((m) => m.name);
  const who =
    names.length === 1 ? names[0] : names.length === 2 ? names.join('・') : `${names[0]} 他${names.length - 1}人`;
  return `メンバー: ${who}`;
}

function sortieMemberFingerprint(sortie) {
  return [...sortieMemberIdSet(sortie)].sort().join('\u0001');
}

function sortieMemberNamesLine(sortie) {
  const names = [...sortieMemberIdSet(sortie)]
    .map((id) => memberById(id, sortie)?.name)
    .filter(Boolean);
  names.sort((a, b) => a.localeCompare(b, 'ja'));
  return names.join('・');
}

/**
 * 同じ時間帯・同じメンバー・複数トライアルの重複キー（対象外は null）
 * @returns {Map<string, string>} sortieId → overlapKey
 */
function buildSortieOverlapKeyById(list) {
  /** @type {Map<string, typeof list>} */
  const byKey = new Map();
  for (const item of list) {
    const members = sortieMemberFingerprint(item.sortie);
    if (!members) continue;
    const key = `${item.startMs}|${item.endMs}|${members}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(item);
  }
  /** @type {Map<string, string>} */
  const out = new Map();
  for (const [key, group] of byKey) {
    if (group.length < 2) continue;
    const trialKeys = new Set(
      group.map((g) => String(g.sortie.trialId || g.sortie.objective || g.sortie.id))
    );
    if (trialKeys.size < 2) continue;
    for (const item of group) out.set(item.sortie.id, key);
  }
  return out;
}

/** 日内の出撃を、単独行 / 時間帯の重複まとまり に分割 */
function partitionDayClusters(items, overlapKeyById) {
  const used = new Set();
  /** @type {{ kind: 'single' | 'overlap', items: typeof items }[]} */
  const clusters = [];
  for (const item of items) {
    if (used.has(item.sortie.id)) continue;
    const key = overlapKeyById.get(item.sortie.id);
    if (!key) {
      used.add(item.sortie.id);
      clusters.push({ kind: 'single', items: [item] });
      continue;
    }
    const group = items
      .filter((x) => overlapKeyById.get(x.sortie.id) === key)
      .sort(
        (a, b) =>
          String(a.sortie.objective || '').localeCompare(String(b.sortie.objective || ''), 'ja') ||
          String(a.sortie.id).localeCompare(String(b.sortie.id))
      );
    for (const g of group) used.add(g.sortie.id);
    clusters.push({ kind: 'overlap', items: group });
  }
  return clusters;
}

function renderSortieTimelineRow(item, { hideTime = false, inOverlap = false } = {}) {
  const { sortie, startMs, endMs } = item;
  const remain = remainText(startMs, endMs);
  const { start, end } = fmtSlotRange(startMs, endMs);

  const row = document.createElement('div');
  row.className = 'sortie-time-row';
  if (hideTime) row.classList.add('sortie-time-row--nested');
  if (inOverlap) row.classList.add('is-overlap');
  row.setAttribute('role', 'button');
  row.tabIndex = 0;
  if (remain.kind === 'live') row.classList.add('is-live');
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openPartyModal(sortie.id);
    }
  });

  const timingTags = ensureTimingTags(sortie);

  if (!hideTime) {
    const timeCol = document.createElement('div');
    timeCol.className = 'sortie-time-col';
    const range = document.createElement('div');
    range.className = 'sortie-time-range';
    range.innerHTML = `<span>${esc(start)}</span><span class="t-dash">-</span><span>${esc(end)}</span>`;
    const cd = document.createElement('div');
    cd.className = 'sortie-time-cd';
    bindCountdownEl(cd, startMs, endMs, 'is-live');
    timeCol.append(range, cd);
    if (timingTags.length) {
      const timing = document.createElement('div');
      timing.className = 'sortie-time-timing-tags';
      appendTimingTagEls(timing, sortie);
      timeCol.appendChild(timing);
    }
    row.appendChild(timeCol);
  }

  const body = document.createElement('div');
  body.className = 'sortie-time-body';

  const head = document.createElement('div');
  head.className = 'sortie-time-head';

  const titleLine = document.createElement('div');
  titleLine.className = 'sortie-time-title-line';
  if (sortie.regionSlug) titleLine.appendChild(createSrvAbbr(sortie.regionSlug));
  else if (sortie.server) {
    const srv = document.createElement('span');
    srv.className = 'tag';
    srv.textContent = sortie.server;
    titleLine.appendChild(srv);
  }
  const title = document.createElement('span');
  title.className = 'sortie-time-title';
  title.textContent = sortie.objective || '（内容未設定）';
  titleLine.appendChild(title);
  head.appendChild(titleLine);

  if (sortie.event || sortie.map) {
    const metaLine = document.createElement('div');
    metaLine.className = 'sortie-time-head-meta-line';
    if (sortie.event) {
      const ev = document.createElement('span');
      ev.className = 'trial-ev-line sortie-time-head-meta';
      setEventNameWithIcon(ev, sortie.event, remain.kind === 'live' ? 'act' : eventType(sortie.event));
      metaLine.appendChild(ev);
    }
    if (sortie.map) {
      const map = document.createElement('span');
      map.className = 'tag sortie-time-head-meta';
      map.textContent = sortie.map;
      metaLine.appendChild(map);
    }
    head.appendChild(metaLine);
  }

  if (hideTime && timingTags.length) {
    const timing = document.createElement('div');
    timing.className = 'sortie-time-timing-tags';
    appendTimingTagEls(timing, sortie);
    head.appendChild(timing);
  }

  const parties = document.createElement('div');
  parties.className = 'sortie-time-parties';
  const size = partySizeOf(sortie);
  const groups = partyMemberLists(sortie);
  const filled = groups.filter((g) => g.length);
  const form = document.createElement('span');
  form.className = 'slot-party-form';
  form.textContent = partySizeLabel(size);
  parties.appendChild(form);
  if (!filled.length) {
    const none = document.createElement('span');
    none.className = 'slot-party-vac';
    none.textContent = partyVacancyLabel(size);
    parties.appendChild(none);
  } else {
    groups.forEach((group, gi) => {
      if (!group.length) return;
      const g = document.createElement('div');
      g.className = 'slot-party-group';
      if (filled.length > 1) {
        const mark = document.createElement('span');
        mark.className = 'slot-party-gmark';
        mark.textContent = `${gi + 1}`;
        g.appendChild(mark);
      }
      const line = document.createElement('span');
      line.className = 'slot-party-line';
      appendPartyGroupLine(line, group, size);
      g.appendChild(line);
      parties.appendChild(g);
    });
  }

  // 重複内も行ごとに時刻・参加者を出してまとまりを掴みやすくする
  body.append(head, parties);

  const actions = document.createElement('div');
  actions.className = 'sortie-time-actions';
  actions.appendChild(renderSortieRowMenu(sortie));
  row.append(body, actions);
  row.addEventListener('click', () => openPartyModal(sortie.id));
  return row;
}

function renderOverlapCluster(groupItems) {
  const first = groupItems[0];
  const { start, end } = fmtSlotRange(first.startMs, first.endMs);
  const remain = remainText(first.startMs, first.endMs);
  const memberLine = sortieMemberNamesLine(first.sortie);

  const cluster = document.createElement('div');
  cluster.className = 'sortie-overlap-cluster';
  if (remain.kind === 'live') cluster.classList.add('is-live');

  const head = document.createElement('div');
  head.className = 'sortie-overlap-cluster-head';

  const primary = document.createElement('div');
  primary.className = 'sortie-overlap-cluster-primary';

  const time = document.createElement('div');
  time.className = 'sortie-overlap-cluster-time';
  time.innerHTML = `<span class="sortie-time-range"><span>${esc(start)}</span><span class="t-dash">-</span><span>${esc(
    end
  )}</span></span>`;
  const cd = document.createElement('span');
  cd.className = 'sortie-time-cd';
  bindCountdownEl(cd, first.startMs, first.endMs, 'is-live');
  time.appendChild(cd);

  const label = document.createElement('div');
  label.className = 'sortie-overlap-cluster-label';
  label.textContent = `重複 ×${groupItems.length}`;

  primary.append(time, label);

  const members = document.createElement('div');
  members.className = 'sortie-overlap-cluster-members';
  members.textContent = memberLine || '参加者なし';
  members.title = memberLine;

  head.append(primary, members);

  const list = document.createElement('div');
  list.className = 'sortie-overlap-cluster-list';
  for (const item of groupItems) {
    list.appendChild(renderSortieTimelineRow(item, { hideTime: false, inOverlap: true }));
  }

  cluster.append(head, list);
  return cluster;
}

/** 「出撃のみ」：時間順の縦一覧 */
function renderRegisteredTimeline() {
  const root = document.createElement('div');
  root.className = 'sortie-timeline-shell';

  // 名簿に無い選択IDは落とす
  const known = new Set(state.members.map((m) => m.id));
  let filterDirty = false;
  for (const id of [...memberFilterIds]) {
    if (!known.has(id)) {
      memberFilterIds.delete(id);
      filterDirty = true;
    }
  }
  if (filterDirty) saveMemberFilterIds(memberFilterIds);

  const filterBar = document.createElement('div');
  filterBar.className = 'member-filter-bar';
  const openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.className = `btn member-filter-open${memberFilterIds.size ? ' is-on' : ''}`;
  openBtn.textContent = memberFilterSummaryText();
  openBtn.title = memberFilterIds.size
    ? `メンバー絞り込み中（${memberFilterIds.size}人）· タップで変更`
    : 'メンバーでレイドを絞り込み';
  openBtn.setAttribute(
    'aria-label',
    memberFilterIds.size ? `メンバー絞り込み: ${memberFilterSummaryText()}` : 'メンバーで絞り込み'
  );
  openBtn.addEventListener('click', () => openMemberFilterModal());
  filterBar.appendChild(openBtn);

  const recruitBtn = document.createElement('button');
  recruitBtn.type = 'button';
  recruitBtn.className = `btn member-filter-recruit${recruitFilterOnly ? ' is-on' : ''}`;
  recruitBtn.textContent = '募集中';
  recruitBtn.title = recruitFilterOnly
    ? '募集中のみ表示中（クリックで解除）'
    : '空き枠があるレイドだけ表示';
  recruitBtn.setAttribute('aria-pressed', recruitFilterOnly ? 'true' : 'false');
  recruitBtn.addEventListener('click', () => {
    recruitFilterOnly = !recruitFilterOnly;
    saveRecruitFilterOnly(recruitFilterOnly);
    render();
  });
  filterBar.appendChild(recruitBtn);

  if (memberFilterIds.size > 0) {
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'btn btn-ghost member-filter-clear';
    clear.textContent = '解除';
    clear.addEventListener('click', () => {
      memberFilterIds = new Set();
      saveMemberFilterIds(memberFilterIds);
      render();
    });
    filterBar.appendChild(clear);
  }
  root.appendChild(filterBar);

  const scroller = document.createElement('div');
  scroller.className = 'sortie-timeline';

  const list = state.sorties
    .map((s) => {
      const startMs = new Date(s.startAt).getTime();
      const endMs = new Date(s.endAt).getTime();
      return {
        sortie: s,
        startMs: Number.isFinite(startMs) ? startMs : 0,
        endMs: Number.isFinite(endMs) ? endMs : startMs + 3600000,
      };
    })
    .filter(
      ({ startMs, sortie }) =>
        !!startMs &&
        sortieMatchesMemberFilter(sortie) &&
        (!recruitFilterOnly || sortieIsRecruiting(sortie))
    )
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-sorties';
    const msg = document.createElement('p');
    msg.className = 'empty-sorties-msg';
    const actions = document.createElement('div');
    actions.className = 'empty-sorties-actions';
    if (memberFilterIds.size || recruitFilterOnly) {
      if (recruitFilterOnly && memberFilterIds.size) {
        msg.textContent = '条件に合う募集中のレイドはありません';
      } else if (recruitFilterOnly) {
        msg.textContent = '募集中のレイドはありません';
      } else {
        msg.textContent = '選択したメンバーが参加しているレイドはありません';
      }
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'btn btn-primary';
      clear.textContent = '絞り込みを解除';
      clear.addEventListener('click', () => {
        memberFilterIds = new Set();
        saveMemberFilterIds(memberFilterIds);
        recruitFilterOnly = false;
        saveRecruitFilterOnly(false);
        render();
      });
      actions.appendChild(clear);
    } else {
      msg.textContent = 'まだレイド予約がありません';
      const toAll = document.createElement('button');
      toAll.type = 'button';
      toAll.className = 'btn btn-primary';
      toAll.textContent = 'スケジュールを見る';
      toAll.addEventListener('click', () => {
        schedFilter = 'all';
        saveSchedFilter(schedFilter);
        render();
      });
      actions.appendChild(toAll);
    }
    empty.append(msg, actions);
    scroller.appendChild(empty);
    root.appendChild(scroller);
    return root;
  }

  const overlapKeyById = buildSortieOverlapKeyById(list);

  /** @type {Map<string, typeof list>} */
  const byDay = new Map();
  for (const item of list) {
    const key = fmtDateWeekJa(item.startMs);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(item);
  }

  for (const [dayLabel, items] of byDay) {
    const day = document.createElement('section');
    day.className = 'sortie-day';

    const head = document.createElement('h2');
    head.className = 'sortie-day-head';
    head.textContent = dayLabel;
    day.appendChild(head);

    const track = document.createElement('div');
    track.className = 'sortie-day-track';

    const clusters = partitionDayClusters(items, overlapKeyById);
    for (const cluster of clusters) {
      if (cluster.kind === 'overlap') {
        track.appendChild(renderOverlapCluster(cluster.items));
      } else {
        track.appendChild(renderSortieTimelineRow(cluster.items[0]));
      }
    }

    day.appendChild(track);
    scroller.appendChild(day);
  }

  root.appendChild(scroller);
  return root;
}

function render(opts = {}) {
  pruneExpiredSorties();
  const scrollY = window.scrollY;
  const prevRail = app.querySelector('.trial-rail');
  if (prevRail) trialRailScrollLeft = prevRail.scrollLeft;
  captureSchedScrolls();
  const railScrollLeft = Number.isFinite(opts.keepRailScroll)
    ? opts.keepRailScroll
    : trialRailScrollLeft;
  app.replaceChildren();

  const top = document.createElement('header');
  top.className = 'topbar';

  const brand = document.createElement('div');
  brand.className = 'brand';
  const mark = document.createElement('img');
  mark.className = 'brand-mark';
  mark.src = '/favicon.svg';
  mark.alt = '';
  mark.width = 28;
  mark.height = 28;
  mark.decoding = 'async';
  const brandText = document.createElement('div');
  brandText.className = 'brand-text';
  const title = document.createElement('h1');
  title.textContent = 'レイド予約';
  brandText.appendChild(title);
  const sub = document.createElement('p');
  sub.textContent = 'レイド予定は共有されます';
  brandText.appendChild(sub);
  brand.append(mark, brandText);
  top.appendChild(brand);

  const actions = document.createElement('div');
  actions.className = 'top-actions';

  const weekFilter = document.createElement('div');
  weekFilter.className = 'seg';
  weekFilter.setAttribute('role', 'group');
  weekFilter.setAttribute('aria-label', '週の切り替え');
  const weekDisabled = schedFilter === 'registered';
  for (const opt of [
    { id: 'current', label: '今週' },
    { id: 'next', label: '来週' },
  ]) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `seg-btn${weekMode === opt.id ? ' is-on' : ''}`;
    btn.textContent = opt.label;
    btn.disabled = weekDisabled;
    btn.setAttribute('aria-pressed', weekMode === opt.id ? 'true' : 'false');
    btn.title = weekDisabled ? 'レイドのみ表示中は使えません' : '';
    btn.addEventListener('click', () => setWeekMode(opt.id));
    weekFilter.appendChild(btn);
  }
  if (weekDisabled) weekFilter.classList.add('is-disabled');
  actions.appendChild(weekFilter);

  const viewFilter = document.createElement('div');
  viewFilter.className = 'seg';
  viewFilter.setAttribute('role', 'group');
  viewFilter.setAttribute('aria-label', '表示切替');
  for (const opt of [
    { id: 'all', label: 'すべて' },
    { id: 'registered', label: `レイド · ${state.sorties.length}` },
  ]) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `seg-btn${schedFilter === opt.id ? ' is-on' : ''}`;
    btn.textContent = opt.label;
    btn.setAttribute('aria-pressed', schedFilter === opt.id ? 'true' : 'false');
    btn.title =
      opt.id === 'registered' ? '登録済みのレイドだけ表示' : 'スケジュール一覧を表示';
    btn.addEventListener('click', () => {
      schedFilter = opt.id;
      saveSchedFilter(schedFilter);
      render();
    });
    viewFilter.appendChild(btn);
  }

  actions.appendChild(viewFilter);
  top.appendChild(actions);

  const toolbar = document.createElement('div');
  toolbar.className = 'schedule-toolbar';

  if (schedFilter !== 'registered') {
    const filters = document.createElement('div');
    filters.className = 'region-filters';
    const label = document.createElement('span');
    label.className = 'region-filters-label';
    label.textContent = 'サーバー';
    filters.appendChild(label);
    for (const r of SERVER_REGIONS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `srv-pick-btn${selectedRegions.includes(r.slug) ? ' is-active' : ''}`;
      btn.dataset.serverRegion = r.slug;
      btn.title = `${r.label} (${r.abbr})`;
      btn.innerHTML = `<span class="srv-pick-full">${esc(r.label)}</span><span class="srv-pick-short">${esc(r.abbr)}</span>`;
      btn.addEventListener('click', () => {
        if (selectedRegions.includes(r.slug)) {
          if (selectedRegions.length === 1) return;
          selectedRegions = selectedRegions.filter((x) => x !== r.slug);
        } else {
          selectedRegions = [...selectedRegions, r.slug];
        }
        loadSchedule();
      });
      filters.appendChild(btn);
    }
    toolbar.appendChild(filters);
  }

  const trials = visibleTrials();
  const main = document.createElement('div');
  if (schedFilter === 'registered') {
    main.className = 'sortie-timeline-wrap';
    if (loading && !state.sorties.length && !trialsCurrent.length && !trialsNext.length) {
      main.appendChild(renderLoadingSkeleton('timeline'));
    } else if (loadError && !state.sorties.length) {
      main.innerHTML = `<div class="empty-sorties"><p class="empty-sorties-msg">${esc(loadError)}</p></div>`;
    } else {
      main.appendChild(renderRegisteredTimeline());
    }
  } else {
    if (loading && !trialsCurrent.length && !trialsNext.length) {
      main.className = 'sortie-timeline-wrap';
      main.appendChild(renderLoadingSkeleton('rail'));
    } else if (loadError) {
      main.className = 'trial-rail';
      main.innerHTML = `<div class="empty-sorties"><p class="empty-sorties-msg">${esc(loadError)}</p></div>`;
    } else if (!trials.length) {
      main.className = 'trial-rail';
      const empty = document.createElement('div');
      empty.className = 'empty-sorties';
      const msg = document.createElement('p');
      msg.className = 'empty-sorties-msg';
      const actions = document.createElement('div');
      actions.className = 'empty-sorties-actions';
      if (weekMode === 'next') {
        msg.textContent = '来週のトライアルはまだ公開されていません';
        const toCurrent = document.createElement('button');
        toCurrent.type = 'button';
        toCurrent.className = 'btn btn-primary';
        toCurrent.textContent = '今週を見る';
        toCurrent.addEventListener('click', () => setWeekMode('current'));
        actions.appendChild(toCurrent);
      } else {
        msg.textContent = '今週のアクティブなトライアルがありません';
        const toNext = document.createElement('button');
        toNext.type = 'button';
        toNext.className = 'btn';
        toNext.textContent = '来週を見る';
        toNext.addEventListener('click', () => setWeekMode('next'));
        actions.appendChild(toNext);
      }
      empty.append(msg, actions);
      main.appendChild(empty);
    } else {
      main.className = 'trial-rail';
      trials.forEach((t, i) => {
        const card = renderTrialCard(t);
        card.style.setProperty('--card-i', String(Math.min(i, 8)));
        main.appendChild(card);
      });
    }
  }

  if (toolbar.childNodes.length) {
    app.append(top, toolbar, main);
  } else {
    app.append(top, main);
  }

  const footer = document.createElement('footer');
  footer.className = 'site-footer';
  footer.setAttribute('role', 'contentinfo');

  const helpBtn = document.createElement('button');
  helpBtn.type = 'button';
  helpBtn.className = 'site-footer-help';
  helpBtn.textContent = '使い方';
  helpBtn.title = 'このサイトの使い方';
  helpBtn.addEventListener('click', () => openHelpModal());

  const attribution = document.createElement('a');
  attribution.href = 'https://metaforge.app/arc-raiders';
  attribution.target = '_blank';
  attribution.rel = 'noopener noreferrer';
  attribution.textContent = '出典: MetaForge';

  const credit = document.createElement('a');
  credit.className = 'site-footer-credit';
  credit.href = 'https://x.com/ice_oji22';
  credit.target = '_blank';
  credit.rel = 'noopener noreferrer';
  credit.textContent = '@あいすおじ';

  const aboutBtn = document.createElement('button');
  aboutBtn.type = 'button';
  aboutBtn.className = 'site-footer-about';
  aboutBtn.textContent = 'About';
  aboutBtn.title = 'このサイトについて';
  aboutBtn.addEventListener('click', () => openAboutModal());

  footer.append(helpBtn, attribution, credit, aboutBtn);
  app.appendChild(footer);

  window.scrollTo(0, scrollY);
  const nextRail = app.querySelector('.trial-rail');
  if (nextRail) {
    nextRail.addEventListener(
      'scroll',
      () => {
        // モーダル中は iOS が背面を 0 に戻すことがあり、保存位置を壊すので無視
        if (modal) return;
        trialRailScrollLeft = nextRail.scrollLeft;
      },
      { passive: true }
    );
    if (railScrollLeft > 0) {
      const restoreLeft = () => {
        nextRail.scrollLeft = railScrollLeft;
        trialRailScrollLeft = railScrollLeft;
      };
      restoreLeft();
      requestAnimationFrame(() => {
        restoreLeft();
        requestAnimationFrame(restoreLeft);
      });
    }
  }
  restoreSchedScrolls();
}

render();
(async () => {
  try {
    await pullBoard({ migrateLocal: true });
  } catch (e) {
    console.warn('[board]', e);
    boardError = String(e.message || e);
    boardReady = true;
    showToast('共有ボードに接続できません（この端末のみで動作）');
  }
  refreshUi();
  startBoardPolling();
  loadSchedule();
})();
clearInterval(clockTimer);
clearInterval(countdownTimer);
countdownTimer = setInterval(() => {
  tickCountdowns();
}, 1000);
clockTimer = setInterval(() => {
  const pruned = pruneExpiredSorties();
  if (modal) {
    if (partySortieId && !state.sorties.some((s) => s.id === partySortieId)) {
      closeModal();
      render();
    }
    return;
  }
  // 終了したものがあるときだけ全面再描画（通常は1秒tickで足りる）
  if (!pruned) return;
  const keep = partySortieId;
  render();
  if (keep && state.sorties.some((s) => s.id === keep)) openPartyModal(keep);
}, 30000);
tickCountdowns();

document.addEventListener('click', (e) => {
  if (e.target.closest?.('.sortie-row-menu')) return;
  closeAllSortieMenus();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeAllSortieMenus();
});
