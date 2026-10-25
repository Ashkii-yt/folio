import { open, getJson, sse, parseJsonLoose, ProviderError } from './http.js';
import { normalizeMessages, BASE_SUPPORTS } from './normalize.js';

const VERSION = '2023-06-01';

const headers = (cfg) => ({ 'x-api-key': cfg.apiKey || '', 'anthropic-version': VERSION });

export default {
  type: 'anthropic',
  label: 'Anthropic',
  defaultBaseUrl: 'https://api.anthropic.com',
  defaultContext: 200000,
  help:
    'Uses the Anthropic Messages API (its own format, not OpenAI-compatible). ' +
    'If both temperature and top-p are set, only temperature is sent. Context length is used only to size Folio\'s prompt.',
  supports: {
    ...BASE_SUPPORTS,
    temperature: true,
    topP: true,
    topK: true,
    maxTokens: true,
    apiKey: 'required',
  },

  async listModels(cfg, { signal } = {}) {
    const data = await getJson(cfg, `${cfg.baseUrl}/v1/models?limit=1000`, { headers: headers(cfg), signal, what: 'models' });
    return (data.data || []).map((m) => ({ id: m.id, label: m.display_name ? `${m.display_name}` : m.id, detail: m.id }));
  },

  async *stream(cfg, { system, messages, signal }) {
    const msgs = normalizeMessages(messages, { requireUserFirst: true, merge: true });
    const body = {
      model: cfg.model,
      max_tokens: cfg.params.maxTokens || 2048, // required by this API
      stream: true,
      messages: msgs,
    };
    if (system) body.system = system;
    if (cfg.params.temperature != null) body.temperature = cfg.params.temperature;
    else if (cfg.params.topP != null) body.top_p = cfg.params.topP;
    if (cfg.params.topK != null) body.top_k = cfg.params.topK;

    const handle = await open(cfg, `${cfg.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers(cfg) },
      body,
      signal,
    });

    const usage = {};
    let finish = null;
    for await (const ev of sse(cfg, handle, signal)) {
      const j = parseJsonLoose(ev.data, cfg, 'Anthropic');
      switch (j.type) {
        case 'message_start':
          usage.inputTokens = j.message?.usage?.input_tokens;
          break;
        case 'content_block_delta':
          if (j.delta?.type === 'text_delta' && j.delta.text) yield { type: 'delta', text: j.delta.text };
          break;
        case 'message_delta':
          if (j.delta?.stop_reason) finish = j.delta.stop_reason;
          if (j.usage?.output_tokens != null) usage.outputTokens = j.usage.output_tokens;
          break;
        case 'error':
          throw new ProviderError(`Anthropic reported an error: ${j.error?.message || 'unknown error'}`, {
            code: j.error?.type === 'overloaded_error' ? 'server_error' : 'provider_error',
            hint: j.error?.type === 'overloaded_error' ? 'The service is overloaded. Try again shortly.' : undefined,
          });
        default:
      }
    }
    yield { type: 'done', usage, finishReason: finish };
  },
};
