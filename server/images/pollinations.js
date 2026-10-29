import { ProviderError } from '../providers/http.js';
import { call, sniffMime, toDataUrl } from './common.js';

/** Pollinations: simple GET that returns an image. Its API now asks for a (free) key. */
export default {
  type: 'pollinations',
  label: 'Pollinations',
  defaultBaseUrl: 'https://gen.pollinations.ai',
  async generate(cfg, { prompt, count, onProgress, signal }) {
    const out = [];
    const seed0 = Math.floor(Math.random() * 1e6);
    for (let i = 0; i < count; i++) {
      onProgress?.({ message: count > 1 ? `Drawing ${i + 1} of ${count}…` : 'Drawing…' });
      const q = new URLSearchParams({ width: '768', height: '768', seed: String(seed0 + i), safe: 'true' });
      if (cfg.model) q.set('model', cfg.model);
      const headers = cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {};
      let res;
      try {
        res = await call(`${cfg.baseUrl}/image/${encodeURIComponent(prompt)}?${q}`, { headers }, { signal, timeoutMs: 120000, key: cfg.apiKey });
      } catch (e) {
        if (e instanceof ProviderError && e.code === 'auth') {
          e.hint = 'Pollinations now asks for an API key. Get a free one from their site (see pollinations.ai) and paste it in Settings → Portraits, or switch to AI Horde, which needs none.';
        }
        throw e;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const mime = sniffMime(buf);
      if (!mime) throw new ProviderError('Pollinations did not return an image.', { code: 'bad_image' });
      out.push(toDataUrl(buf, mime));
    }
    return out;
  },
};
