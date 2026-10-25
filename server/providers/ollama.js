import { open, getJson, lines, parseJsonLoose, ProviderError } from './http.js';
import { normalizeMessages, BASE_SUPPORTS } from './normalize.js';

const authHeaders = (cfg) => (cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {});

export default {
  type: 'ollama',
  label: 'Ollama',
  defaultBaseUrl: 'http://127.0.0.1:11434',
  defaultContext: 4096,
  help:
    'Folio\'s server talks to Ollama, not your browser, so Ollama\'s CORS settings (OLLAMA_ORIGINS) do not matter. ' +
    'For a remote or cloud Ollama endpoint, add an API key or a header your gateway expects.',
  supports: {
    ...BASE_SUPPORTS,
    temperature: true,
    topP: true,
    topK: true,
    maxTokens: true, // num_predict
    contextLength: true, // num_ctx
    apiKey: 'optional',
  },

  async listModels(cfg, { signal } = {}) {
    const data = await getJson(cfg, `${cfg.baseUrl}/api/tags`, {
      headers: authHeaders(cfg), signal, what: 'models',
    });
    return (data.models || []).map((m) => ({
      id: m.name || m.model,
      label: m.name || m.model,
      detail: [m.details?.parameter_size, m.details?.quantization_level].filter(Boolean).join(' · '),
    }));
  },

  async *stream(cfg, { system, messages, signal }) {
    const msgs = normalizeMessages(messages);
    const options = {};
    if (cfg.params.temperature != null) options.temperature = cfg.params.temperature;
    if (cfg.params.topP != null) options.top_p = cfg.params.topP;
    if (cfg.params.topK != null) options.top_k = cfg.params.topK;
    if (cfg.params.maxTokens != null) options.num_predict = cfg.params.maxTokens;
    if (cfg.contextLength) options.num_ctx = cfg.contextLength;

    const handle = await open(cfg, `${cfg.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(cfg) },
      body: {
        model: cfg.model,
        stream: true,
        messages: [...(system ? [{ role: 'system', content: system }] : []), ...msgs],
        options,
      },
      signal,
    });

    let usage = {};
    let finish = null;
    for await (const line of lines(cfg, handle, signal)) {
      if (!line.trim()) continue;
      const j = parseJsonLoose(line, cfg, 'Ollama');
      if (j.error) {
        throw new ProviderError(`Ollama reported an error: ${j.error}`, {
          code: /not found/i.test(j.error) ? 'not_found' : 'provider_error',
          hint: /not found/i.test(j.error) ? `Install it with \`ollama pull ${cfg.model}\`.` : undefined,
        });
      }
      const text = j.message?.content;
      if (text) yield { type: 'delta', text };
      if (j.done) {
        usage = { inputTokens: j.prompt_eval_count, outputTokens: j.eval_count };
        finish = j.done_reason || 'stop';
      }
    }
    yield { type: 'done', usage, finishReason: finish };
  },
};
