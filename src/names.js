export const MAP_NAME_JA = {
  'Dam Battlegrounds': 'ダム戦場',
  Dam: 'ダム戦場',
  'The Dam': 'ダム戦場',
  'Buried City': '埋もれた町',
  'The Buried City': '埋もれた町',
  Spaceport: '宇宙港',
  'The Spaceport': '宇宙港',
  'Blue Gate': 'ブルーゲート',
  'The Blue Gate': 'ブルーゲート',
  'Stella Montis': 'ステラモンティス',
  'Riven Tides': 'リブン・タイズ',
  'The Riven Tides': 'リブン・タイズ',
  Riven: 'リブン・タイズ',
};

export const EVENT_NAME_JA = {
  'Night Raid': '夜襲',
  'Electromagnetic Storm': '電磁嵐',
  'Hidden Bunker': '隠された貯蔵庫',
  'Locked Gate': '鍵のかかった門',
  'Close Scrutiny': '精密探査',
  'Cold Snap': '寒波',
  Hurricane: '台風',
  Harvester: 'ハーベスター',
  Matriarch: 'マトリアーク',
  'Bird City': '鳥の街',
  'Husk Graveyard': '残骸の墓場',
  'Uncovered Caches': 'さらされた宝箱',
  'Launch Tower Loot': '発射台の戦利品',
  'Prospecting Probes': '探査機',
  'Lush Blooms': '収穫の季節',
  Beachcombing: '海岸探索',
};

/** イベントタイマーの EVENTS と同じ並び・種別 */
export const EVENT_DEFS = {
  夜襲: { type: 'major' },
  電磁嵐: { type: 'major' },
  隠された貯蔵庫: { type: 'major' },
  鍵のかかった門: { type: 'major' },
  精密探査: { type: 'major' },
  寒波: { type: 'major' },
  台風: { type: 'major' },
  ハーベスター: { type: 'minor' },
  マトリアーク: { type: 'minor' },
  鳥の街: { type: 'minor' },
  残骸の墓場: { type: 'minor' },
  さらされた宝箱: { type: 'minor' },
  発射台の戦利品: { type: 'minor' },
  探査機: { type: 'minor' },
  収穫の季節: { type: 'minor' },
  海岸探索: { type: 'minor' },
};

export const TRIAL_NAME_JA = {
  'Damage ARC enemies using the Deadline': 'デッドラインを使ってARCエネミーにダメージを与える',
  'Damage ARC using the Hullcracker': 'ハルクラッカーを使ってARCにダメージを与える',
  'Damage ARC enemies in the Red Lakes': '赤い池のARCエネミーにダメージを与える',
  'Damage Queens or Matriarchs': 'クイーンかマトリアークにダメージを与える',
  'Open ARC Probes': 'ARCプローブを開く',
  'Damage Flying ARC using Hullcracker': 'ハルクラッカーで空飛ぶARCにダメージ',
  'Damage Flying ARC using Snap Blast': 'スナップブラストで空飛ぶARCにダメージ',
  'Loot Bird Nests': '鳥の巣を漁る',
  "Loot bird's nests": '鳥の巣を漁る',
  'Search ARC Probes, Couriers and Assessors': 'ARCプローブ・クーリエ・アセッサーを調べる',
  'Open containers on the beach in Riven Tides': 'リブン・タイズのビーチで容器を開ける',
  'Damage ARC using a single Deadline': '1つのデッドラインでARCにダメージ',
  'Damage any ARC enemies': 'いずれかのARCにダメージ',
  'Damage flying ARC enemies': '飛行型のARCにダメージ',
  'Harvest plants': '植物を収穫',
};

/** イベントタイマーと同じ並び */
export const SERVER_REGIONS = [
  { slug: 'europe', abbr: 'EU', label: 'ヨーロッパ' },
  { slug: 'north-america', abbr: 'NA', label: '北アメリカ' },
  { slug: 'brazil', abbr: 'SA', label: '南アメリカ' },
  { slug: 'east-asia', abbr: 'AS', label: 'アジア' },
  { slug: 'oceania', abbr: 'OC', label: 'オセアニア' },
];

/** マップ選択チップの並び（イベントタイマー準拠） */
export const MAP_OPTIONS = [
  'ダム戦場',
  '埋もれた町',
  '宇宙港',
  'ブルーゲート',
  'ステラモンティス',
  'リブン・タイズ',
];

/** イベント選択チップの並び（イベントタイマー準拠） */
export const EVENT_OPTIONS = Object.keys(EVENT_DEFS);

export function mapJa(name) {
  const s = String(name || '').trim();
  if (!s) return '';
  if (MAP_NAME_JA[s]) return MAP_NAME_JA[s];
  // 既に日本語ならそのまま
  if (MAP_OPTIONS.includes(s)) return s;
  // 大文字小文字ゆれ
  const lower = s.toLowerCase();
  for (const [en, ja] of Object.entries(MAP_NAME_JA)) {
    if (en.toLowerCase() === lower) return ja;
  }
  return s;
}

export function eventJa(name) {
  return EVENT_NAME_JA[name] || name || '';
}

export function trialJa(name) {
  if (!name) return '';
  return TRIAL_NAME_JA[name] || name;
}

export function eventType(name) {
  return EVENT_DEFS[name]?.type || 'minor';
}

export function regionAbbr(slug) {
  return SERVER_REGIONS.find((r) => r.slug === slug)?.abbr || slug;
}

export function regionLabel(slug) {
  return SERVER_REGIONS.find((r) => r.slug === slug)?.label || slug;
}
