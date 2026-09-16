import './style.css';
import {
  loadState,
  saveState,
  createMember,
  createSortie,
} from './store.js';
import { fetchWeeklyTrials, fetchScheduleSlots, slotKey } from './metaforge.js';
import { fetchSharedBoard, pushSharedBoard } from './sync.js';
import { SERVER_REGIONS, regionAbbr, regionLabel, MAP_OPTIONS, EVENT_OPTIONS, eventType, mapJa } from './names.js';

const WEEK_MODE_KEY = 'arcraiders.sortieMemo.weekMode';

function loadWeekMode() {
  try {
    const v = localStorage.getItem(WEEK_MODE_KEY);
    return v === 'next' ? 'next' : 'current';
  } catch {
    return 'current';
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
let schedFilter = 'all';
/** @type {'current' | 'next'} */
let weekMode = loadWeekMode();
/** トライアル横レールの scrollLeft（再描画で飛ばないよう保持） */
let trialRailScrollLeft = 0;

function visibleTrials() {
  return weekMode === 'next' ? trialsNext : trialsCurrent;
}
/** 出撃メンバー登録ポップを開いている出撃ID */
let partySortieId = null;
let modal = null;
let toastTimer = null;
let clockTimer = null;

const app = document.querySelector('#app');
const PARTY_SIZE = 3;

function chunkBy(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** parties: string[][] を正規化し、旧 memberIds からも移行（空パーティは残す） */
function ensureParties(sortie) {
  if (!sortie) return [[]];
  if (Array.isArray(sortie.parties)) {
    sortie.parties = sortie.parties.map((p) =>
      Array.isArray(p) ? [...new Set(p.filter(Boolean))] : []
    );
    if (!sortie.parties.length) sortie.parties = [[]];
  } else {
    const ids = Array.isArray(sortie.memberIds) ? sortie.memberIds.filter(Boolean) : [];
    sortie.parties = ids.length ? chunkBy(ids, PARTY_SIZE) : [[]];
  }
  sortie.memberIds = sortie.parties.flat();
  return sortie.parties;
}

function partyMemberLists(sortie) {
  return ensureParties(sortie).map((ids) => ids.map((id) => memberById(id, sortie)).filter(Boolean));
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

/** 名簿から削除し、全出撃のパーティからも外す */
function deleteMemberFromRoster(memberId) {
  if (!memberId) return false;
  const member = state.members.find((m) => m.id === memberId);
  if (!member) return false;
  const inParties = state.sorties.some((s) => findMemberPartyIndex(s, memberId) >= 0);
  const label = member.name || 'このメンバー';
  const msg = inParties
    ? `「${label}」を名簿から削除しますか？\n参加中のパーティからも外れます。`
    : `「${label}」を名簿から削除しますか？`;
  if (!confirm(msg)) return false;
  state.members = state.members.filter((m) => m.id !== memberId);
  for (const s of state.sorties) {
    removeMemberFromParties(s, memberId);
  }
  persist();
  return true;
}

function addMemberToParty(sortie, memberId, partyIndex) {
  ensureParties(sortie);
  let idx = partyIndex;
  if (idx == null || idx < 0) idx = 0;
  while (sortie.parties.length <= idx) sortie.parties.push([]);
  const alreadyHere = sortie.parties[idx].includes(memberId);
  if (!alreadyHere && sortie.parties[idx].length >= PARTY_SIZE) {
    return { ok: false, reason: 'full', partyIndex: idx };
  }
  // 他パーティから外してから入れる
  sortie.parties = sortie.parties.map((p, i) =>
    i === idx ? p : p.filter((id) => id !== memberId)
  );
  if (!sortie.parties[idx].includes(memberId)) {
    if (sortie.parties[idx].length >= PARTY_SIZE) {
      return { ok: false, reason: 'full', partyIndex: idx };
    }
    sortie.parties[idx].push(memberId);
  }
  compactEmptyParties(sortie);
  // 詰め後にメンバーがいるパーティ番号を返す
  idx = findMemberPartyIndex(sortie, memberId);
  return { ok: true, partyIndex: Math.max(0, idx) };
}

/** 空パーティをすべて除去（1つも無いときは空枠を1つだけ残す） */
function compactEmptyParties(sortie) {
  if (!sortie || !Array.isArray(sortie.parties)) return [[]];
  const filled = sortie.parties.filter((p) => Array.isArray(p) && p.length > 0);
  sortie.parties = filled.length ? filled : [[]];
  sortie.memberIds = sortie.parties.flat();
  return sortie.parties;
}

/** 指定パーティのメンバーをまとめて置き換え（最大 PARTY_SIZE） */
function setPartyMembers(sortie, partyIndex, memberIds) {
  ensureParties(sortie);
  const ids = [...new Set((memberIds || []).filter(Boolean))].slice(0, PARTY_SIZE);
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
  compactEmptyParties(sortie);
  const next = { ...(sortie.roster && typeof sortie.roster === 'object' ? sortie.roster : {}) };
  const used = new Set(sortie.memberIds);
  for (const id of used) {
    const local = state.members.find((m) => m.id === id);
    const prev = next[id];
    const src = local || prev;
    if (!src) continue;
    const avatarUrl = String(src.avatarUrl || '').startsWith('http') ? String(src.avatarUrl) : '';
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

function persist(opts = {}) {
  if (opts.sortieId) {
    const s = state.sorties.find((x) => x.id === opts.sortieId);
    if (s) refreshSortieRoster(s);
  } else {
    for (const s of state.sorties) refreshSortieRoster(s);
  }
  saveState(state);
  if (!opts.skipSync && boardReady) queueBoardPush();
}

function queueBoardPush() {
  clearTimeout(boardPushTimer);
  boardPushTimer = setTimeout(() => {
    pushBoardNow().catch((e) => {
      console.warn('[board push]', e);
      boardError = String(e.message || e);
    });
  }, 200);
}

async function pushBoardNow() {
  if (boardSyncing) {
    queueBoardPush();
    return;
  }
  boardSyncing = true;
  try {
    for (const s of state.sorties) {
      compactEmptyParties(s);
      reconcileSortieAgainstMembers(s);
      refreshSortieRoster(s);
    }
    const board = await pushSharedBoard({
      sorties: state.sorties,
      members: state.members,
    });
    applySharedBoard(board);
    boardError = '';
  } finally {
    boardSyncing = false;
  }
}

async function pullBoard({ migrateLocal = false } = {}) {
  const localSorties = Array.isArray(state.sorties) ? state.sorties.slice() : [];
  const localMembers = Array.isArray(state.members) ? state.members.slice() : [];
  const board = await fetchSharedBoard();
  const boardHasSorties = Boolean(board.sorties?.length);
  const boardHasMembers = Boolean(board.members?.length);

  // 共有ボードが完全に空のときだけ、端末データを初回アップロード
  if (migrateLocal && !boardHasSorties && !boardHasMembers && (localSorties.length || localMembers.length)) {
    state.sorties = localSorties;
    state.members = localMembers;
    boardReady = true;
    await pushBoardNow();
    return;
  }

  // 共有側を正とする（端末の仮名簿・古いIDで上書きしない）
  boardReady = true;
  applySharedBoard(board, { repairPush: true });
  boardError = '';
}

function startBoardPolling() {
  clearInterval(boardPullTimer);
  boardPullTimer = setInterval(() => {
    // パーティ編集中は通信・再描画しない（操作を重くしない）
    if (document.hidden || boardSyncing || (modal && partySortieId)) return;
    pullBoard()
      .then(() => refreshUi())
      .catch((e) => {
        console.warn('[board pull]', e);
      });
  }, 8000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !(modal && partySortieId)) {
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
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

function remainText(startMs, endMs, now = Date.now()) {
  if (now >= endMs) return { text: '—', kind: 'past' };
  if (now >= startMs) return { text: '実施中', kind: 'live' };
  return { text: formatCountdownHmsShort(startMs - now), kind: '' };
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
    return next.slice(0, PARTY_SIZE);
  });
  compactEmptyParties(sortie);
  refreshSortieRoster(sortie);
  return JSON.stringify(sortie.parties) !== before;
}

function applySharedBoard(board, { repairPush = false } = {}) {
  state.sorties = Array.isArray(board.sorties)
    ? board.sorties.map((s) => ({
        ...s,
        parties: Array.isArray(s.parties) ? s.parties.map((p) => (Array.isArray(p) ? [...p] : [])) : [[]],
        roster: s.roster && typeof s.roster === 'object' ? { ...s.roster } : {},
      }))
    : [];
  state.members = Array.isArray(board.members) ? board.members.map((m) => ({ ...m })) : [];
  let repaired = false;
  for (const s of state.sorties) {
    compactEmptyParties(s);
    if (reconcileSortieAgainstMembers(s)) repaired = true;
  }
  saveState(state);
  if (repairPush && repaired && boardReady) queueBoardPush();
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
  const groups = partyMemberLists(sortie);
  const filled = groups.filter((g) => g.length);
  const peopleLines =
    filled.length <= 1
      ? filled[0]?.map((m) => `@${m.name}`).join(' ') || ''
      : groups
          .map((g, i) =>
            g.length ? `パーティ${i + 1}: ${g.map((m) => `@${m.name}`).join(' ')}` : null
          )
          .filter(Boolean)
          .join('\n');
  return [
    `${datePart} ${start} - ${end}`.trim(),
    [regionLabel(sortie.regionSlug) || sortie.server, sortie.map, sortie.event]
      .filter(Boolean)
      .join(' '),
    sortie.objective ? `「${sortie.objective}」` : '',
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
  // パーティ編集は閉じるときに共有ボードへ保存＆背面更新
  if (closingParty) {
    persist(editedSortieId ? { sortieId: editedSortieId } : {});
    render();
  }
}

function openModal(node) {
  closeModal({ keepParty: true });
  modal = node;
  document.body.appendChild(node);
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
  // 差し替え中に scroll-snap が先頭へ吸着しないようにする
  const prevSnap = rail.style.scrollSnapType;
  rail.style.scrollSnapType = 'none';
  const next = renderTrialCard(trial);
  old.replaceWith(next);
  const restore = () => {
    rail.scrollLeft = keep;
    trialRailScrollLeft = keep;
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
  if (target && target.length >= PARTY_SIZE && current !== partyIndex) {
    showToast(`パーティ${partyIndex + 1}は満員です（最大${PARTY_SIZE}人）`);
    return;
  }
  const res = addMemberToParty(sortie, memberId, partyIndex);
  if (!res.ok) {
    showToast(`パーティ${partyIndex + 1}は満員です（最大${PARTY_SIZE}人）`);
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
  modalEl.innerHTML = `
    <div class="party-modal-head">
      <h3>出撃メンバー</h3>
      <button type="button" class="btn btn-ghost" data-act="close">閉じる</button>
    </div>
    <div class="party-summary">
      <div class="party-summary-title">${esc(sortie.objective || '（内容未設定）')}</div>
      <div class="party-summary-meta" data-meta></div>
    </div>
    <p class="hint party-howto">
      パーティをタップしてメンバーを追加・外しできます（各${PARTY_SIZE}人・2人でもOK）。PCはドラッグでも移動できます。
    </p>
    <div class="party-modal-grid">
      <section class="party-pane">
        <div class="party-pane-head">
          <div class="party-pane-label">パーティ</div>
          <button type="button" class="btn" data-add-party>+ 追加</button>
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
      <button type="button" class="btn btn-danger" data-act="remove">出撃を解除</button>
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
    // 「+ 追加」だけして戻ったときなど、空パーティを残さない
    if (wasOpen) {
      compactEmptyParties(getSortie());
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
    const count = Math.min(fillSelected.size, PARTY_SIZE);
    const live = getSortie();
    setPartyMembers(live, gi, [...fillSelected]);
    persist({ sortieId });
    closeFillSheet();
    if (!repaintPartyModal()) {
      render();
      openPartyModal(sortieId);
    }
    showToast(`パーティ${gi + 1}を更新しました（${count}/${PARTY_SIZE}）`);
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
        <div class="hint">最大${PARTY_SIZE}人まで選んで確定（${selectedCount}/${PARTY_SIZE}）</div>
      </div>
      <button type="button" class="btn btn-ghost" data-fill-close>戻る</button>
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
      if (fillSelected.size < PARTY_SIZE) fillSelected.add(member.id);
      else showToast(`選択は最大${PARTY_SIZE}人です（名簿には追加済み）`);
      fillName.value = '';
      paintFillSheet();
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
        const full = !selected && fillSelected.size >= PARTY_SIZE;
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
            if (fillSelected.size >= PARTY_SIZE) {
              showToast(`最大${PARTY_SIZE}人までです`);
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
      <button type="button" class="btn btn-primary" data-fill-apply>確定（${selectedCount}/${PARTY_SIZE}）</button>
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
    fillSelected = new Set(live.parties[partyIndex] || []);
    paintFillSheet();
  };

  const paintParties = () => {
    const live = getSortie();
    ensureParties(live);
    const partyEl = modalEl.querySelector('[data-party]');
    partyEl.replaceChildren();
    const groups = partyMemberLists(live);
    groups.forEach((group, gi) => {
      const block = document.createElement('div');
      block.className = 'party-group';
      block.tabIndex = 0;
      block.setAttribute('role', 'button');
      block.setAttribute(
        'aria-label',
        `パーティ${gi + 1}のメンバーを編集（${group.length}/${PARTY_SIZE}）`
      );
      bindPartyDrop(block, gi);

      const head = document.createElement('div');
      head.className = 'party-group-head';
      head.innerHTML = `<span>パーティ ${gi + 1}</span><span class="party-group-count">${group.length}/${PARTY_SIZE}</span>`;
      block.appendChild(head);

      const chips = document.createElement('div');
      chips.className = 'party-group-chips';
      if (!group.length) {
        const empty = document.createElement('div');
        empty.className = 'party-empty';
        empty.textContent = 'タップしてメンバー追加';
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
      row.appendChild(avatarNode(m));
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = m.name;
      const mark = document.createElement('span');
      mark.className = 'pick-mark';
      mark.textContent = partyIdx >= 0 ? `P${partyIdx + 1}` : '未配置';
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'member-pick-remove';
      del.setAttribute('aria-label', `${m.name}を名簿から削除`);
      del.title = '名簿から削除';
      del.textContent = '×';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!deleteMemberFromRoster(m.id)) return;
        if (!repaintPartyModal()) {
          render();
          openPartyModal(sortieId);
        }
        showToast(`${m.name} を名簿から削除しました`);
      });
      row.append(name, mark, del);
      bindMemberDrag(row, m.id);
      row.addEventListener('click', () => {
        if (partyIdx >= 0) {
          removeSortieMember(sortieId, m.id);
          return;
        }
        showToast('追加したいパーティをタップしてください');
      });
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
      if (mark) mark.textContent = partyIdx >= 0 ? `P${partyIdx + 1}` : '未配置';
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
    paintParties();
    if (opts.light) updateMemberMarks();
    else paintMembers();
    if (fillPartyIndex != null) paintFillSheet();
  };

  const nameInput = modalEl.querySelector('[data-name]');
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
  };
  modalEl.querySelector('[data-add]').addEventListener('click', doAdd);
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doAdd();
  });

  modalEl.querySelector('[data-add-party]').addEventListener('click', () => {
    const res = addEmptyParty(getSortie());
    persist({ skipSync: true, sortieId });
    openPartyModal._pendingFill = res.partyIndex;
    if (!repaintPartyModal()) {
      openPartyModal(sortieId);
      return;
    }
    openPartyModal._pendingFill = null;
    openFillSheet(res.partyIndex);
  });

  modalEl.querySelector('[data-act="close"]').addEventListener('click', () => closeModal());
  modalEl.querySelector('[data-act="copy"]').addEventListener('click', () => {
    copyText(discordCopyText(getSortie()));
  });
  modalEl.querySelector('[data-act="remove"]').addEventListener('click', () => {
    if (!confirm('この出撃を解除しますか？')) return;
    state.sorties = state.sorties.filter((s) => s.id !== sortieId);
    persist();
    closeModal();
    render();
    showToast('出撃を解除しました');
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
    case 'all':
    default:
      return `<svg ${base}><circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="2"/><path d="M12 7v10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M7 12h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
  }
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
      <button type="button" class="btn btn-ghost" data-act="close">閉じる</button>
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
    empty.innerHTML =
      'マップとイベントを選ぶと枠が表示されます<br /><button type="button" class="btn" data-setup>設定する</button>';
    empty.querySelector('[data-setup]').addEventListener('click', openPrefs);
    sched.appendChild(empty);
    card.append(imgw, body, sched);
    return card;
  }

  const list = document.createElement('div');
  list.className = 'mp-time-list';

  const now = Date.now();
  const hourStart = now - (now % 3600000);
  let visible = slots.filter((slot) => slotMatchesTrialPrefs(slot, prefs));
  if (schedFilter === 'registered') {
    visible = visible.filter((slot) => isRegisteredSlot(slot, trial.id));
  }

  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'trial-slot-empty';
    empty.textContent = loading
      ? '読み込み中…'
      : schedFilter === 'registered'
        ? '出撃登録がありません'
        : 'この条件では表示できる枠がありません';
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
      if (slot.startMs === hourStart || remain.kind === 'live') row.classList.add('current');
      if (registered) row.classList.add('is-registered');

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
      cd.className = `trial-sched-cd${remain.kind === 'live' ? ' trial-sched-cd--live' : ''}`;
      cd.textContent = remain.text;
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
        const groups = partyMemberLists(sortie);
        const hasAnyone = groups.some((g) => g.length);
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
            names.className = 'slot-party-names';
            names.textContent = group.map((m) => m.name).join('・');
            names.title = groups
              .filter((g) => g.length)
              .map((g, i) => `P${i + 1}: ${g.map((m) => m.name).join('、')}`)
              .join('\n');
            row.appendChild(names);
            party.appendChild(row);
          });
        } else {
          const none = document.createElement('span');
          none.className = 'slot-party-empty';
          none.textContent = '参加者なし';
          party.appendChild(none);
        }
        foot.appendChild(party);
      }
      const cta = document.createElement('div');
      cta.className = 'slot-cta';
      cta.textContent = registered ? 'メンバー編集' : 'この枠で出撃';
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

/** 「出撃のみ」：時間順の縦一覧 */
function renderRegisteredTimeline() {
  const root = document.createElement('div');
  root.className = 'sortie-timeline';

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
    .filter(({ startMs }) => !!startMs)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  if (!list.length) {
    root.innerHTML =
      '<div class="empty-sorties">出撃登録がありません。表示を「すべて」にして枠を選んでください。</div>';
    return root;
  }

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

    for (const { sortie, startMs, endMs } of items) {
      const remain = remainText(startMs, endMs);
      const { start, end } = fmtSlotRange(startMs, endMs);

      const row = document.createElement('div');
      row.className = 'sortie-time-row';
      row.setAttribute('role', 'button');
      row.tabIndex = 0;
      if (remain.kind === 'live') row.classList.add('is-live');
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openPartyModal(sortie.id);
        }
      });

      const timeCol = document.createElement('div');
      timeCol.className = 'sortie-time-col';
      const range = document.createElement('div');
      range.className = 'sortie-time-range';
      range.innerHTML = `<span>${esc(start)}</span><span class="t-dash">-</span><span>${esc(end)}</span>`;
      const cd = document.createElement('div');
      cd.className = `sortie-time-cd${remain.kind === 'live' ? ' is-live' : ''}`;
      cd.textContent = remain.text;
      timeCol.append(range, cd);

      const body = document.createElement('div');
      body.className = 'sortie-time-body';

      const titleRow = document.createElement('div');
      titleRow.className = 'sortie-time-title-row';
      if (sortie.regionSlug) titleRow.appendChild(createSrvAbbr(sortie.regionSlug));
      else if (sortie.server) {
        const srv = document.createElement('span');
        srv.className = 'tag';
        srv.textContent = sortie.server;
        titleRow.appendChild(srv);
      }
      const title = document.createElement('div');
      title.className = 'sortie-time-title';
      title.textContent = sortie.objective || '（内容未設定）';
      titleRow.appendChild(title);

      const meta = document.createElement('div');
      meta.className = 'sortie-time-meta';
      if (sortie.event) {
        const ev = document.createElement('span');
        ev.className = 'trial-ev-line';
        setEventNameWithIcon(ev, sortie.event, remain.kind === 'live' ? 'act' : eventType(sortie.event));
        meta.appendChild(ev);
      }
      if (sortie.map) {
        const map = document.createElement('span');
        map.className = 'tag';
        map.textContent = sortie.map;
        meta.appendChild(map);
      }

      const parties = document.createElement('div');
      parties.className = 'sortie-time-parties';
      const groups = partyMemberLists(sortie);
      const filled = groups.filter((g) => g.length);
      if (!filled.length) {
        const none = document.createElement('span');
        none.className = 'slot-party-empty';
        none.textContent = '参加者なし';
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
          const names = document.createElement('span');
          names.className = 'slot-party-names';
          names.textContent = group.map((m) => m.name).join('・');
          g.appendChild(names);
          parties.appendChild(g);
        });
      }

      body.append(titleRow, meta, parties);

      const actions = document.createElement('div');
      actions.className = 'sortie-time-actions';

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'btn btn-primary sortie-time-edit';
      editBtn.textContent = 'メンバー編集';
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openPartyModal(sortie.id);
      });

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'btn btn-danger sortie-time-remove';
      removeBtn.textContent = '出撃解除';
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!confirm('この出撃を解除しますか？')) return;
        state.sorties = state.sorties.filter((s) => s.id !== sortie.id);
        persist();
        render();
        showToast('出撃を解除しました');
      });

      actions.append(editBtn, removeBtn);

      row.append(timeCol, body, actions);
      row.addEventListener('click', () => openPartyModal(sortie.id));
      track.appendChild(row);
    }

    day.appendChild(track);
    root.appendChild(day);
  }

  return root;
}

function render(opts = {}) {
  pruneExpiredSorties();
  const scrollY = window.scrollY;
  const prevRail = app.querySelector('.trial-rail');
  if (prevRail) trialRailScrollLeft = prevRail.scrollLeft;
  const railScrollLeft = Number.isFinite(opts.keepRailScroll)
    ? opts.keepRailScroll
    : trialRailScrollLeft;
  app.replaceChildren();

  const top = document.createElement('header');
  top.className = 'topbar';
  top.innerHTML = `
    <div class="brand">
      <h1>出撃備忘録</h1>
      <p>出撃予定・メンバー名簿は共有されます</p>
    </div>
  `;
  const actions = document.createElement('div');
  actions.className = 'top-actions';

  const weekFilter = document.createElement('div');
  weekFilter.className = 'week-filters';
  weekFilter.setAttribute('role', 'group');
  weekFilter.setAttribute('aria-label', '週の切り替え');
  for (const opt of [
    { id: 'current', label: '今週' },
    { id: 'next', label: '来週' },
  ]) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `chip-btn${weekMode === opt.id ? ' is-on' : ''}`;
    btn.textContent = opt.label;
    btn.disabled = schedFilter === 'registered';
    btn.title = schedFilter === 'registered' ? '出撃のみ表示中は使えません' : '';
    btn.addEventListener('click', () => setWeekMode(opt.id));
    weekFilter.appendChild(btn);
  }

  const count = document.createElement('span');
  count.className = 'sortie-count';
  count.textContent = `出撃 ${state.sorties.length}`;
  count.title = '終了した出撃は自動で消えます';
  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.className = 'btn';
  refresh.textContent = loading ? '取得中…' : '再取得';
  refresh.disabled = loading;
  refresh.addEventListener('click', () => loadSchedule());
  actions.append(weekFilter, count, refresh);
  top.appendChild(actions);

  const toolbar = document.createElement('div');
  toolbar.className = 'schedule-toolbar';

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

  const viewFilter = document.createElement('div');
  viewFilter.className = 'sched-view-filters';
  const viewLabel = document.createElement('span');
  viewLabel.className = 'region-filters-label';
  viewLabel.textContent = '表示';
  viewFilter.appendChild(viewLabel);
  for (const opt of [
    { id: 'all', label: 'すべて' },
    { id: 'registered', label: '出撃のみ' },
  ]) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `chip-btn${schedFilter === opt.id ? ' is-on' : ''}`;
    btn.textContent = opt.label;
    btn.addEventListener('click', () => {
      schedFilter = opt.id;
      render();
    });
    viewFilter.appendChild(btn);
  }

  toolbar.append(viewFilter);
  if (schedFilter !== 'registered') {
    toolbar.prepend(filters);
  }

  const hint = document.createElement('p');
  hint.className = 'hint schedule-hint';
  hint.textContent =
    schedFilter === 'registered'
      ? 'みんなの出撃予定を開始時刻順に表示します。行をタップするとメンバー編集できます。'
      : weekMode === 'next'
        ? '来週のトライアルです。マップ・イベントを選び、公開済みの時間枠があればメンバー登録できます。'
        : 'カード上部をタップしてマップ・イベントを選び、時間枠でメンバー登録。出撃予定は全員で共有されます。';

  const trials = visibleTrials();
  const main = document.createElement('div');
  if (schedFilter === 'registered') {
    main.className = 'sortie-timeline-wrap';
    if (loading && !state.sorties.length && !trialsCurrent.length && !trialsNext.length) {
      main.innerHTML = '<div class="empty-sorties">スケジュールを取得中…</div>';
    } else if (loadError && !state.sorties.length) {
      main.innerHTML = `<div class="empty-sorties">${esc(loadError)}</div>`;
    } else {
      main.appendChild(renderRegisteredTimeline());
    }
  } else {
    main.className = 'trial-rail';
    if (loading && !trialsCurrent.length && !trialsNext.length) {
      main.innerHTML = '<div class="empty-sorties">スケジュールを取得中…</div>';
    } else if (loadError) {
      main.innerHTML = `<div class="empty-sorties">${esc(loadError)}</div>`;
    } else if (!trials.length) {
      main.innerHTML =
        weekMode === 'next'
          ? '<div class="empty-sorties">来週のトライアルはまだ公開されていません</div>'
          : '<div class="empty-sorties">今週のアクティブなトライアルがありません</div>';
    } else {
      trials.forEach((t) => main.appendChild(renderTrialCard(t)));
    }
  }

  app.append(top, toolbar, hint, main);
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
clockTimer = setInterval(() => {
  pruneExpiredSorties();
  if (modal) {
    if (partySortieId && !state.sorties.some((s) => s.id === partySortieId)) {
      closeModal();
      render();
    }
    return;
  }
  const keep = partySortieId;
  render();
  if (keep && state.sorties.some((s) => s.id === keep)) openPartyModal(keep);
}, 30000);
