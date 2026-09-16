/**
 * Gist / ローカルファイル → Supabase へ共有ボードを手動移行
 *
 * 使い方:
 *   1. .env.local に SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY を設定
 *   2. supabase/sortie_board.sql を SQL Editor で実行済みであること
 *   3. （任意）SORTIE_BOARD_GIST_ID / SORTIE_GITHUB_TOKEN も残す
 *   4. npm run migrate:supabase
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBoard, saveBoard, isSupabaseConfigured, sanitizeBoard } from '../lib/sortie-board.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  const text = readFileSync(path, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[m[1]] == null) process.env[m[1]] = val;
  }
}

loadEnvFile(resolve(root, '.env.local'));
loadEnvFile(resolve(root, '.env'));

if (!isSupabaseConfigured()) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です');
  process.exit(1);
}

const board = sanitizeBoard(await loadBoard());
const saved = await saveBoard(board);
console.log(
  `移行完了: sorties=${saved.sorties.length} members=${saved.members.length} updatedAt=${saved.updatedAt}`
);
