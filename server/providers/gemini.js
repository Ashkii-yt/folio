import { open, getJson, sse, parseJsonLoose, ProviderError } from './http.js';
import { normalizeMessages, BASE_SUPPORTS } from './normalize.js';

// The key goes in a header rather than the ?key= query string so it never ends up in URLs or logs.
const headers = (cfg) => ({ 'x-goog-api-key': cfg.apiKey || '' });
const modelPath = (m) => (String(m).startsWith('models/') ? m : `models/${m}`);

export default {
  type: 'gemini',
  label: 'Google Gemini',
  defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  defaultContext: 32768,
  help:
    'Uses the Gemini API (Google AI Studio keys). Gemini uses its own roles ("model" instead of "assistant") and a separate system instruction; Folio handles that. ' +
    'Context length is used only to size Folio\'s prompt.',
  supports: {
    ...BASE_SUPPORTS,
    temperature: true,
    topP: true,
    topK: true,
    maxTokens: true,
    apiKey: 'required',
  },

  async listModels(cfg, { signal } = {}) {
    const data = await getJson(cfg, `${cfg.baseUrl}/models?pageSize=1000`, { headers: headers(cfg), signal, what: 'models' });
    return (data.models || [])
      .filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
      .map((m) => ({
        id: String(m.name).replace(/^models\//, ''),
        label: m.displayName || String(m.name).replace(/^models\//, ''),
        detail: m.inputTokenLimit ? `${m.inputTokenLimit.toLocaleString('en-US')} token context` : '',
      }));
  },

  async *stream(cfg, { system, messages, signal }) {
    const msgs = normalizeMessages(messages, { requireUserFirst: true, merge: true });
    const generationConfig = {};
    if (cfg.params.temperature != null) generationConfig.temperature = cfg.params.temperature;
    if (cfg.params.topP != null) generationConfig.topP = cfg.params.topP;
    if (cfg.params.topK != null) generationConfig.topK = cfg.params.topK;
    if (cfg.params.maxTokens != null) generationConfig.maxOutputTokens = cfg.params.maxTokens;

    const body = {
      contents: msgs.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      generationConfig,
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };

    const handle = await open(cfg, `${cfg.baseUrl}/${modelPath(cfg.model)}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers(cfg) },
      body,
      signal,
    });

    let usage = {};
    let finish = null;
    for await (const ev of sse(cfg, handle, signal)) {
      const j = parseJsonLoose(ev.data, cfg, 'Gemini');
      if (j.error) throw new ProviderError(`Gemini reported an error: ${j.error.message || 'unknown error'}`, { code: 'provider_error' });
      if (j.promptFeedback?.blockReason) {
        throw new ProviderError(`Gemini blocked the prompt (${j.promptFeedback.blockReason}).`, {
          code: 'blocked',
          hint: 'The provider\'s safety filters declined this request. Rephrase, or try a different model.',
        });
      }
      const cand = j.candidates?.[0];
      for (const part of cand?.content?.parts || []) {
        if (part.text && !part.thought) yield { type: 'delta', text: part.text };
      }
      if (cand?.finishReason) finish = cand.finishReason;
      if (j.usageMetadata) {
        usage = { inputTokens: j.usageMetadata.promptTokenCount, outputTokens: j.usageMetadata.candidatesTokenCount };
      }
    }
    if (finish === 'SAFETY' || finish === 'PROHIBITED_CONTENT') {
      throw new ProviderError('Gemini stopped because of its safety filters.', {
        code: 'blocked',
        hint: 'Try rephrasing, or use a different model.',
      });
    }
    yield { type: 'done', usage, finishReason: finish };
  },
};
