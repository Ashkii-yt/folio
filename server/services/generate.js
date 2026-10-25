import { q } from '../db.js';
import { HttpError } from '../util.js';
import { getProviderRow, resolveConfig, getAdapter } from '../providers/index.js';
import { getSettings } from '../settings.js';

/**
 * Decide which provider and model answer for a conversation.
 * Precedence: conversation override → character override → global default → first enabled provider.
 */
export function resolveRun(conversationRow, characterRow, settings = getSettings()) {
  const enabled = q.all('SELECT * FROM providers WHERE enabled = 1 ORDER BY created_at');
  const defaultRow =
    (settings.defaultProviderId && enabled.find((p) => p.id === settings.defaultProviderId)) || enabled[0] || null;

  const wantedId = conversationRow?.provider_id || characterRow?.provider_id || defaultRow?.id || null;
  if (!wantedId) {
    throw new HttpError(409, 'No AI provider is set up yet. Add one in Settings → AI providers (Ollama, OpenAI, Anthropic, Gemini or any OpenAI-compatible server).', 'no_provider');
  }
  const row = getProviderRow(wantedId);
  if (!row) throw new HttpError(409, 'The provider chosen for this chat no longer exists. Pick another one in the chat header.', 'no_provider');
  if (!row.enabled) {
    throw new HttpError(409, `The provider "${row.name}" is disabled. Enable it in Settings → AI providers, or choose a different one.`, 'provider_disabled');
  }

  let model = '';
  let source = 'default';
  if (conversationRow?.model) {
    model = conversationRow.model;
    source = 'conversation';
  } else if (characterRow?.model && wantedId === (characterRow.provider_id || defaultRow?.id)) {
    model = characterRow.model;
    source = 'character';
  } else if (settings.defaultModel && wantedId === defaultRow?.id) {
    model = settings.defaultModel;
  }
  if (!model) model = row.default_model;
  if (conversationRow?.provider_id) source = 'conversation';
  else if (characterRow?.provider_id && source === 'default') source = 'character';

  if (!model) {
    throw new HttpError(409, `No model is selected for "${row.name}". Open Settings → AI providers, test the connection and choose a model.`, 'no_model');
  }
  return { cfg: resolveConfig(row, { model }), row, source };
}

/** Run a generation to completion and return the text (used by background tasks). */
export async function complete(cfg, { system = '', messages, maxTokens = 700, temperature = 0.2, signal } = {}) {
  const adapter = getAdapter(cfg.type);
  const c = { ...cfg, params: { ...cfg.params, maxTokens, temperature } };
  let text = '';
  for await (const ev of adapter.stream(c, { system, messages, signal })) {
    if (ev.type === 'delta') text += ev.text;
  }
  return text.trim();
}

export function streamReply(cfg, { system, messages, signal }) {
  return getAdapter(cfg.type).stream(cfg, { system, messages, signal });
}
