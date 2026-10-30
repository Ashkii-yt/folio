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

const TAGS = ['think', 'thinking', 'thought', 'reasoning', 'reflection', 'scratchpad'];
const OPEN_RE = new RegExp(`<(${TAGS.join('|')})(?:\\s[^>]*)?>`, 'i');

/**
 * Some models "think out loud" inside <think>…</think> (or similar) before answering. That text is not part of
 * the answer, so it must never be shown, stored, or fed into other prompts. Handles tags split across chunks.
 */
export class ThinkFilter {
  constructor() {
    this.buf = '';
    this.tag = null; // the tag we are inside, or null
    this.lead = false; // trim blank lines right after a closed block
  }

  push(chunk) {
    this.buf += chunk;
    let out = '';
    for (;;) {
      if (this.tag) {
        const close = new RegExp(`</${this.tag}\\s*>`, 'i').exec(this.buf);
        if (!close) {
          // keep only a possible partial closing tag at the end
          const cut = this.buf.lastIndexOf('<');
          this.buf = cut >= 0 && `</${this.tag}>`.startsWith(this.buf.slice(cut).toLowerCase()) ? this.buf.slice(cut) : '';
          return out;
        }
        this.buf = this.buf.slice(close.index + close[0].length);
        this.tag = null;
        this.lead = true;
        continue;
      }
      const open = OPEN_RE.exec(this.buf);
      if (open) {
        out += this.take(this.buf.slice(0, open.index));
        this.buf = this.buf.slice(open.index + open[0].length);
        this.tag = open[1].toLowerCase();
        continue;
      }
      const cut = this.buf.lastIndexOf('<');
      if (cut >= 0 && TAGS.some((t) => `<${t}>`.startsWith(this.buf.slice(cut).toLowerCase()))) {
        out += this.take(this.buf.slice(0, cut));
        this.buf = this.buf.slice(cut);
      } else {
        out += this.take(this.buf);
        this.buf = '';
      }
      return out;
    }
  }

  take(text) {
    if (this.lead && text) {
      text = text.replace(/^\s+/, '');
      if (text) this.lead = false;
    }
    return text;
  }

  flush() {
    const rest = this.tag ? '' : this.take(this.buf);
    this.buf = '';
    return rest;
  }
}

/** Remove reasoning blocks from a finished text (also handles a reasoning dump that only has a closing tag). */
export function stripReasoning(text) {
  let t = String(text || '');
  const closeOnly = /<\/(?:think|thinking|reasoning)>/i;
  if (closeOnly.test(t) && !OPEN_RE.test(t)) t = t.slice(closeOnly.exec(t).index + closeOnly.exec(t)[0].length);
  const f = new ThinkFilter();
  return (f.push(t) + f.flush()).trim();
}

/** Run a generation to completion and return the text (used by background tasks). */
export async function complete(cfg, { system = '', messages, maxTokens = 700, temperature = 0.2, signal } = {}) {
  const adapter = getAdapter(cfg.type);
  // Thinking models spend part of the budget on reasoning, so leave room for the answer itself.
  const c = { ...cfg, params: { ...cfg.params, maxTokens: maxTokens + 600, temperature } };
  const f = new ThinkFilter();
  let text = '';
  for await (const ev of adapter.stream(c, { system, messages, signal })) {
    if (ev.type === 'delta') text += f.push(ev.text);
  }
  return stripReasoning(text + f.flush());
}

/** Streaming reply with any reasoning removed as it arrives. */
export async function* streamReply(cfg, { system, messages, signal }) {
  const f = new ThinkFilter();
  for await (const ev of getAdapter(cfg.type).stream(cfg, { system, messages, signal })) {
    if (ev.type === 'delta') {
      const t = f.push(ev.text);
      if (t) yield { ...ev, text: t };
    } else {
      if (ev.type === 'done') {
        const rest = f.flush();
        if (rest) yield { type: 'delta', text: rest };
      }
      yield ev;
    }
  }
}
