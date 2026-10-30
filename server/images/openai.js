import { ProviderError } from '../providers/http.js';
import { assertPublicHttps, call, sniffMime, toDataUrl } from './common.js';

/** Any server with an OpenAI-style POST /images/generations (OpenAI itself, local Stable Diffusion gateways, many proxies). */
export default {
  type: 'openai',
  label: 'OpenAI-compatible images API',
  promptStyle: 'natural',
  defaultBaseUrl: 'https://api.openai.com/v1',
  async generate(cfg, { prompt, count, onProgress, signal }) {
    onProgress?.({ message: 'Drawing…' });
    const model = cfg.model || 'gpt-image-1';
    const body = { model, prompt, n: count, size: cfg.size || '1024x1024' };
    if (!/^gpt-image/i.test(model)) body.response_format = 'b64_json'; // gpt-image models always return base64 and reject this field
    const headers = { 'content-type': 'application/json', ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) };
    const res = await call(`${cfg.baseUrl}/images/generations`, { method: 'POST', headers, body: JSON.stringify(body) }, { signal, timeoutMs: 180000, key: cfg.apiKey });
    const j = await res.json();
    const out = [];
    for (const d of j.data || []) {
      let buf = null;
      if (d.b64_json) buf = Buffer.from(d.b64_json, 'base64');
      else if (/^https:\/\//.test(d.url || '')) buf = Buffer.from(await (await call(assertPublicHttps(d.url), {}, { signal })).arrayBuffer());
      const mime = buf && sniffMime(buf);
      if (mime) out.push(toDataUrl(buf, mime));
    }
    if (!out.length) throw new ProviderError('The images API returned no image.', { code: 'empty' });
    return out;
  },
};
