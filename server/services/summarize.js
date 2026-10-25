import { q } from '../db.js';
import { uid, now, clamp, log, redact, estimateTokens } from '../util.js';
import { getSettings } from '../settings.js';
import { getCharacterRow } from './characters.js';
import { getConversationRow } from './conversations.js';
import { getSummaries } from './retrieval.js';
import { resolveRun, complete } from './generate.js';

const locks = new Set();

const SYSTEM = `You write faithful summaries of part of a conversation between a user and a character, for the character's own records.
Write 3 to 7 plain sentences in the past tense, naming the people, topics, decisions, promises and unresolved questions that came up, and the emotional tone if it matters.
State only what actually happened in the text. Do not add interpretation, advice or invented details. Output only the summary.`;

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Fallback when no model is available: a mechanical digest built from the real messages. */
export function extractiveSummary(rows, characterName) {
  const lines = [];
  for (const r of rows) {
    const text = r.content.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (r.role === 'user') lines.push(`The user said: "${clip(text, 140)}"`);
    else if (lines.length < 12) lines.push(`${characterName} replied: "${clip(text, 90)}"`);
  }
  return clip(lines.slice(0, 10).join(' '), 1400);
}

/**
 * Roll older messages into stored summaries. The original messages are never touched; summaries only
 * stand in for them inside the prompt once they no longer fit verbatim.
 */
export async function maybeSummarize(conversationId) {
  if (locks.has(conversationId)) return;
  locks.add(conversationId);
  try {
    for (let pass = 0; pass < 2; pass++) {
      const conv = getConversationRow(conversationId);
      const character = conv && getCharacterRow(conv.character_id);
      if (!conv || !character) return;
      const settings = getSettings();
      if (!settings.memory.enabled || !character.memory_enabled) return;

      let ctx = 8192;
      try {
        ctx = resolveRun(conv, character, settings).cfg.effectiveContext;
      } catch {
        /* no provider yet: use a mid-size assumption */
      }
      const keepRecent = clamp(Math.round(Math.min(ctx, settings.memory.maxPromptTokens) / 600), 4, 12);
      const chunkMin = clamp(Math.round(Math.min(ctx, settings.memory.maxPromptTokens) / 450), 6, settings.memory.summarizeAfterMessages);

      const maxSeq = q.get('SELECT COALESCE(MAX(seq), 0) AS m FROM messages WHERE conversation_id = ?', conversationId).m;
      const sums = getSummaries(conversationId);
      const lastTo = sums.length ? sums[sums.length - 1].to_seq : 0;
      const upper = maxSeq - keepRecent;
      const rows = q.all('SELECT * FROM messages WHERE conversation_id = ? AND seq > ? AND seq <= ? ORDER BY seq LIMIT 40', conversationId, lastTo, upper);
      if (rows.length < chunkMin) return;

      let content = '';
      let method = 'model';
      if (settings.memory.extraction === 'heuristic') {
        content = extractiveSummary(rows, character.name);
        method = 'extractive';
      } else {
        try {
          const { cfg } = resolveRun(conv, character, settings);
          const transcript = rows.map((r) => `${r.role === 'user' ? 'User' : character.name}: ${clip(r.content, 1500)}`).join('\n');
          const prior = sums.length ? `Summary of the conversation so far, for continuity only:\n${clip(sums.map((s) => s.content).join(' '), 1200)}\n\n` : '';
          content = await complete(cfg, {
            system: SYSTEM,
            messages: [{ role: 'user', content: `${prior}Summarize this part of the conversation:\n\n${transcript}` }],
            maxTokens: 450,
            temperature: 0.2,
          });
        } catch (e) {
          log(`summary paused for conversation ${conversationId}: ${redact(e.message)}`);
          return; // provider unavailable: retry after the next reply
        }
        if (!content || estimateTokens(content) < 8) {
          content = extractiveSummary(rows, character.name);
          method = 'extractive';
        }
      }
      q.run(
        'INSERT INTO summaries (id, conversation_id, from_seq, to_seq, content, method, created_at) VALUES (?,?,?,?,?,?,?)',
        uid(), conversationId, rows[0].seq, rows[rows.length - 1].seq, content.slice(0, 3000), method, now()
      );
    }
  } finally {
    locks.delete(conversationId);
  }
}
