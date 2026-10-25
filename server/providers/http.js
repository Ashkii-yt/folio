import { redact } from '../util.js';

export class ProviderError extends Error {
  constructor(message, { code = 'provider_error', status, hint, retryAfter } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.status = status;
    this.hint = hint;
    this.retryAfter = retryAfter;
  }
}

export const isAbort = (e) => e?.name === 'AbortError' || e?.code === 'aborted';

const secretsOf = (cfg) => [cfg.apiKey, ...Object.values(cfg.headers || {})].filter(Boolean);

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function networkError(e, cfg, url, timedOut) {
  if (timedOut) {
    return new ProviderError(`No response from ${hostOf(url)} within ${Math.round(cfg.timeoutMs / 1000)}s.`, {
      code: 'timeout',
      hint:
        cfg.type === 'ollama'
          ? 'Local models can take a while to load on first use. Raise the request timeout in the provider settings, or check that the model fits in memory.'
          : 'Raise the request timeout in the provider settings, or check the provider status page.',
    });
  }
  const code = e?.cause?.code || e?.code || '';
  const host = hostOf(url);
  if (code === 'ECONNREFUSED') {
    const ollama = cfg.type === 'ollama';
    return new ProviderError(`Connection refused by ${host}. Nothing is listening at that address.`, {
      code: 'unreachable',
      hint: ollama
        ? 'Start Ollama (run `ollama serve` or open the Ollama app). If Ollama runs on another machine, use that machine\'s address, not 127.0.0.1 (127.0.0.1 means the machine running Folio), and start it with OLLAMA_HOST=0.0.0.0 so it accepts network connections.'
        : 'Check the base URL and port, and make sure the server is running.',
    });
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new ProviderError(`Could not resolve the hostname "${host}".`, {
      code: 'unreachable',
      hint: 'Check the spelling of the address and your network connection.',
    });
  }
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET' || code === 'EPIPE') {
    return new ProviderError(`The connection to ${host} was closed unexpectedly.`, {
      code: 'connection_lost',
      hint: 'The server may have crashed or run out of memory while loading the model. Check its logs.',
    });
  }
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
    return new ProviderError(`Could not reach ${host}.`, {
      code: 'unreachable',
      hint: 'The host may be offline, behind a firewall, or not exposed to your network.',
    });
  }
  if (/bad port/i.test(e?.cause?.message || e?.message || '')) {
    return new ProviderError(`Port ${new URL(url).port || '(default)'} on ${host.replace(/:\d+$/, '')} is blocked by Node's network stack.`, {
      code: 'bad_port',
      hint: 'Fetch refuses a short list of ports reserved for other protocols (for example 9, 25, 110, 143, 6000). Run the model server on a different port.',
    });
  }
  if (/CERT|SSL|TLS/i.test(code) || /certificate/i.test(e?.cause?.message || '')) {
    return new ProviderError(`TLS certificate problem talking to ${host}: ${e.cause?.message || code}.`, {
      code: 'tls',
      hint: 'If this is a self-hosted server with a private certificate, use http:// on a trusted network or install a trusted certificate.',
    });
  }
  return new ProviderError(`Request to ${host} failed: ${redact(e?.cause?.message || e?.message || 'unknown error', secretsOf(cfg))}`, {
    code: 'network',
  });
}

function bodyMessage(text) {
  if (!text) return '';
  try {
    const j = JSON.parse(text);
    if (typeof j === 'string') return j;
    if (typeof j.error === 'string') return j.error;
    if (j.error?.message) return j.error.message;
    if (j.message) return j.message;
    if (j.detail) return typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail);
  } catch {
    /* not JSON */
  }
  return text.slice(0, 300);
}

function httpError(res, bodyText, cfg, what) {
  const detail = redact(bodyMessage(bodyText), secretsOf(cfg));
  const status = res.status;
  const retryAfter = res.headers.get('retry-after') || undefined;
  const ollama = cfg.type === 'ollama';
  const suffix = detail ? ` (${detail})` : '';
  if (status === 401 || status === 403) {
    return new ProviderError(`The provider rejected the credentials${suffix}`, {
      code: 'auth', status,
      hint: ollama
        ? 'Remote/cloud Ollama endpoints usually need an API key or a proxy that adds one. Check the API key and any custom headers.'
        : 'Check the API key (and that it has access to this model), then run the connection test again.',
    });
  }
  if (status === 404) {
    const model = cfg.model || 'the selected model';
    return new ProviderError(
      ollama ? `Model "${model}" was not found on this Ollama server${suffix}` : `Not found${suffix}`,
      {
        code: 'not_found', status,
        hint: ollama
          ? `Install it with \`ollama pull ${model}\`, or pick one of the discovered models in the provider settings.`
          : `Check the model name and the base URL. ${what === 'models' ? 'This server may not expose a model list; enter the model name manually.' : ''}`.trim(),
      }
    );
  }
  if (status === 429) {
    return new ProviderError(`Rate limited by the provider${suffix}`, {
      code: 'rate_limited', status, retryAfter,
      hint: retryAfter ? `Try again in about ${retryAfter}s.` : 'Wait a moment and try again, or check your plan limits.',
    });
  }
  if (status === 400 && /context|token|too long|maximum/i.test(detail)) {
    return new ProviderError(`The prompt is larger than the model accepts${suffix}`, {
      code: 'context_length', status,
      hint: 'Lower the context length setting for this provider, or reduce the memory budget in Settings → Memory.',
    });
  }
  if (status === 400) {
    return new ProviderError(`The provider rejected the request${suffix}`, { code: 'bad_request', status });
  }
  if (status === 402) {
    return new ProviderError(`The provider reports a billing problem${suffix}`, { code: 'billing', status });
  }
  if (status >= 500) {
    return new ProviderError(`The provider had a server error (HTTP ${status})${suffix}`, {
      code: 'server_error', status,
      hint: status === 503 || status === 529 ? 'The service may be overloaded. Try again shortly.' : undefined,
    });
  }
  return new ProviderError(`Unexpected response from the provider: HTTP ${status}${suffix}`, { code: 'http_error', status });
}

function linkSignal(outer, ctl) {
  if (!outer) return () => {};
  if (outer.aborted) {
    ctl.abort(outer.reason);
    return () => {};
  }
  const on = () => ctl.abort(outer.reason);
  outer.addEventListener('abort', on, { once: true });
  return () => outer.removeEventListener('abort', on);
}

/**
 * Open an HTTP request. The timeout covers connecting and receiving response headers only;
 * long-running streams are guarded separately by an idle timer in iterateBody().
 */
export async function open(cfg, url, { method = 'GET', headers = {}, body, signal, what } = {}) {
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, cfg.timeoutMs);
  const unlink = linkSignal(signal, ctl);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { ...(cfg.headers || {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      signal: ctl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    unlink();
    if (!timedOut && (signal?.aborted || isAbort(e))) {
      const err = new Error('aborted');
      err.name = 'AbortError';
      err.code = 'aborted';
      throw err;
    }
    throw networkError(e, cfg, url, timedOut);
  }
  clearTimeout(timer);
  if (!res.ok) {
    let text = '';
    try {
      text = (await res.text()).slice(0, 4000);
    } catch {
      /* ignore */
    }
    unlink();
    throw httpError(res, text, cfg, what);
  }
  return { res, abort: () => ctl.abort(), done: unlink };
}

export async function getJson(cfg, url, opts = {}) {
  const { res, done } = await open(cfg, url, opts);
  try {
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new ProviderError(`${hostOf(url)} did not return JSON. Is this the right base URL?`, {
        code: 'bad_response',
        hint: 'The base URL should point at the API itself (for example ending in /v1), not a web page.',
      });
    }
  } finally {
    done();
  }
}

/** Yield raw body chunks, aborting if the server goes silent for cfg.timeoutMs. */
export async function* iterateBody(cfg, handle, signal) {
  const reader = handle.res.body.getReader();
  let idle = false;
  let timer;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      idle = true;
      handle.abort();
      reader.cancel().catch(() => {});
    }, cfg.timeoutMs);
  };
  try {
    for (;;) {
      arm();
      let chunk;
      try {
        chunk = await reader.read();
      } catch (e) {
        if (idle) throw networkError(e, cfg, cfg.baseUrl, true);
        if (signal?.aborted || isAbort(e)) {
          const err = new Error('aborted');
          err.name = 'AbortError';
          err.code = 'aborted';
          throw err;
        }
        throw networkError(e, cfg, cfg.baseUrl, false);
      }
      if (idle) throw networkError(new Error('idle'), cfg, cfg.baseUrl, true);
      if (chunk.done) return;
      yield chunk.value;
    }
  } finally {
    clearTimeout(timer);
    handle.done();
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
}

export async function* lines(cfg, handle, signal) {
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of iterateBody(cfg, handle, signal)) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      yield buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
    }
  }
  buf += dec.decode();
  if (buf) yield buf.replace(/\r$/, '');
}

/** Parse Server-Sent Events into { event, data } objects. */
export async function* sse(cfg, handle, signal) {
  let event = null;
  let data = [];
  for await (const line of lines(cfg, handle, signal)) {
    if (line === '') {
      if (data.length) yield { event, data: data.join('\n') };
      event = null;
      data = [];
    } else if (line.startsWith(':')) {
      continue;
    } else if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      data.push(line.slice(5).replace(/^ /, ''));
    }
  }
  if (data.length) yield { event, data: data.join('\n') };
}

export function parseJsonLoose(text, cfg, what = 'stream') {
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError(`The provider sent a malformed ${what} chunk. Is the base URL pointing at the right API?`, {
      code: 'bad_response',
    });
  }
}
