import { defineConfig } from 'vite';

/** 開発時: /api/metaforge?url=... を Node 側で MetaForge へ中継 */
async function handleMetaforgeProxy(req, res, next) {
  if (!req.url?.startsWith('/api/metaforge')) return next();
  try {
    const u = new URL(req.url, 'http://127.0.0.1');
    const target = u.searchParams.get('url');
    if (!target) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Missing url' }));
      return;
    }
    const parsed = new URL(target);
    if (parsed.hostname !== 'metaforge.app' || !parsed.pathname.startsWith('/api/arc-raiders')) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Blocked url' }));
      return;
    }
    const upstream = await fetch(parsed.toString(), {
      headers: {
        Accept: 'application/json',
        Referer: 'https://metaforge.app/arc-raiders',
        Origin: 'https://metaforge.app',
      },
    });
    const text = await upstream.text();
    res.statusCode = upstream.status;
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
    res.end(text);
  } catch (e) {
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: String(e.message || e) }));
  }
}

function metaforgeDevProxy() {
  return {
    name: 'metaforge-dev-proxy',
    configureServer(server) {
      server.middlewares.use(handleMetaforgeProxy);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handleMetaforgeProxy);
    },
  };
}

export default defineConfig({
  plugins: [metaforgeDevProxy()],
  server: {
    port: 5174,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8788',
        changeOrigin: true,
        // metaforge は上の middleware が処理。discord だけ 8788 へ
        bypass(req) {
          if (req.url?.startsWith('/api/metaforge')) return req.url;
        },
      },
    },
  },
  preview: {
    port: 4174,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8788',
        changeOrigin: true,
        bypass(req) {
          if (req.url?.startsWith('/api/metaforge')) return req.url;
        },
      },
    },
  },
});
