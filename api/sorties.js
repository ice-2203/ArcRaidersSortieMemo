import { loadBoard, saveMergedBoard } from '../lib/sortie-board.js';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,PUT,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return null;
  return JSON.parse(raw);
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    setCors(res);
    res.setHeader('Access-Control-Max-Age', '86400');
    res.status(204).end();
    return;
  }

  setCors(res);

  try {
    if (req.method === 'GET') {
      const board = await loadBoard();
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json(board);
      return;
    }

    if (req.method === 'PUT') {
      const body = await readJsonBody(req);
      if (!body) {
        res.status(400).json({ error: 'Invalid JSON' });
        return;
      }
      // sortie / member 単位でサーバーが最新を採用してマージ保存
      const board = await saveMergedBoard(body);
      res.status(200).json(board);
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('[sorties]', e);
    res.status(500).json({ error: String(e.message || e) });
  }
}
