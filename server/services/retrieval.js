import { q } from '../db.js';
import { keywords, ftsQuery, jaccard, daysBetween, safeJson, now } from '../util.js';
import { toMemory } from './memories.js';

/**
 * Hybrid, embedding-free retrieval: SQLite FTS5 (BM25 with Porter stemming) for lexical relevance,
 * a token-overlap fallback for near-misses, and metadata (importance, recurrence, pins, recency)
 * to decide what is worth a slot in a limited prompt.
 */

const CORE_CATEGORIES = new Set(['identity', 'preference', 'relationship']);

export function retrieveMemories(characterId, queryText, { limit = 12 } = {}) {
  const rows = q.all("SELECT * FROM memories WHERE character_id = ? AND status = 'active'", characterId);
  if (!rows.length) return [];

  const words = keywords(queryText, 16);
  const match = ftsQuery(words);
  const bm25 = new Map();
  if (match) {
    try {
      const hits = q.all(
        `SELECT m.id AS id, bm25(memories_fts) AS s
           FROM memories_fts JOIN memories m ON m.rid = memories_fts.rowid
          WHERE memories_fts MATCH ? AND m.character_id = ? AND m.status = 'active'
          ORDER BY s LIMIT 100`,
        match, characterId
      );
      for (const h of hits) bm25.set(h.id, -h.s);
    } catch {
      /* a malformed query simply yields no lexical hits */
    }
  }
  const maxBm = Math.max(0, ...bm25.values());

  const scored = rows.map((r) => {
    let rel = maxBm > 0 && bm25.has(r.id) ? Math.min(1, bm25.get(r.id) / maxBm) * 0.85 + 0.15 : 0;
    if (!rel && words.length) rel = Math.min(1, jaccard(r.content, words.join(' ')) * 1.5);
    const recency = Math.exp(-daysBetween(r.updated_at) / 120);
    const core = CORE_CATEGORIES.has(r.category) && r.importance >= 4;
    const score =
      0.5 * rel +
      0.2 * (r.importance / 5) +
      0.12 * recency +
      0.08 * (Math.min(r.recurrence, 5) / 5) +
      (r.pinned ? 0.6 : 0) +
      (core && !rel ? 0.15 : 0);
    return { memory: toMemory(r), score, rel, core, pinned: !!r.pinned };
  });

  const chosen = scored.filter((s) => s.pinned || s.rel > 0 || s.core);
  chosen.sort((a, b) => b.score - a.score);
  return chosen.slice(0, limit);
}

export function markMemoriesUsed(ids) {
  if (!ids.length) return;
  const t = now();
  for (const id of ids) q.run('UPDATE memories SET use_count = use_count + 1, last_used_at = ? WHERE id = ?', t, id);
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/**
 * Older conversation records relevant to the query. Skips anything already in the live window.
 * Each hit is returned with its neighbouring message so the excerpt reads as an exchange.
 */
export function retrieveExcerpts(characterId, queryText, { excludeMessageIds = new Set(), limit = 4, perLine = 480 } = {}) {
  const match = ftsQuery(keywords(queryText, 14));
  if (!match) return [];
  let hits;
  try {
    hits = q.all(
      `SELECT m.id, m.conversation_id AS cid, m.seq, m.role, m.content, m.created_at, m.meta, v.title, bm25(messages_fts) AS s
         FROM messages_fts
         JOIN messages m ON m.rid = messages_fts.rowid
         JOIN conversations v ON v.id = m.conversation_id
        WHERE messages_fts MATCH ? AND v.character_id = ?
        ORDER BY s LIMIT 60`,
      match, characterId
    );
  } catch {
    return [];
  }
  hits = hits.filter((h) => !excludeMessageIds.has(h.id) && h.content.length >= 25 && !safeJson(h.meta, {})?.greeting);
  if (!hits.length) return [];

  const maxBm = Math.max(...hits.map((h) => -h.s)) || 1;
  hits.forEach((h) => {
    h.rank = (-h.s / maxBm) * 0.8 + Math.exp(-daysBetween(h.created_at) / 180) * 0.2;
  });
  hits.sort((a, b) => b.rank - a.rank);

  const windows = [];
  for (const h of hits) {
    const lo = h.role === 'character' ? h.seq - 1 : h.seq;
    const hi = h.role === 'user' ? h.seq + 1 : h.seq;
    const overlap = windows.find((w) => w.cid === h.cid && lo <= w.hi && hi >= w.lo);
    if (overlap) {
      overlap.lo = Math.min(overlap.lo, lo);
      overlap.hi = Math.max(overlap.hi, hi);
      continue;
    }
    if (windows.length >= limit) continue;
    windows.push({ cid: h.cid, title: h.title, lo, hi, rank: h.rank, date: h.created_at });
  }

  return windows.map((w) => {
    const msgs = q
      .all('SELECT id, seq, role, content, created_at FROM messages WHERE conversation_id = ? AND seq BETWEEN ? AND ? ORDER BY seq', w.cid, w.lo, w.hi)
      .filter((m) => !excludeMessageIds.has(m.id));
    return {
      conversationId: w.cid,
      title: w.title,
      date: msgs[0]?.created_at || w.date,
      rank: w.rank,
      messages: msgs.map((m) => ({ id: m.id, seq: m.seq, role: m.role, text: clip(m.content, perLine) })),
    };
  }).filter((e) => e.messages.length);
}

export function getSummaries(conversationId) {
  return q.all('SELECT * FROM summaries WHERE conversation_id = ? ORDER BY from_seq', conversationId);
}

/**
 * A chronological digest of the character's other conversations (most recent first):
 * the stored summary when there is one, otherwise the last exchange.
 */
export function recentConversationsDigest(characterId, excludeConversationId, { limit = 3 } = {}) {
  const convs = q.all(
    `SELECT v.id, v.title, v.updated_at, v.created_at FROM conversations v
      WHERE v.character_id = ? AND v.id != ? AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = v.id AND m.role = 'user')
      ORDER BY v.updated_at DESC LIMIT ?`,
    characterId, excludeConversationId || '', limit
  );
  return convs.map((v) => {
    const sums = getSummaries(v.id);
    let text;
    if (sums.length) text = sums.map((s) => s.content).join(' ');
    else {
      const last = q.all('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT 4', v.id).reverse();
      text = last.map((m) => `${m.role === 'user' ? 'User' : 'You'}: ${clip(m.content.replace(/\s+/g, ' '), 160)}`).join(' / ');
    }
    return { conversationId: v.id, title: v.title, date: v.updated_at, text: clip(text, 700), summarized: sums.length > 0 };
  });
}
