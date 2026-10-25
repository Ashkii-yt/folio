export class ApiError extends Error {
  constructor(message, { code, hint, status } = {}) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.status = status;
  }
}

const OFFLINE = new ApiError("Can't reach Folio's server.", {
  code: 'offline',
  hint: 'Make sure the Folio server is still running (npm start), then try again.',
});

async function readError(res) {
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* not JSON */
  }
  const e = data?.error || {};
  return new ApiError(e.message || `Request failed (HTTP ${res.status}).`, { code: e.code, hint: e.hint, status: res.status });
}

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw OFFLINE;
  }
  if (!res.ok) throw await readError(res);
  if (res.status === 204) return null;
  return res.json();
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, b = {}) => request('POST', p, b),
  patch: (p, b) => request('PATCH', p, b),
  put: (p, b) => request('PUT', p, b),
  del: (p) => request('DELETE', p),
};

/**
 * POST and read a Server-Sent Events stream. Calls onEvent(name, data) for each event.
 * Resolves when the stream ends; rejects only for request-level failures (not for `error` events).
 */
export async function stream(path, body, { onEvent, signal } = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') return;
    throw OFFLINE;
  }
  if (!res.ok) throw await readError(res);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = block.match(/^event: (.*)$/m)?.[1];
        const data = block.match(/^data: (.*)$/m)?.[1];
        if (ev && data) onEvent?.(ev, JSON.parse(data));
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') return;
    throw new ApiError('The connection to Folio was interrupted.', { code: 'interrupted', hint: 'The reply may be incomplete. Try again.' });
  }
}

export function download(path) {
  const a = document.createElement('a');
  a.href = `/api${path}`;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export async function uploadJson(file) {
  const text = await file.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError('That file is not valid JSON.');
  }
}
