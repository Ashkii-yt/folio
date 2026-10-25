import { open, getJson, sse, parseJsonLoose, ProviderError } from './http.js';
import { normalizeMessages, BASE_SUPPORTS } from './normalize.js';

const authHeaders = (cfg) => (cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {});

/** OpenAI reasoning-style models reject non-default sampling parameters. */
const isReasoningModel = (id) => /^(o\d|gpt-5)/i.test(id || '');

async function listModels(cfg, { signal } = {}) {
  const data = await getJson(cfg, `${cfg.baseUrl}/models`, { headers: authHeaders(cfg), signal, what: 'models' });
  const list = Array.isArray(data) ? data : data.data || data.models || [];
  return list
    .map((m) => (typeof m === 'string' ? { id: m, label: m } : { id: m.id || m.name, label: m.id || m.name }))
    .filter((m) => m.id)
    .sort((a, b) => a.id.localeCompare(b.id));
}

function makeStream(official) {
  return async function* stream(cfg, { system, messages, signal }) {
    const msgs = normalizeMessages(messages);
    const body = {
      model: cfg.model,
      stream: true,
      messages: [...(system ? [{ role: 'system', content: system }] : []), ...msgs],
    };
    const reasoning = official && isReasoningModel(cfg.model);
    if (!reasoning) {
      if (cfg.params.temperature != null) body.temperature = cfg.params.temperature;
      if (cfg.params.topP != null) body.top_p = cfg.params.topP;
    }
    if (cfg.params.maxTokens != null) body[official ? 'max_completion_tokens' : 'max_tokens'] = cfg.params.maxTokens;
    if (official) body.stream_options = { include_usage: true };

    const handle = await open(cfg, `${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...authHeaders(cfg) },
      body,
      signal,
    });

    let usage = {};
    let finish = null;
    for await (const ev of sse(cfg, handle, signal)) {
      if (ev.data === '[DONE]') break;
      const j = parseJsonLoose(ev.data, cfg, 'OpenAI-style');
      if (j.error) {
        throw new ProviderError(`The provider reported an error: ${j.error.message || JSON.stringify(j.error)}`, {
          code: 'provider_error',
        });
      }
      const choice = j.choices?.[0];
      const text = choice?.delta?.content;
      if (typeof text === 'string' && text) yield { type: 'delta', text };
      if (choice?.finish_reason) finish = choice.finish_reason;
      if (j.usage) usage = { inputTokens: j.usage.prompt_tokens, outputTokens: j.usage.completion_tokens };
    }
    yield { type: 'done', usage, finishReason: finish };
  };
}

const common = {
  ...BASE_SUPPORTS,
  temperature: true,
  topP: true,
  maxTokens: true,
};

export const openaiCompatible = {
  type: 'openai-compatible',
  label: 'OpenAI-compatible',
  defaultBaseUrl: 'http://127.0.0.1:1234/v1',
  defaultContext: 8192,
  help:
    'Works with servers that implement the OpenAI Chat Completions API (LM Studio, llama.cpp, vLLM, OpenRouter, Together, Groq, and others). ' +
    'The base URL usually ends in /v1. Context length is used only to size Folio\'s prompt; it is not sent to the server.',
  supports: { ...common, apiKey: 'optional' },
  listModels,
  stream: makeStream(false),
};

export const openai = {
  type: 'openai',
  label: 'OpenAI',
  defaultBaseUrl: 'https://api.openai.com/v1',
  defaultContext: 32768,
  help:
    'Uses the official OpenAI API. Context length is used only to size Folio\'s prompt. ' +
    'Reasoning models (o-series, gpt-5) ignore temperature and top-p, so Folio does not send them.',
  supports: { ...common, apiKey: 'required' },
  listModels,
  stream: makeStream(true),
};
