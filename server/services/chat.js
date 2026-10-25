import { HttpError, log, redact } from '../util.js';
import { getSettings } from '../settings.js';
import { getCharacterRow, toCharacter, touchLastChat } from './characters.js';
import { requireConversation, addMessage, toMessage } from './conversations.js';
import { buildContext, loadHistory } from './context.js';
import { markMemoriesUsed } from './retrieval.js';
import { resolveRun, streamReply } from './generate.js';
import { maybeExtract } from './extract.js';
import { maybeSummarize } from './summarize.js';
import { ProviderError, isAbort } from '../providers/http.js';
import { q } from '../db.js';

const CUT_OFF = new Set(['length', 'max_tokens', 'MAX_TOKENS']);

/** Compact the debug info that is stored with each reply (full memory text stays in the memories table). */
function compactDebug(d) {
  return {
    budget: d.budget,
    memoryEnabled: d.memoryEnabled,
    memories: d.memories.map((m) => ({ id: m.id, content: m.content.slice(0, 160), pinned: m.pinned })),
    excerpts: d.excerpts,
    digest: d.digest,
    summaryUsed: d.summaryUsed,
    recentMessages: d.recentMessages,
    olderMessagesNotShownVerbatim: d.olderMessagesNotShownVerbatim,
    warnings: d.warnings,
  };
}

/**
 * Generate the character's next reply for a stored conversation.
 * The newest message in the conversation must be the user's. Emits events: start, delta, done.
 * Throws on failure (the caller turns that into an error event); the user's message stays saved.
 */
export async function generateReply(conversationId, { signal, emit }) {
  const conv = requireConversation(conversationId);
  const characterRow = getCharacterRow(conv.character_id);
  const settings = getSettings();
  const { cfg, source } = resolveRun(conv, characterRow, settings);
  const character = toCharacter(characterRow);

  const history = loadHistory(conversationId);
  if (!history.length || history[history.length - 1].role !== 'user') {
    throw new HttpError(409, 'There is no new message from you to reply to.', 'nothing_to_reply');
  }

  const ctx = buildContext({ character, conversationId, history, settings, cfg });
  emit('start', { provider: cfg.name, providerId: cfg.id, model: cfg.model, source, context: compactDebug(ctx.debug) });

  let text = '';
  let usage = {};
  let finish = null;
  try {
    for await (const ev of streamReply(cfg, { system: ctx.system, messages: ctx.messages, signal })) {
      if (ev.type === 'delta') {
        text += ev.text;
        emit('delta', { text: ev.text });
      } else if (ev.type === 'done') {
        usage = ev.usage || {};
        finish = ev.finishReason;
      }
    }
  } catch (e) {
    if (isAbort(e) || signal?.aborted) {
      if (text.trim()) {
        const saved = addMessage(conversationId, {
          role: 'character', content: text, model: cfg.model,
          meta: { provider: cfg.name, providerId: cfg.id, stopped: true, context: compactDebug(ctx.debug) },
        });
        touchLastChat(conv.character_id);
        return { message: saved, stopped: true };
      }
      return { stopped: true };
    }
    throw e;
  }

  if (!text.trim()) {
    throw new ProviderError('The model returned an empty reply.', {
      code: 'empty_response',
      hint: 'Try again. Some models return nothing when the prompt is too long for them or when a filter intervenes. A larger context length or a different model may help.',
    });
  }

  markMemoriesUsed(ctx.usedMemoryIds);
  const saved = addMessage(conversationId, {
    role: 'character',
    content: text,
    model: cfg.model,
    meta: {
      provider: cfg.name,
      providerId: cfg.id,
      usage,
      finishReason: finish,
      truncated: CUT_OFF.has(finish),
      context: compactDebug(ctx.debug),
    },
  });
  touchLastChat(conv.character_id);
  emit('done', { message: saved });

  // Background upkeep: neither blocks the reply nor can fail it.
  setImmediate(() => {
    try {
      maybeExtract(conversationId);
    } catch (e) {
      log('extract scheduling failed:', e.message);
    }
    maybeSummarize(conversationId).catch((e) => log('summary failed:', redact(e.message)));
  });
  return { message: saved };
}

/** Stream a reply from an unsaved character draft (used by the editor's preview). Nothing is stored. */
export async function previewReply(draft, history, { signal, emit }) {
  const settings = getSettings();
  const fakeRow = { provider_id: draft.providerId || null, model: draft.model || '' };
  const { cfg } = resolveRun(null, fakeRow, settings);
  const character = { ...draft, id: 'preview', name: draft.name || 'Character', memoryEnabled: false };
  const ctx = buildContext({
    character,
    conversationId: null,
    history: history.map((m, i) => ({ id: `p${i}`, seq: i + 1, role: m.role === 'user' ? 'user' : 'character', content: String(m.content || '') })),
    settings,
    cfg,
    memoryOverride: { disabled: true },
  });
  emit('start', { provider: cfg.name, model: cfg.model });
  let text = '';
  for await (const ev of streamReply(cfg, { system: ctx.system, messages: ctx.messages, signal })) {
    if (ev.type === 'delta') {
      text += ev.text;
      emit('delta', { text: ev.text });
    }
  }
  if (!text.trim() && !signal?.aborted) {
    throw new ProviderError('The model returned an empty reply.', { code: 'empty_response' });
  }
  emit('done', {});
}

/** The assembled prompt for a (possibly unsaved) character, for the editor's "Prompt" preview. */
export function previewPrompt(draft) {
  const settings = getSettings();
  const cfg = { effectiveContext: 1_000_000, params: {} };
  const character = { ...draft, id: 'preview', name: draft.name || 'Character', memoryEnabled: false };
  const ctx = buildContext({
    character,
    conversationId: null,
    history: [{ id: 'p0', seq: 1, role: 'user', content: '(your message appears here)' }],
    settings: { ...settings, memory: { ...settings.memory, maxPromptTokens: 1_000_000 } },
    cfg,
    memoryOverride: { disabled: true },
  });
  return { system: ctx.system, estimatedTokens: ctx.debug.budget.estimatedPrompt };
}

export function countMessages(conversationId) {
  return q.get('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?', conversationId).n;
}

export { toMessage };
