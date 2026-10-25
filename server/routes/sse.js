import { HttpError, redact, log } from '../util.js';
import { ProviderError } from '../providers/http.js';

/**
 * Start a Server-Sent Events response. Returns helpers plus an AbortSignal that fires when the
 * client disconnects (for example when the user presses Stop).
 */
export function openSse(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  const ctl = new AbortController();
  let finished = false;
  res.on('close', () => {
    if (!finished) ctl.abort();
  });
  // Local models can take a long time to load; keep proxies and the browser from timing out.
  const beat = setInterval(() => {
    if (!res.writableEnded) res.write(': keep-alive\n\n');
  }, 15000);
  const emit = (event, data) => {
    if (!res.writableEnded && !ctl.signal.aborted) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const end = () => {
    finished = true;
    clearInterval(beat);
    if (!res.writableEnded) res.end();
  };
  return { emit, end, signal: ctl.signal };
}

export function errorPayload(e) {
  if (e instanceof ProviderError || e instanceof HttpError) {
    return { message: e.message, hint: e.hint, code: e.code, retryAfter: e.retryAfter };
  }
  log('unexpected chat error:', redact(e?.stack || String(e)));
  return { message: 'Something went wrong while generating a reply.', code: 'internal' };
}

/** Run a streaming job: wires up SSE, converts thrown errors to an `error` event, always ends. */
export async function streamJob(req, res, job) {
  const { emit, end, signal } = openSse(req, res);
  try {
    await job({ emit, signal });
  } catch (e) {
    if (!signal.aborted) emit('error', errorPayload(e));
  } finally {
    end();
  }
}
