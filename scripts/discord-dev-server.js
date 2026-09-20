import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBoard, saveMergedBoard } from '../lib/sortie-board.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const envPath = resolve(root, '.env.local');
const envExample = resolve(root, '.env');

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  const text = readFileSync(path, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] == null) process.env[key] = val;
  }
}

loadEnvFile(envPath);
loadEnvFile(envExample);

const PORT = Number(process.env.PORT || 8788);

async function fetchGuildMembers() {
  const token = process.env.DISCORD_BOT_TOKEN;
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!token || !guildId) {
    const err = new Error('DISCORD_BOT_TOKEN / DISCORD_GUILD_ID が未設定です');
    err.status = 503;
    throw err;
  }

  const members = [];
  let after = '0';
  for (let i = 0; i < 20; i++) {
    const url = `https://discord.com/api/v10/guilds/${guildId}/members?limit=1000&after=${after}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bot ${token}` },
    });
    if (!res.ok) {
      const body = await res.text();
      const err = new Error(`Discord API ${res.status}: ${body.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    const batch = await res.json();
    if (!Array.isArray(batch) || !batch.length) break;
    for (const row of batch) {
      const user = row.user;
      if (!user || user.bot) continue;
      const avatar = user.avatar
        ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`
        : `https://cdn.discordapp.com/embed/avatars/${Number(BigInt(user.id) >> 22n) % 6n}.png`;
      members.push({
        discordId: user.id,
        name: row.nick || user.global_name || user.username,
        username: user.username,
        avatarUrl: avatar,
      });
    }
    after = batch[batch.length - 1].user.id;
    if (batch.length < 1000) break;
  }

  members.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  return members;
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return null;
  return JSON.parse(raw);
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,PUT,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url?.startsWith('/api/sorties')) {
    try {
      if (req.method === 'GET') {
        const board = await loadBoard();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(board));
        return;
      }
      if (req.method === 'PUT') {
        const body = await readJsonBody(req);
        const board = await saveMergedBoard(body || {});
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(board));
        return;
      }
      res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }

  if (req.url?.startsWith('/api/discord-members') && req.method === 'GET') {
    try {
      const members = await fetchGuildMembers();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ members }));
    } catch (e) {
      const status = e.status || 500;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[sortie-memo] API http://127.0.0.1:${PORT}`);
});
