/** 出撃ボード（共有）の取得・保存 */

export async function fetchSharedBoard() {
  const res = await fetch('/api/sorties', {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body?.error ? `: ${body.error}` : '';
    } catch {
      /* ignore */
    }
    throw new Error(`共有ボード HTTP ${res.status}${detail}`);
  }
  const json = await res.json();
  return {
    sorties: Array.isArray(json.sorties) ? json.sorties : [],
    updatedAt: Number(json.updatedAt) || 0,
  };
}

export async function pushSharedBoard(sorties) {
  const res = await fetch('/api/sorties', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ sorties }),
  });
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body?.error ? `: ${body.error}` : '';
    } catch {
      /* ignore */
    }
    throw new Error(`共有ボード保存 HTTP ${res.status}${detail}`);
  }
  const json = await res.json();
  return {
    sorties: Array.isArray(json.sorties) ? json.sorties : [],
    updatedAt: Number(json.updatedAt) || Date.now(),
  };
}
