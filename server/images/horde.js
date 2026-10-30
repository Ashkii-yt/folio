import { ProviderError } from '../providers/http.js';
import { assertPublicHttps, call, sleep, sniffMime, toDataUrl } from './common.js';

/**
 * AI Horde: a volunteer-run network of GPUs. Free, and works without an account using the public
 * anonymous key; a free personal key from aihorde.net gets a better place in the queue.
 */
const ANON_KEY = '0000000000';
const NEGATIVE = 'lowres, worst quality, low quality, blurry, jpeg artifacts, text, watermark, signature, logo, bad anatomy, deformed, disfigured, extra fingers, extra limbs, cropped, out of frame, nsfw, nude';

/** Checkpoints that draw faces well, tried in order of availability. The person's own model choice overrides this. */
const MODELS = {
  illustration: ['Dreamshaper', 'Deliberate'],
  painterly: ['Deliberate', 'Dreamshaper'],
  anime: ['Anything Diffusion', 'Dreamshaper'],
  realistic: ['Realistic Vision', 'Deliberate'],
  fantasy: ['Dreamshaper', 'Deliberate'],
  pixel: ['stable_diffusion'],
  ink: ['Dreamshaper', 'Deliberate'],
};

export default {
  type: 'horde',
  label: 'AI Horde (free, no sign-up)',
  defaultBaseUrl: 'https://aihorde.net/api/v2',
  promptStyle: 'tags',
  async generate(cfg, { prompt, negative, style, count, onProgress, signal }) {
    const key = cfg.apiKey || ANON_KEY;
    const headers = { apikey: key, 'Client-Agent': 'folio:1:self-hosted', 'content-type': 'application/json' };
    const base = cfg.baseUrl;
    const base_body = {
      prompt: `${prompt} ### ${negative || NEGATIVE}`,
      params: { width: 512, height: 512, steps: 30, n: count, sampler_name: 'k_dpmpp_2m', cfg_scale: 7, karras: true, ...(style === 'anime' ? { clip_skip: 2 } : {}) },
      nsfw: false,
      censor_nsfw: true,
      r2: false,
      slow_workers: true,
    };
    // Best first: a good checkpoint plus face restoration. If the horde refuses an option, fall back to plainer requests.
    const picks = cfg.model ? [cfg.model] : MODELS[style] || MODELS.illustration;
    const attempts = [
      { models: picks, post_processing: ['GFPGAN'] },
      { models: picks },
      {},
    ];
    let sub = null;
    let lastErr = null;
    for (const extra of attempts) {
      try {
        sub = await call(`${base}/generate/async`, { method: 'POST', headers, body: JSON.stringify({ ...base_body, ...extra }) }, { signal, key });
        break;
      } catch (e) {
        lastErr = e;
        if (!(e instanceof ProviderError) || e.code !== 'bad_request') throw e;
      }
    }
    if (!sub) throw lastErr;
    const { id } = await sub.json();
    if (!id) throw new ProviderError('AI Horde did not accept the request.', { code: 'bad_request' });

    const cancel = () => fetch(`${base}/generate/status/${id}`, { method: 'DELETE', headers }).catch(() => {});
    const deadline = Date.now() + (cfg.maxWaitMs || 12 * 60 * 1000);
    try {
      for (;;) {
        const r = await call(`${base}/generate/check/${id}`, { headers }, { signal, key });
        const s = await r.json();
        if (s.faulted) throw new ProviderError('AI Horde could not generate the image.', { code: 'faulted', hint: 'Try again, or pick a different model.' });
        if (s.is_possible === false) throw new ProviderError('No AI Horde worker is available for this request right now.', { code: 'no_worker', hint: 'Remove the model override in Settings → Portraits, or try again later.' });
        if (s.done) break;
        onProgress?.({
          message: s.queue_position > 0 ? `Waiting in the free queue (position ${s.queue_position})` : s.processing > 0 ? 'Drawing…' : 'Waiting for a free GPU…',
          queuePosition: s.queue_position ?? null,
          waitSeconds: s.wait_time ?? null,
        });
        if (Date.now() > deadline) throw new ProviderError('The free queue is very busy and the request timed out.', { code: 'timeout', hint: 'Try again later, or add a free AI Horde key in Settings → Portraits for a better place in the queue.' });
        await sleep(Number(process.env.FOLIO_IMAGE_POLL_MS) || 2500, signal);
      }
    } catch (e) {
      cancel();
      throw e;
    }
    const st = await (await call(`${base}/generate/status/${id}`, { headers }, { signal, key })).json();
    const out = [];
    for (const g of st.generations || []) {
      if (g.censored) continue;
      let buf;
      if (/^https:\/\//.test(g.img)) {
        buf = Buffer.from(await (await call(assertPublicHttps(g.img), {}, { signal })).arrayBuffer());
      } else buf = Buffer.from(String(g.img || ''), 'base64');
      const mime = sniffMime(buf);
      if (mime) out.push(toDataUrl(buf, mime));
    }
    if (!out.length) throw new ProviderError('AI Horde returned no usable image. Its safety filter may have blocked it.', { code: 'empty', hint: 'Try different wording.' });
    return out;
  },
};
