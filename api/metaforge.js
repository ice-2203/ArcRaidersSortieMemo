/** MetaForge プロキシ: /api/metaforge?url=<encoded metaforge url> */

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    setCors(res);
    res.setHeader('Access-Control-Max-Age', '86400');
    res.status(204).end();
    return;
  }

  if (req.method !== 'GET') {
    setCors(res);
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const target = req.query?.url;
  if (!target || typeof target !== 'string') {
    setCors(res);
    res.status(400).json({ error: 'Missing url' });
    return;
  }

  let u;
  try {
    u = new URL(target);
  } catch {
    setCors(res);
    res.status(400).json({ error: 'Invalid url' });
    return;
  }

  if (u.protocol !== 'https:' || u.hostname !== 'metaforge.app') {
    setCors(res);
    res.status(400).json({ error: 'Blocked host' });
    return;
  }
  if (!u.pathname.startsWith('/api/arc-raiders')) {
    setCors(res);
    res.status(400).json({ error: 'Blocked path' });
    return;
  }

  setCors(res);
  res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');

  try {
    const upstream = await fetch(u.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Referer: 'https://metaforge.app/arc-raiders',
        Origin: 'https://metaforge.app',
        'User-Agent': 'ArcRaidersSortieMemo/0.1',
      },
      redirect: 'follow',
    });
    const text = await upstream.text();
    const ct = upstream.headers.get('content-type') || '';
    if (!upstream.ok || ct.includes('text/html')) {
      res.status(upstream.ok ? 502 : upstream.status).json({
        error: `MetaForge ${upstream.status}`,
        detail: text.slice(0, 200),
      });
      return;
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).send(text);
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
}
