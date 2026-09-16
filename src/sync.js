/** 出撃ボード（共有）の取得・保存 */

export class BoardSyncError extends Error {
  constructor(message, { status = 0, retryable = false } = {}) {
    super(message);
    this.name = 'BoardSyncError';
    this.status = status;
    this.retryable = retryable;
  }
}

function isRetryableStatus(status) {
  return status === 403 || status === 429 || status === 502 || status === 503 || status === 504;
}

async function readErrorDetail(res) {
  try {
    const body = await res.json();
    return body?.error ? String(body.error) : '';
  } catch {
    return '';
  }
}

export async function fetchSharedBoard() {
  const res = await fetch('/api/sorties', {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    const detail = await readErrorDetail(res);
    throw new BoardSyncError(`共有ボード取得 HTTP ${res.status}${detail ? `: ${detail}` : ''}`, {
      status: res.status,
      retryable: isRetryableStatus(res.status),
    });
  }
  const json = await res.json();
  return {
    sorties: Array.isArray(json.sorties) ? json.sorties : [],
    members: Array.isArray(json.members) ? json.members : [],
    updatedAt: Number(json.updatedAt) || 0,
  };
}

export async function pushSharedBoard({ sorties, members }) {
  const res = await fetch('/api/sorties', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ sorties, members }),
  });
  if (!res.ok) {
    const detail = await readErrorDetail(res);
    const retryable = isRetryableStatus(res.status) || /rate limit/i.test(detail);
    throw new BoardSyncError(`共有ボード保存 HTTP ${res.status}${detail ? `: ${detail}` : ''}`, {
      status: res.status,
      retryable,
    });
  }
  const json = await res.json();
  return {
    sorties: Array.isArray(json.sorties) ? json.sorties : [],
    members: Array.isArray(json.members) ? json.members : [],
    updatedAt: Number(json.updatedAt) || Date.now(),
  };
}
