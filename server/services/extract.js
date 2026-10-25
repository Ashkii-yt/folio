import { q } from '../db.js';
import { extractJson, log, redact } from '../util.js';
import { getSettings } from '../settings.js';
import { getCharacterRow } from './characters.js';
import { getConversationRow } from './conversations.js';
import { applyOperations, CATEGORIES } from './memories.js';
import { retrieveMemories } from './retrieval.js';
import { resolveRun, complete } from './generate.js';
import { ProviderError } from '../providers/http.js';

const MAX_BATCH = 40;
const locks = new Map();

const SYSTEM = `You maintain the long-term memory of a character in a chat app. You read a transcript and decide what is worth remembering about the USER and about what the user and the character have shared.

Output ONLY a JSON object of the form {"memories":[ ... ]}. No prose, no code fences.

Each item is one of:
{"op":"add","content":"...","category":"...","importance":3,"explicit":false}
{"op":"update","id":"<id of an existing memory>","content":"<the corrected full statement>","category":"...","importance":3,"explicit":true}
{"op":"reinforce","id":"<id of an existing memory the transcript confirms again>"}

Rules:
- Record only what the transcript actually says. Never guess, infer personality, or invent events.
- Worth keeping: the user's name and how they like to be addressed; preferences and interests; important people and relationships; ongoing situations; plans, projects and goals; significant events; notable things the user and the character experienced together (category "shared_experience").
- Write each memory as one short, self-contained sentence in the third person, e.g. "The user's sister is named Priya." Include dates only if they were stated.
- Skip greetings, small talk and filler. Skip things the character says about itself unless they became a shared event.
- The chat may be roleplay. Do not record fictional claims as real facts about the user unless the user clearly speaks as themselves; record story events as "shared_experience".
- If the user corrects or changes something an existing memory says, emit "update" with that memory's id, and set "explicit" to true when the user said so directly.
- If a fact is already stored, use "reinforce" or emit nothing. Do not add duplicates.
- importance: 5 = name or critical facts, 4 = important ongoing matters, 3 = normal, 2 = minor, 1 = trivia.
- categories: ${CATEGORIES.join(', ')}.
- At most 8 items. If nothing is worth remembering, return {"memories":[]}.`;

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

/* ---------- Heuristic fallback (no model needed) ---------- */

const tidy = (s) => s.replace(/\s+/g, ' ').replace(/[.!?,;:]+$/, '').trim();
const NOISE = /^(a bit|a little|a lot|kind of|sort of|so|very|really|just|not sure|fine|okay|ok|good|tired|sorry|here|back|ready|going|gonna)\b/i;

export function heuristicOperations(userMessages) {
  const ops = [];
  const add = (content, category, importance, explicit = false) => ops.push({ op: 'add', content, category, importance, explicit });
  for (const text of userMessages) {
    let m;
    if ((m = text.match(/\b(?:my name is|call me|i go by|i'm called)\s+([A-Z][\p{L}'-]+(?:\s+[A-Z][\p{L}'-]+)?)/u))) {
      add(`The user's name is, or they like to be called, ${tidy(m[1])}.`, 'identity', 5, true);
    }
    for (const re of [/\bi (?:really |absolutely )?(?:love|enjoy|adore)\s+([^.!?\n]{3,70})/i, /\bmy favou?rite ([^.!?\n]{3,70})/i]) {
      if ((m = text.match(re))) add(`The user ${re.source.includes('favou') ? 'has a favorite ' : 'enjoys '}${tidy(m[1])}.`, 'preference', 3);
    }
    if ((m = text.match(/\bi (?:really )?(?:hate|dislike|can't stand|cannot stand|don't like)\s+([^.!?\n]{3,70})/i))) {
      add(`The user dislikes ${tidy(m[1])}.`, 'preference', 3);
    }
    if ((m = text.match(/\bi(?:'m| am) (?:a|an)\s+([^.!?\n]{3,50})/i)) && !NOISE.test(m[1])) {
      add(`The user says they are a ${tidy(m[1])}.`, 'fact', 3);
    }
    if ((m = text.match(/\bi work (as|at|for|in)\s+([^.!?\n]{3,60})/i))) add(`The user works ${m[1].toLowerCase()} ${tidy(m[2])}.`, 'fact', 3);
    if ((m = text.match(/\bi live in\s+([^.!?\n]{3,50})/i))) add(`The user lives in ${tidy(m[1])}.`, 'fact', 3);
    if ((m = text.match(/\bmy (wife|husband|partner|girlfriend|boyfriend|mom|mother|dad|father|sister|brother|friend|best friend|dog|cat|boss|son|daughter)(?:'s name)?\s+(?:is|are|named|called)\s+([A-Z][\p{L}'-]+)/u))) {
      add(`The user's ${m[1]} is named ${m[2]}.`, 'relationship', 4);
    }
    if ((m = text.match(/\bi(?:'m| am) (?:currently )?(working on|building|making|learning|planning|writing|studying)\s+([^.!?\n]{3,80})/i))) {
      add(`The user is ${m[1].toLowerCase()} ${tidy(m[2])}.`, 'project', 4);
    }
    if ((m = text.match(/\bmy birthday is\s+([^.!?\n]{3,30})/i))) add(`The user's birthday is ${tidy(m[1])}.`, 'fact', 4);
  }
  return ops.slice(0, 8);
}

/* ---------- Model extraction ---------- */

function normalizeOps(json) {
  const list = Array.isArray(json) ? json : json?.memories;
  if (!Array.isArray(list)) return null;
  return list
    .filter((o) => o && typeof o === 'object' && ['add', 'update', 'reinforce'].includes(o.op))
    .slice(0, 8)
    .map((o) => ({
      op: o.op,
      id: typeof o.id === 'string' ? o.id : undefined,
      content: typeof o.content === 'string' ? o.content : undefined,
      category: o.category,
      importance: o.importance,
      explicit: o.explicit === true,
    }));
}

async function extractBatch({ character, conversation, rows, context, settings, signal, forceMode }) {
  const mode = forceMode || settings.memory.extraction;
  const userTexts = rows.filter((r) => r.role === 'user').map((r) => r.content);
  if (mode === 'heuristic') return { ops: heuristicOperations(userTexts), method: 'heuristic' };

  const { cfg } = resolveRun(conversation, character, settings);
  const transcript = [...context, ...rows]
    .map((r) => `${r.role === 'user' ? 'User' : character.name}: ${clip(r.content, 1200)}`)
    .join('\n');
  const existing = retrieveMemories(character.id, transcript, { limit: 20 });
  const existingText = existing.length ? existing.map((e) => `[${e.memory.id}] ${e.memory.content}`).join('\n') : 'none';
  const prompt =
    `Character: ${character.name}\nUser's name (if known): ${settings.userName || 'unknown'}\n\n` +
    `Existing memories:\n${existingText}\n\nTranscript (only the lines after "-----" are new):\n` +
    `${context.length ? `${context.map((r) => `${r.role === 'user' ? 'User' : character.name}: ${clip(r.content, 600)}`).join('\n')}\n-----\n` : '-----\n'}` +
    `${rows.map((r) => `${r.role === 'user' ? 'User' : character.name}: ${clip(r.content, 1200)}`).join('\n')}\n\nReturn the JSON now.`;

  const text = await complete(cfg, { system: SYSTEM, messages: [{ role: 'user', content: prompt }], maxTokens: 900, temperature: 0.1, signal });
  const ops = normalizeOps(extractJson(text));
  if (!ops) return { ops: heuristicOperations(userTexts), method: 'heuristic-fallback', note: 'The model did not return valid JSON, so simple pattern matching was used for this batch.' };
  return { ops, method: 'model' };
}

/**
 * Extract memories from everything in a conversation that has not been processed yet.
 * Safe to call repeatedly; progress is tracked per conversation.
 */
export function runExtraction(conversationId, { force = false, signal } = {}) {
  const prior = locks.get(conversationId) || Promise.resolve();
  const next = prior.catch(() => {}).then(() => doExtraction(conversationId, { force, signal }));
  locks.set(conversationId, next);
  next.finally(() => {
    if (locks.get(conversationId) === next) locks.delete(conversationId);
  }).catch(() => {});
  return next;
}

async function doExtraction(conversationId, { force, signal }) {
  const conversation = getConversationRow(conversationId);
  if (!conversation) return { skipped: 'missing' };
  const character = getCharacterRow(conversation.character_id);
  if (!character) return { skipped: 'missing' };
  const settings = getSettings();

  if (!force) {
    if (settings.memory.extraction === 'off' || !settings.memory.enabled) return { skipped: 'off' };
    if (!character.memory_enabled) return { skipped: 'memory_disabled' };
    if (character.auto_extract === 0) return { skipped: 'off' };
  } else if (!character.memory_enabled) {
    return { skipped: 'memory_disabled' };
  }

  const total = { added: 0, updated: 0, reinforced: 0, pending: 0, skipped: 0, batches: 0, method: null, notes: [] };
  for (let pass = 0; pass < 4; pass++) {
    const conv = getConversationRow(conversationId);
    if (!conv) break;
    const rows = q.all('SELECT * FROM messages WHERE conversation_id = ? AND seq > ? ORDER BY seq LIMIT ?', conversationId, conv.extracted_upto, MAX_BATCH);
    if (!rows.length) break;
    const maxSeq = rows[rows.length - 1].seq;
    const hasUser = rows.some((r) => r.role === 'user' && !String(r.meta).includes('"greeting":true'));
    if (hasUser) {
      const context = q
        .all('SELECT role, content FROM messages WHERE conversation_id = ? AND seq <= ? ORDER BY seq DESC LIMIT 2', conversationId, conv.extracted_upto)
        .reverse();
      let result;
      try {
        result = await extractBatch({ character, conversation: conv, rows, context, settings, signal });
      } catch (e) {
        if (e instanceof ProviderError || e.status) {
          log(`memory extraction paused for conversation ${conversationId}: ${redact(e.message)}`);
          total.error = e.message;
          return total; // not advanced: it will be retried next time
        }
        throw e;
      }
      const lastUser = [...rows].reverse().find((r) => r.role === 'user');
      const applied = applyOperations(character.id, result.ops, {
        conversationId,
        messageId: lastUser?.id,
        requireApproval: settings.memory.requireApproval,
      });
      for (const k of ['added', 'updated', 'reinforced', 'pending', 'skipped']) total[k] += applied[k];
      total.method = result.method;
      if (result.note) total.notes.push(result.note);
      total.batches++;
    }
    q.run('UPDATE conversations SET extracted_upto = ? WHERE id = ?', maxSeq, conversationId);
    if (rows.length < MAX_BATCH) break;
  }
  return total;
}

/** Called after each reply: extract once enough new user messages have accumulated. */
export function maybeExtract(conversationId) {
  const conv = getConversationRow(conversationId);
  if (!conv) return;
  const settings = getSettings();
  if (settings.memory.extraction === 'off' || !settings.memory.enabled) return;
  const { n } = q.get("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND seq > ? AND role = 'user'", conversationId, conv.extracted_upto);
  if (n >= settings.memory.extractEveryUserMessages) {
    runExtraction(conversationId).catch((e) => log('memory extraction failed:', e.message));
  }
}

/** Flush any pending extraction for a character's other conversations (used when a new chat starts). */
export function flushExtraction(characterId, exceptConversationId) {
  const rows = q.all(
    `SELECT v.id FROM conversations v WHERE v.character_id = ? AND v.id != ? AND EXISTS
       (SELECT 1 FROM messages m WHERE m.conversation_id = v.id AND m.seq > v.extracted_upto AND m.role = 'user')`,
    characterId, exceptConversationId || ''
  );
  for (const r of rows) runExtraction(r.id).catch((e) => log('memory extraction failed:', e.message));
}
