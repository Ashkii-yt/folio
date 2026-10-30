import { q } from '../db.js';
import { bad, now, HttpError } from '../util.js';
import { encrypt, decrypt } from '../secrets.js';
import { validateBaseUrl } from '../security.js';
import { complete, resolveRun } from './generate.js';
import horde from '../images/horde.js';
import pollinations from '../images/pollinations.js';
import openai from '../images/openai.js';
import cloudflare from '../images/cloudflare.js';

const ADAPTERS = { horde, pollinations, cloudflare, openai };

export const IMAGE_PROVIDERS = [
  {
    type: 'horde', label: horde.label, needsKey: false, keyHelp: 'Optional. A free personal key from aihorde.net gives you a better place in the queue and stops your images being shared with the LAION research project.',
    note: 'Volunteer-run GPUs, free forever with no account. A portrait can take from a few seconds to a few minutes depending on the queue. Prompts are seen by the volunteer workers, and images made without a personal key may be shared with LAION for research. Keep private details out of portrait prompts.',
    fields: ['key', 'model'],
  },
  {
    type: 'cloudflare', label: cloudflare.label, needsKey: true, keyHelp: 'An API token with the Workers AI permission (dash.cloudflare.com → My Profile → API Tokens).',
    note: 'Draws with FLUX.1 schnell, far sharper than the free queue services. The free Cloudflare plan includes a daily allowance (roughly a couple of hundred portraits) and needs a free Cloudflare account. Only the image description is sent.',
    fields: ['accountId', 'key', 'model'],
  },
  {
    type: 'pollinations', label: pollinations.label, needsKey: true, keyHelp: 'Pollinations asks for an API key. Create a free one on their site (see pollinations.ai).',
    note: 'Fast, good quality, free within their allowance. The prompt is sent to Pollinations.',
    fields: ['key', 'model'],
  },
  {
    type: 'openai', label: openai.label, needsKey: false, keyHelp: 'Needed for OpenAI and most hosted services. Leave empty for a local server that does not use one.',
    note: 'Works with OpenAI and any server that offers POST /images/generations. OpenAI charges per image.',
    fields: ['baseUrl', 'key', 'model', 'size'],
  },
];

const last4 = (s) => (s ? `••••${String(s).slice(-4)}` : null);
const row = () => q.get('SELECT * FROM image_config WHERE id = 1');

export function getImageConfig() {
  const r = row();
  const key = r ? decrypt(r.api_key_enc) : null;
  return {
    provider: r?.provider || 'horde',
    baseUrl: r?.base_url || '',
    model: r?.model || '',
    size: r?.size || '',
    accountId: r?.account_id || '',
    hasKey: !!key,
    keyHint: last4(key),
    remoteAck: !!r?.remote_ack,
    providers: IMAGE_PROVIDERS,
    defaults: Object.fromEntries(Object.entries(ADAPTERS).map(([k, a]) => [k, a.defaultBaseUrl])),
  };
}

export function setImageConfig(input = {}) {
  const old = row();
  const provider = input.provider ?? old?.provider ?? 'horde';
  if (!ADAPTERS[provider]) throw bad('Unknown image service.');
  let baseUrl = String(input.baseUrl ?? old?.base_url ?? '').trim();
  let scope = 'remote';
  if (baseUrl) {
    const v = validateBaseUrl(baseUrl);
    baseUrl = v.url;
    scope = v.scope;
  } else if (provider === 'openai') {
    baseUrl = ADAPTERS.openai.defaultBaseUrl;
  }
  const ack = input.remoteAck ?? !!old?.remote_ack;
  if (provider === 'openai' && scope === 'remote' && !ack) {
    throw new HttpError(409, 'This sends your portrait prompts to a service on the internet. Confirm to continue.', 'remote_ack_required');
  }
  let keyEnc = old?.api_key_enc ?? null;
  if (input.clearKey) keyEnc = null;
  else if (typeof input.apiKey === 'string' && input.apiKey.trim()) keyEnc = encrypt(input.apiKey.trim());
  // A model or size from one service means nothing to another, so switching service starts them empty.
  const switched = !!old && input.provider && input.provider !== old.provider;
  const model = String(input.model ?? (switched ? '' : old?.model) ?? '').trim().slice(0, 200);
  const size = String(input.size ?? (switched ? '' : old?.size) ?? '').trim().slice(0, 20);
  const accountId = String(input.accountId ?? old?.account_id ?? '').trim().slice(0, 64);
  if (accountId && !/^[A-Za-z0-9_-]+$/.test(accountId)) throw bad('The account ID is letters and numbers only.');
  if (size && !/^\d{2,4}x\d{2,4}$/.test(size)) throw bad('Size looks like 1024x1024.');
  q.run(
    `INSERT INTO image_config (id, provider, base_url, model, size, account_id, api_key_enc, remote_ack, updated_at)
     VALUES (1,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET provider=excluded.provider, base_url=excluded.base_url, model=excluded.model,
       size=excluded.size, account_id=excluded.account_id, api_key_enc=excluded.api_key_enc, remote_ack=excluded.remote_ack, updated_at=excluded.updated_at`,
    provider, baseUrl, model, size, accountId, keyEnc, scope === 'remote' ? !!ack : false, now()
  );
  return getImageConfig();
}

function resolved() {
  const r = row();
  const provider = r?.provider || 'horde';
  const a = ADAPTERS[provider];
  return { a, cfg: { provider, baseUrl: r?.base_url || a.defaultBaseUrl, model: r?.model || '', size: r?.size || '', accountId: r?.account_id || '', apiKey: r ? decrypt(r.api_key_enc) : null } };
}

export const STYLES = {
  illustration: { tags: 'digital illustration, clean lineart, soft colors, detailed', words: 'a polished digital illustration with clean lines and soft colours' },
  painterly: { tags: 'oil painting, painterly, visible brush strokes, rich colors', words: 'an oil painting with visible brush strokes and rich colour' },
  anime: { tags: 'anime style, detailed eyes, cel shading, vibrant', words: 'an anime-style illustration with detailed eyes and cel shading' },
  realistic: { tags: 'photograph, photorealistic, soft studio lighting, 85mm lens, shallow depth of field, detailed skin', words: 'a realistic photograph with soft studio lighting, 85mm lens, shallow depth of field' },
  fantasy: { tags: 'fantasy concept art, dramatic lighting, highly detailed, artstation', words: 'fantasy concept art with dramatic lighting and rich detail' },
  pixel: { tags: 'pixel art, 16-bit, limited palette', words: '16-bit pixel art with a limited palette' },
  ink: { tags: 'ink and watercolor sketch, expressive linework', words: 'an ink and watercolour sketch with expressive linework' },
};

/**
 * Build the prompt in the form each kind of model understands. Negative wording ("no text") goes in a negative
 * prompt where the model supports one, never in the positive prompt, where it makes models draw what it names.
 */
export function finalPrompt(prompt, style, promptStyle = 'natural') {
  const p = String(prompt || '').trim().replace(/[.\s]+$/, '');
  if (!p) throw bad('Describe how the character looks first.', 'prompt_required');
  if (p.length > 1200) throw bad('Keep the image description under 1,200 characters.');
  const st = STYLES[style] || STYLES.illustration;
  if (promptStyle === 'tags') {
    return { positive: `masterpiece, best quality, highly detailed, portrait, upper body, looking at viewer, ${p}, ${st.tags}, simple background`, negative: null };
  }
  return { positive: `A head-and-shoulders portrait, ${st.words}. ${p}. Centred composition, face clearly visible, simple softly lit background.`, negative: 'text, watermark, signature, blurry, deformed, extra fingers' };
}

export async function generatePortraits({ prompt, style, count = 2, onProgress, signal }) {
  const n = Math.max(1, Math.min(4, Number(count) || 2));
  const { a, cfg } = resolved();
  const { positive, negative } = finalPrompt(prompt, style, a.promptStyle);
  const st = STYLES[style] ? style : 'illustration';
  return { provider: a.label, prompt: positive, images: await a.generate(cfg, { prompt: positive, negative, style: st, count: n, onProgress, signal }) };
}

const WRITER = `You write prompts for an AI image generator that makes a character portrait.
Describe only what can be seen: apparent age range, build, hair, eyes, face, expression, clothing, accessories, and a hint of setting or mood. Use short comma-separated descriptive phrases, 40 to 70 words in total.
Rules: no names, no text or lettering, no quotation marks, no backstory or personality words that cannot be drawn, nothing sexual, and treat the subject as an adult unless the card clearly says otherwise (then keep it fully wholesome). Output the prompt only.`;

const clip = (s, n) => (String(s || '').length > n ? `${String(s).slice(0, n)}…` : String(s || ''));

/** Turn a character card into an image prompt with the person's text model; falls back to the card text if none is set up. */
export async function writePortraitPrompt(c, { signal } = {}) {
  const card = [
    c.name && `Name: ${c.name}`,
    c.description && `Description: ${clip(c.description, 400)}`,
    c.personality && `Personality: ${clip(c.personality, 700)}`,
    c.background && `Background: ${clip(c.background, 900)}`,
    c.speakingStyle && `Manner: ${clip(c.speakingStyle, 300)}`,
  ].filter(Boolean).join('\n');
  if (!card.trim()) throw bad('Fill in a name or description first so there is something to draw.', 'card_empty');
  const fallback = [c.description, c.personality].filter(Boolean).map((t) => clip(t, 220)).join(', ');
  let cfg;
  try {
    ({ cfg } = resolveRun(null, null));
  } catch (e) {
    if (e instanceof HttpError && (e.code === 'no_provider' || e.code === 'no_model' || e.code === 'provider_disabled')) return { prompt: fallback || c.name, fromModel: false };
    throw e;
  }
  const text = await complete(cfg, { system: WRITER, messages: [{ role: 'user', content: `Character card:\n${card}\n\nWrite the portrait prompt.` }], maxTokens: 300, temperature: 0.7, signal });
  const prompt = text.replace(/^["“'\s]+|["”'\s]+$/g, '').replace(/\s*\n+\s*/g, ' ').slice(0, 900);
  return { prompt: prompt || fallback || c.name, fromModel: !!prompt };
}
