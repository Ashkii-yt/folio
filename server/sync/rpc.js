import { PROTOCOL } from './tables.js';

/**
 * Tiny request/response protocol over any duplex byte stream (a DHT connection, or ssh's stdin/stdout).
 * One JSON message per line, each starting with "FOLIO1 " so login banners and other noise are ignored.
 */
const PREFIX = 'FOLIO1 ';
const MAX_LINE = 96 * 1024 * 1024;

export class SyncError extends Error {
  constructor(message, hint) {
    super(message);
    this.hint = hint;
  }
}

function lines(onLine) {
  let buf = '';
  return (chunk) => {
    buf += chunk.toString('utf8');
    if (buf.length > MAX_LINE) throw new SyncError('The other side sent a message that is too large.');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (l.startsWith(PREFIX)) onLine(l.slice(PREFIX.length));
    }
  };
}

const send = (w, obj) => w.write(`${PREFIX}${JSON.stringify(obj)}\n`);

/** Client side. `read` and `write` are the two ends of the stream (same object for a duplex socket). */
export function rpcClient(read, write, { onClose } = {}) {
  let n = 0;
  const waiting = new Map();
  let closed = false;
  const fail = (e) => {
    closed = true;
    for (const w of waiting.values()) w.reject(e);
    waiting.clear();
  };
  read.on('data', lines((l) => {
    let m;
    try { m = JSON.parse(l); } catch { return; }
    const w = waiting.get(m.id);
    if (!w) return;
    waiting.delete(m.id);
    if (m.e) w.reject(new SyncError(m.e.message, m.e.hint));
    else w.resolve(m.r);
  }));
  read.on('error', (e) => fail(new SyncError(`Connection lost (${e.message}).`)));
  read.on('close', () => { fail(new SyncError('The connection closed before the server answered.')); onClose?.(); });
  return {
    call(method, params = {}) {
      if (closed) return Promise.reject(new SyncError('The connection is closed.'));
      const id = ++n;
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        try { send(write, { id, m: method, p: params }); } catch (e) { waiting.delete(id); reject(e); }
      });
    },
    close() { try { write.end?.(); } catch { /* ignore */ } try { read.destroy?.(); } catch { /* ignore */ } },
  };
}

/** Server side. `handle(method, params)` may be async and may throw. Requests are answered in order. */
export function rpcServe(read, write, handle) {
  let chain = Promise.resolve();
  read.on('data', lines((l) => {
    chain = chain.then(async () => {
      let m;
      try { m = JSON.parse(l); } catch { return; }
      try {
        send(write, { id: m.id, r: (await handle(m.m, m.p || {})) ?? null });
      } catch (e) {
        send(write, { id: m.id, e: { message: e?.message || 'Failed', hint: e?.hint } });
      }
    }).catch(() => {});
  }));
  read.on('error', () => {});
}

export { PROTOCOL };
