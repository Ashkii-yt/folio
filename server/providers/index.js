import ollama from './ollama.js';
import { openai, openaiCompatible } from './openai.js';
import anthropic from './anthropic.js';
import gemini from './gemini.js';
import { ProviderError } from './http.js';
import { q, tx } from '../db.js';
import { encrypt, decrypt } from '../secrets.js';
import { validateBaseUrl, validateHeaders } from '../security.js';
import { bad, notFound, uid, now, safeJson, clamp } from '../util.js';

const ADAPTERS = Object.fromEntries([ollama, openaiCompatible, openai, anthropic, gemini].map((a) => [a.type, a]));

export function getAdapter(type) {
  const a = ADAPTERS[type];
  if (!a) throw bad(`Unknown provider type "${type}".`);
  return a;
}

/** Static description of each provider type for the UI (what it supports, defaults, help text). */
export function providerTypes() {
  return Object.values(ADAPTERS).map((a) => ({
    type: a.type,
    label: a.label,
    defaultBaseUrl: a.defaultBaseUrl,
    defaultContext: a.defaultContext,
    help: a.help,
    supports: a.supports,
  }));
}

const last4 = (s) => (s ? `••••${String(s).slice(-4)}` : null);

/** Public shape: never includes the API key or header values. */
export function publicProvider(row) {
  if (!row) return null;
  const key = decrypt(row.api_key_enc);
  const headers = safeJson(decrypt(row.headers_enc), {}) || {};
  let scope = 'remote';
  try {
    scope = validateBaseUrl(row.base_url, { type: row.type }).scope;
  } catch {
    /* keep default */
  }
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    baseUrl: row.base_url,
    hasKey: !!key,
    keyHint: last4(key),
    headerNames: Object.keys(headers),
    defaultModel: row.default_model,
    contextLength: row.context_length,
    temperature: row.temperature,
    topP: row.top_p,
    topK: row.top_k,
    maxTokens: row.max_tokens,
    timeoutMs: row.timeout_ms,
    enabled: !!row.enabled,
    remoteAck: !!row.remote_ack,
    scope,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listProviders() {
  return q.all('SELECT * FROM providers ORDER BY created_at').map(publicProvider);
}

export function getProviderRow(id) {
  return q.get('SELECT * FROM providers WHERE id = ?', id);
}

/** Resolve a stored provider (plus a model) into the config object adapters use. Contains secrets. */
export function resolveConfig(row, { model } = {}) {
  const adapter = getAdapter(row.type);
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    baseUrl: row.base_url,
    apiKey: decrypt(row.api_key_enc) || '',
    headers: safeJson(decrypt(row.headers_enc), {}) || {},
    model: model || row.default_model,
    contextLength: row.context_length || null,
    effectiveContext: row.context_length || adapter.defaultContext,
    params: {
      temperature: row.temperature,
      topP: row.top_p,
      topK: adapter.supports.topK ? row.top_k : null,
      maxTokens: row.max_tokens,
    },
    timeoutMs: row.timeout_ms,
  };
}

function numberOrNull(v, lo, hi, label, int = false) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw bad(`${label} must be a number.`);
  if (n < lo || n > hi) throw bad(`${label} must be between ${lo} and ${hi}.`);
  return int ? Math.round(n) : n;
}

function validate(input, existing) {
  const type = input.type ?? existing?.type;
  const adapter = getAdapter(type);
  const name = String(input.name ?? existing?.name ?? '').trim();
  if (!name) throw bad('Give the provider a name.');
  if (name.length > 60) throw bad('Provider names can be at most 60 characters.');

  const { url, scope, warnings } = validateBaseUrl(input.baseUrl ?? existing?.base_url ?? adapter.defaultBaseUrl, { type });

  const wantsKey = adapter.supports.apiKey;
  let apiKeyEnc = existing?.api_key_enc ?? null;
  if (input.apiKey !== undefined) {
    const k = String(input.apiKey || '').trim();
    if (/[\r\n]/.test(k)) throw bad('The API key contains line breaks.');
    apiKeyEnc = k ? encrypt(k) : null;
  }
  if (input.clearApiKey) apiKeyEnc = null;
  if (wantsKey === 'required' && !apiKeyEnc) throw bad(`${adapter.label} needs an API key.`);

  let headersEnc = existing?.headers_enc ?? null;
  if (input.headers !== undefined) {
    // Blank values keep the stored value for that header so the UI never needs the secret back.
    const prev = safeJson(decrypt(existing?.headers_enc), {}) || {};
    const merged = {};
    for (const [k, v] of Object.entries(input.headers || {})) merged[k] = v === '' && k in prev ? prev[k] : v;
    const clean = validateHeaders(merged);
    headersEnc = Object.keys(clean).length ? encrypt(JSON.stringify(clean)) : null;
  }

  const remoteAck = input.remoteAck ?? !!existing?.remote_ack; // remote endpoints are gated in checked()

  return {
    name, type, baseUrl: url, apiKeyEnc, headersEnc, scope, warnings, remoteAck: scope === 'remote' ? !!remoteAck : false,
    defaultModel: String(input.defaultModel ?? existing?.default_model ?? '').trim().slice(0, 200),
    contextLength: numberOrNull(input.contextLength ?? existing?.context_length, 512, 4_000_000, 'Context length', true),
    temperature: numberOrNull(input.temperature !== undefined ? input.temperature : existing?.temperature, 0, 2, 'Temperature'),
    topP: numberOrNull(input.topP !== undefined ? input.topP : existing?.top_p, 0, 1, 'Top-p'),
    topK: numberOrNull(input.topK !== undefined ? input.topK : existing?.top_k, 1, 1000, 'Top-k', true),
    maxTokens: numberOrNull(input.maxTokens !== undefined ? input.maxTokens : existing?.max_tokens, 16, 200000, 'Max output tokens', true),
    timeoutMs: clamp(Math.round(Number(input.timeoutMs ?? existing?.timeout_ms ?? 120000)) || 120000, 5000, 1_800_000),
  };
}

function checked(input, existing) {
  const type = input.type ?? existing?.type;
  const adapter = getAdapter(type);
  const { scope } = validateBaseUrl(input.baseUrl ?? existing?.base_url ?? adapter.defaultBaseUrl, { type });
  const ack = input.remoteAck ?? !!existing?.remote_ack;
  if (scope === 'remote' && !ack) {
    throw bad(
      'This endpoint is on the internet, so your messages and the character\'s memories will be sent to a third party. Confirm that you understand this to save it.',
      'remote_ack_required'
    );
  }
  return validate({ ...input, remoteAck: ack }, existing);
}

export function createProvider(input) {
  const v = checked(input, null);
  const id = uid();
  const t = now();
  q.run(
    `INSERT INTO providers (id, name, type, base_url, api_key_enc, headers_enc, default_model, context_length,
       temperature, top_p, top_k, max_tokens, timeout_ms, enabled, remote_ack, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, v.name, v.type, v.baseUrl, v.apiKeyEnc, v.headersEnc, v.defaultModel, v.contextLength,
    v.temperature, v.topP, v.topK, v.maxTokens, v.timeoutMs, input.enabled ?? true, v.remoteAck, t, t
  );
  return { provider: publicProvider(getProviderRow(id)), warnings: v.warnings };
}

export function updateProvider(id, input) {
  const existing = getProviderRow(id);
  if (!existing) throw notFound('Provider');
  if (input.type && input.type !== existing.type) throw bad('A provider\'s type cannot be changed. Add a new provider instead.');
  const v = checked({ ...input, type: existing.type }, existing);
  q.run(
    `UPDATE providers SET name=?, base_url=?, api_key_enc=?, headers_enc=?, default_model=?, context_length=?,
       temperature=?, top_p=?, top_k=?, max_tokens=?, timeout_ms=?, enabled=?, remote_ack=?, updated_at=? WHERE id=?`,
    v.name, v.baseUrl, v.apiKeyEnc, v.headersEnc, v.defaultModel, v.contextLength, v.temperature, v.topP, v.topK,
    v.maxTokens, v.timeoutMs, input.enabled ?? !!existing.enabled, v.remoteAck, now(), id
  );
  return { provider: publicProvider(getProviderRow(id)), warnings: v.warnings };
}

export function deleteProvider(id) {
  if (!getProviderRow(id)) throw notFound('Provider');
  tx(() => {
    q.run('DELETE FROM providers WHERE id = ?', id);
    const s = q.get("SELECT value FROM settings WHERE key = 'defaultProviderId'");
    if (s && safeJson(s.value) === id) q.run("DELETE FROM settings WHERE key = 'defaultProviderId'");
  });
}

/** Build a config from unsaved form values, falling back to the stored key for an existing provider. */
export function draftConfig(input) {
  const existing = input.id ? getProviderRow(input.id) : null;
  if (input.id && !existing) throw notFound('Provider');
  const type = input.type ?? existing?.type;
  const adapter = getAdapter(type);
  const { url } = validateBaseUrl(input.baseUrl ?? existing?.base_url ?? adapter.defaultBaseUrl, { type });
  const prevHeaders = safeJson(decrypt(existing?.headers_enc), {}) || {};
  const headers = {};
  for (const [k, v] of Object.entries(input.headers || prevHeaders)) headers[k] = v === '' && k in prevHeaders ? prevHeaders[k] : v;
  return {
    id: existing?.id || null,
    name: input.name || existing?.name || adapter.label,
    type,
    baseUrl: url,
    apiKey: input.apiKey ? String(input.apiKey).trim() : decrypt(existing?.api_key_enc) || '',
    headers: validateHeaders(headers),
    model: String(input.model ?? input.defaultModel ?? existing?.default_model ?? '').trim(),
    contextLength: null,
    effectiveContext: adapter.defaultContext,
    params: {},
    timeoutMs: clamp(Math.round(Number(input.timeoutMs ?? existing?.timeout_ms ?? 30000)) || 30000, 3000, 120000),
  };
}

export async function discoverModels(cfg, opts) {
  const adapter = getAdapter(cfg.type);
  if (adapter.supports.apiKey === 'required' && !cfg.apiKey) {
    throw new ProviderError(`${adapter.label} needs an API key before models can be listed.`, { code: 'auth' });
  }
  return adapter.listModels(cfg, opts);
}

/** Connection test: list models; if the server has no model list, send a tiny generation instead. */
export async function testConnection(cfg) {
  const adapter = getAdapter(cfg.type);
  const started = Date.now();
  try {
    if (adapter.supports.apiKey === 'required' && !cfg.apiKey) {
      throw new ProviderError(`${adapter.label} needs an API key.`, { code: 'auth' });
    }
    let models = null;
    let listError = null;
    try {
      models = await adapter.listModels(cfg);
    } catch (e) {
      if (!(e instanceof ProviderError) || !['not_found', 'bad_response', 'http_error', 'bad_request'].includes(e.code) || !cfg.model) throw e;
      listError = e;
    }
    if (models) {
      const found = cfg.model ? models.some((m) => m.id === cfg.model || m.id === `${cfg.model}:latest`) : null;
      return {
        ok: true,
        latencyMs: Date.now() - started,
        models,
        modelFound: found,
        message:
          found === false
            ? `Connected, but "${cfg.model}" is not in the server's model list (${models.length} models available).`
            : `Connected. ${models.length} model${models.length === 1 ? '' : 's'} available.`,
      };
    }
    // No model list: prove the model answers.
    let text = '';
    for await (const ev of adapter.stream({ ...cfg, params: { maxTokens: 16 } }, { system: '', messages: [{ role: 'user', content: 'Reply with the single word: ok' }] })) {
      if (ev.type === 'delta') text += ev.text;
    }
    return {
      ok: true,
      latencyMs: Date.now() - started,
      models: [],
      modelFound: true,
      message: `Connected. This server has no model list (${listError.message}), but "${cfg.model}" answered a test message.`,
    };
  } catch (e) {
    if (e instanceof ProviderError) {
      return { ok: false, latencyMs: Date.now() - started, message: e.message, hint: e.hint, code: e.code };
    }
    throw e;
  }
}

export { ProviderError };
