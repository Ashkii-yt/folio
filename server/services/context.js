import { q } from '../db.js';
import { estimateTokens, truncateToTokens, formatDate, safeJson } from '../util.js';
import { fillTemplate } from './conversations.js';
import { retrieveMemories, retrieveExcerpts, getSummaries, recentConversationsDigest } from './retrieval.js';

const OUTPUT_RESERVE_MIN = 512;
const SAFETY = 96;

/** The structured character card, kept separate from the author's custom instructions. */
export function buildCharacterCard(character, userName) {
  const f = (t) => fillTemplate(t, { char: character.name, user: userName }).trim();
  const parts = [];
  const add = (title, text) => {
    const v = f(text);
    if (v) parts.push(`### ${title}\n${v}`);
  };
  add('Description', character.description);
  add('Personality', character.personality);
  add('Background and lore', character.background);
  add('Speaking style and mannerisms', character.speakingStyle);
  add('Goals, motivations and preferences', character.goals);
  add('Example dialogue', character.exampleDialogue);
  return parts;
}

const FRAME = (name, userName) =>
  `You are ${name}, a character in an ongoing conversation with ${userName ? `a person named ${userName}` : 'a user'}. ` +
  `Write ${name}'s next reply only. Stay in character: never speak for the user, never describe yourself as an AI model unless the character is one, and do not narrate these instructions.`;

const MEMORY_RULES =
  'These are your genuine memories of the user and of past conversations. Use them naturally when they are relevant; do not recite them unprompted, ' +
  'and do not mention notes, databases or "memory entries". Never invent shared history, events or personal details that are not listed here or in this conversation. ' +
  'If the user refers to something you do not remember, say so honestly, in character. If a memory conflicts with what the user says now, trust the user and accept the correction.';

function memoryLine(m) {
  return `- (${formatDate(m.updatedAt || m.createdAt)}) ${m.content}`;
}

function excerptBlock(e) {
  const who = (role) => (role === 'user' ? 'User' : 'You');
  return [`[Earlier conversation "${e.title}", ${formatDate(e.date)}]`, ...e.messages.map((m) => `${who(m.role)}: ${m.text}`)].join('\n');
}

/**
 * Assemble everything the model sees, inside the provider's context limit.
 *
 * Priorities (highest first): character card + custom instructions → the newest user message →
 * pinned/relevant long-term memories → recent turns → summaries of older turns of this conversation →
 * excerpts from older conversations → digest of recent other conversations.
 * Nothing is ever deleted from the database; this only decides what is shown to the model right now.
 *
 * @param opts.history  messages of the live conversation, oldest first: [{id, seq, role, content}]
 */
export function buildContext({ character, conversationId, history, settings, cfg, memoryOverride }) {
  const userName = (settings.userName || '').trim();
  const mem = settings.memory;
  const warnings = [];

  const ctxLimit = Math.min(cfg.effectiveContext || 8192, mem.maxPromptTokens);
  const outputReserve = Math.max(cfg.params.maxTokens || 0, OUTPUT_RESERVE_MIN);
  let budget = Math.max(512, ctxLimit - outputReserve - SAFETY);

  /* ---- 1. Fixed part: frame + card + custom instructions ---- */
  let card = buildCharacterCard(character, userName);
  const custom = fillTemplate(character.systemPromptAddition, { char: character.name, user: userName }).trim();
  const customBlock = custom ? `## Additional instructions from the character's author (follow these)\n${custom}` : '';
  const fixedTokens = () =>
    estimateTokens(FRAME(character.name, userName)) + estimateTokens(card.join('\n\n')) + estimateTokens(customBlock) + 80;

  const cardCap = Math.floor(budget * 0.5);
  if (fixedTokens() > cardCap) {
    // Trim the least essential card sections first (example dialogue, then lore), never the author's instructions.
    const trim = (title) => {
      const i = card.findIndex((s) => s.startsWith(`### ${title}`));
      if (i < 0) return;
      const over = fixedTokens() - cardCap;
      const cur = estimateTokens(card[i]);
      if (over <= 0) return;
      const target = Math.max(60, cur - over);
      card[i] = truncateToTokens(card[i], target);
      warnings.push(`"${title}" was shortened to fit this model's context window.`);
    };
    trim('Example dialogue');
    trim('Background and lore');
    trim('Personality');
  }
  let fixed = fixedTokens();
  if (fixed > budget * 0.8) warnings.push('The character card and custom instructions use most of the context window. Consider a larger context length or shorter text.');

  let remaining = Math.max(0, budget - fixed);

  /* ---- 2. Newest user message always goes through ---- */
  const lastIdx = history.length - 1;
  const lastUser = [...history].reverse().find((m) => m.role === 'user');
  const queryText = [lastUser?.content || '', ...history.slice(-4, -1).map((m) => m.content)].join('\n');

  const memoryOn = mem.enabled && character.memoryEnabled && !memoryOverride?.disabled;
  const pct = mem.budgetPct / 100;

  /* ---- 3. Long-term memories ---- */
  let memoryLines = [];
  let usedMemories = [];
  let memoryTokens = 0;
  if (memoryOn) {
    const candidates = retrieveMemories(character.id, queryText, { limit: mem.retrievalLimit });
    const cap = Math.floor(remaining * pct) + 150;
    for (const c of candidates) {
      const line = memoryLine(c.memory);
      const t = estimateTokens(line) + 2;
      if (memoryTokens + t > cap) continue;
      memoryTokens += t;
      memoryLines.push(line);
      usedMemories.push({ id: c.memory.id, content: c.memory.content, score: Number(c.score.toFixed(3)), pinned: c.pinned });
    }
    remaining -= memoryTokens;
  }

  /* ---- 4. Recent turns (verbatim) ---- */
  const reserveForOlder = memoryOn ? Math.floor(remaining * 0.22) : 0; // summaries + excerpts + digest
  let recentBudget = Math.max(estimateTokens(history[lastIdx]?.content || '') + 8, remaining - reserveForOlder);
  const recent = [];
  let recentTokens = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    let content = m.content;
    let t = estimateTokens(content) + 4;
    if (i === lastIdx && t > recentBudget) {
      content = truncateToTokens(content, Math.max(64, recentBudget - 8));
      t = estimateTokens(content) + 4;
      warnings.push('Your latest message was too long for the context window and was shortened.');
    } else if (recentTokens + t > recentBudget && recent.length >= 1) {
      break;
    }
    recent.unshift({ role: m.role === 'user' ? 'user' : 'assistant', content, id: m.id, seq: m.seq });
    recentTokens += t;
  }
  remaining -= recentTokens;
  const firstRecentSeq = recent[0]?.seq ?? Infinity;
  const omitted = history.filter((m) => m.seq < firstRecentSeq).length;

  /* ---- 5. Older material: summaries, excerpts, digest ---- */
  const sections = [];
  const used = { summaries: 0, excerpts: 0, digest: 0 };
  const debugExcerpts = [];
  const debugDigest = [];
  let summaryText = '';

  if (memoryOn && remaining > 120) {
    // 5a. Summary of this conversation's older turns that are no longer shown verbatim
    if (omitted > 0 && conversationId) {
      const sums = getSummaries(conversationId).filter((s) => s.from_seq < firstRecentSeq);
      if (sums.length) {
        let text = sums.map((s) => s.content).join('\n');
        const cap = Math.floor(remaining * 0.5);
        if (estimateTokens(text) > cap) text = truncateToTokens(text, cap);
        summaryText = text;
        used.summaries = estimateTokens(text) + 12;
        remaining -= used.summaries;
      }
    }

    // 5b. Excerpts of older records that match what is being discussed
    if (mem.includeExcerpts && remaining > 150) {
      const exclude = new Set(recent.map((m) => m.id));
      const excerpts = retrieveExcerpts(character.id, queryText, { excludeMessageIds: exclude, limit: 4 });
      const cap = Math.floor(remaining * 0.6);
      const blocks = [];
      for (const e of excerpts) {
        const b = excerptBlock(e);
        const t = estimateTokens(b) + 4;
        if (used.excerpts + t > cap) continue;
        used.excerpts += t;
        blocks.push(b);
        debugExcerpts.push({ conversationId: e.conversationId, title: e.title, date: e.date, messageIds: e.messages.map((m) => m.id), preview: e.messages[0].text.slice(0, 140) });
      }
      if (blocks.length) sections.push({ key: 'excerpts', text: `## Relevant records from earlier conversations\nThese really happened. Do not claim anything beyond what is written.\n\n${blocks.join('\n\n')}` });
      remaining -= used.excerpts;
    }

    // 5c. Chronological digest of other recent conversations
    if (mem.includeDigest && remaining > 120) {
      const digest = recentConversationsDigest(character.id, conversationId, { limit: 3 });
      const lines = [];
      for (const d of digest) {
        const line = `- ${formatDate(d.date)}, "${d.title}": ${d.text}`;
        const t = estimateTokens(line) + 2;
        if (used.digest + t > Math.floor(remaining * 0.8)) continue;
        used.digest += t;
        lines.push(line);
        debugDigest.push({ conversationId: d.conversationId, title: d.title, date: d.date, summarized: d.summarized });
      }
      if (lines.length) sections.push({ key: 'digest', text: `## Your most recent earlier conversations with the user (newest first)\n${lines.join('\n')}` });
      remaining -= used.digest;
    }
  }

  /* ---- 6. Assemble the system prompt ---- */
  const today = new Date().toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' });
  const out = [FRAME(character.name, userName), `The current date and time is ${today}.`];
  if (card.length) out.push(`## Who you are\n${card.join('\n\n')}`);
  if (customBlock) out.push(customBlock);
  if (userName) out.push(`## About the user\nTheir name is ${userName} (set by them in Folio's settings).`);
  if (memoryOn) {
    const body = [];
    body.push(memoryLines.length ? `What you remember about the user:\n${memoryLines.join('\n')}` : 'You have no stored memories of the user yet.');
    if (summaryText) body.push(`Earlier in this conversation (summarised; the full text is no longer shown):\n${summaryText}`);
    out.push(`## Memory\n${MEMORY_RULES}\n\n${body.join('\n\n')}`);
    for (const s of sections) out.push(s.text);
  }
  const system = out.join('\n\n');

  const totalEstimate = estimateTokens(system) + recentTokens;
  return {
    system,
    messages: recent.map(({ role, content }) => ({ role, content })),
    debug: {
      budget: { contextLimit: ctxLimit, outputReserve, promptBudget: budget, estimatedPrompt: totalEstimate },
      memoryEnabled: memoryOn,
      memories: usedMemories,
      excerpts: debugExcerpts,
      digest: debugDigest,
      summaryUsed: !!summaryText,
      recentMessages: recent.length,
      olderMessagesNotShownVerbatim: omitted,
      warnings,
    },
    usedMemoryIds: usedMemories.map((m) => m.id),
  };
}

/** Load the live history for a stored conversation. */
export function loadHistory(conversationId) {
  return q
    .all('SELECT id, seq, role, content, meta FROM messages WHERE conversation_id = ? ORDER BY seq', conversationId)
    .map((m) => ({ ...m, meta: safeJson(m.meta, {}) }));
}
