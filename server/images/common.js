import { ProviderError } from '../providers/http.js';
import { validateBaseUrl } from '../security.js';

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const hostOf = (u) => {
  try {
    return new URL(u).host;
  } catch {
    return String(u);
  }
};

/** fetch with a time limit, mapping failures to errors a person can act on. */
export async function call(url, init = {}, { signal, timeoutMs = 60000, key } = {}) {
  const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  let res;
  try {
    res = await fetch(url, { ...init, signal: sig });
  } catch (e) {
    if (signal?.aborted) throw e;
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      throw new ProviderError(`No response from ${hostOf(url)} within ${Math.round(timeoutMs / 1000)}s.`, { code: 'timeout', hint: 'The image service may be busy. Try again in a minute.' });
    }
    const code = e?.cause?.code || '';
    throw new ProviderError(
      code === 'ENOTFOUND' || code === 'EAI_AGAIN' ? `Could not resolve ${hostOf(url)}.` : `Could not reach ${hostOf(url)}.`,
      { code: 'unreachable', hint: 'Check your internet connection. Image services run on the internet, so this server needs outbound access.' }
    );
  }
  if (res.ok) return res;
  let detail = '';
  try {
    const t = (await res.text()).slice(0, 600);
    try {
      const j = JSON.parse(t);
      detail = typeof j === 'string' ? j : j.error?.message || j.error || j.message || j.detail || '';
      if (typeof detail !== 'string') detail = JSON.stringify(detail);
    } catch {
      detail = t.replace(/<[^>]+>/g, ' ').trim();
    }
  } catch {
    /* no body */
  }
  if (key) detail = detail.split(key).join('[key]');
  const suffix = detail ? ` (${detail.slice(0, 240)})` : '';
  const st = res.status;
  if (st === 401 || st === 403) throw new ProviderError(`The image service rejected the credentials${suffix}`, { code: 'auth', status: st, hint: 'Check the API key in Settings → Portraits. Some services need a free key.' });
  if (st === 402) throw new ProviderError(`The image service says the account is out of credit${suffix}`, { code: 'billing', status: st });
  if (st === 429) throw new ProviderError(`The image service is rate limiting requests${suffix}`, { code: 'rate_limited', status: st, hint: 'Wait a minute and try again, or generate fewer variations at once.' });
  throw new ProviderError(`The image service returned an error (HTTP ${st})${suffix}`, { code: 'bad_request', status: st });
}

export function toDataUrl(buf, mime) {
  if (buf.length > MAX_IMAGE_BYTES) throw new ProviderError('The image service returned a file that is too large.', { code: 'too_large' });
  if (!/^image\/(png|jpeg|webp|gif)$/.test(mime)) throw new ProviderError('The image service did not return a PNG, JPEG or WebP image.', { code: 'bad_image' });
  return `data:${mime};base64,${buf.toString('base64')}`;
}

/** Identify the real image type from its first bytes rather than trusting a header. */
export function sniffMime(buf) {
  if (buf.length > 12 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.length > 12 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  if (buf.slice(0, 3).toString() === 'GIF') return 'image/gif';
  return null;
}

export const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason || new Error('aborted')); }, { once: true });
  });

/** Only follow image links that point at the public internet over https. */
export function assertPublicHttps(url) {
  let ok = false;
  try {
    ok = url.startsWith('https://') && validateBaseUrl(url).scope === 'remote';
  } catch {
    ok = false;
  }
  if (!ok) throw new ProviderError('The image service sent a link that Folio will not follow.', { code: 'bad_image' });
  return url;
}
