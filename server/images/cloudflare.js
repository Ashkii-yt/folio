import { ProviderError } from '../providers/http.js';
import { call, sniffMime, toDataUrl } from './common.js';

/**
 * Cloudflare Workers AI: FLUX.1 [schnell] by default. The free plan includes a daily allowance of neurons
 * (about 10,000 at the time of writing, which is a couple of hundred portraits) and needs a free Cloudflare
 * account, its account ID, and an API token with the "Workers AI" permission.
 */
export default {
  type: 'cloudflare',
  label: 'Cloudflare Workers AI (free daily allowance, best quality)',
  defaultBaseUrl: 'https://api.cloudflare.com/client/v4',
  promptStyle: 'natural',
  async generate(cfg, { prompt, negative, count, onProgress, signal }) {
    if (!cfg.accountId) throw new ProviderError('Enter your Cloudflare account ID in Settings → Portraits.', { code: 'auth' });
    if (!cfg.apiKey) throw new ProviderError('Enter a Cloudflare API token in Settings → Portraits.', { code: 'auth' });
    const model = cfg.model || '@cf/black-forest-labs/flux-1-schnell';
    const flux = /flux/i.test(model);
    const out = [];
    for (let i = 0; i < count; i++) {
      onProgress?.({ message: count > 1 ? `Drawing ${i + 1} of ${count}…` : 'Drawing…' });
      const seed = Math.floor(Math.random() * 4294967295);
      const body = flux ? { prompt, steps: 6, seed } : { prompt, negative_prompt: negative, width: 768, height: 768, num_steps: 20, seed };
      const res = await call(
        `${cfg.baseUrl}/accounts/${encodeURIComponent(cfg.accountId)}/ai/run/${model}`,
        { method: 'POST', headers: { Authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(body) },
        { signal, timeoutMs: 120000, key: cfg.apiKey }
      );
      let buf;
      if ((res.headers.get('content-type') || '').startsWith('image/')) buf = Buffer.from(await res.arrayBuffer());
      else {
        const j = await res.json();
        const b64 = j.result?.image ?? j.image;
        if (!b64) throw new ProviderError('Cloudflare returned no image.', { code: 'empty', hint: j.errors?.[0]?.message });
        buf = Buffer.from(b64, 'base64');
      }
      const mime = sniffMime(buf);
      if (!mime) throw new ProviderError('Cloudflare did not return an image.', { code: 'bad_image' });
      out.push(toDataUrl(buf, mime));
    }
    return out;
  },
};
