/**
 * Shared message normalisation. Folio always hands adapters:
 *   system:   string
 *   messages: [{ role: 'user' | 'assistant', content }]
 * Adapters then adapt to whatever their API demands.
 */
export function normalizeMessages(messages, { requireUserFirst = false, merge = false } = {}) {
  const out = [];
  for (const m of messages) {
    const content = String(m.content ?? '');
    if (!content.trim()) continue;
    const last = out[out.length - 1];
    if (merge && last && last.role === m.role) last.content += `\n\n${content}`;
    else out.push({ role: m.role, content });
  }
  if (requireUserFirst && out[0]?.role === 'assistant') {
    out.unshift({ role: 'user', content: '(The conversation begins.)' });
  }
  return out;
}

export const BASE_SUPPORTS = {
  temperature: false,
  topP: false,
  topK: false,
  maxTokens: false,
  contextLength: false, // sent to the provider
  customHeaders: true,
  apiKey: 'optional', // 'required' | 'optional' | 'none'
  streaming: true,
  discovery: true,
};
