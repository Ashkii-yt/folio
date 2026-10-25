import { q, tx } from '../db.js';
import { bad, notFound, uid, now, jaccard, clamp } from '../util.js';
import { getCharacterRow } from './characters.js';

export const CATEGORIES = ['identity', 'preference', 'relationship', 'event', 'project', 'fact', 'shared_experience', 'other'];

export function toMemory(r) {
  return {
    id: r.id,
    characterId: r.character_id,
    content: r.content,
    category: r.category,
    importance: r.importance,
    pinned: !!r.pinned,
    source: r.source, // 'auto' = extracted by Folio, 'user' = written or edited by you
    status: r.status, // active | pending (awaiting approval) | superseded (kept as history)
    sourceConversationId: r.source_conversation_id,
    sourceMessageId: r.source_message_id,
    supersededBy: r.superseded_by,
    conflictsWith: r.conflicts_with,
    recurrence: r.recurrence,
    useCount: r.use_count,
    lastUsedAt: r.last_used_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function cleanContent(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').replace(/^[-*•]\s*/, '').trim();
  if (t.length < 3) throw bad('A memory needs at least a few words.');
  if (t.length > 600) throw bad('Memories are limited to 600 characters. Split it into separate memories.');
  return t;
}

const cleanCategory = (c) => (CATEGORIES.includes(c) ? c : 'fact');
const cleanImportance = (n) => clamp(Math.round(Number(n)) || 3, 1, 5);

export function getMemoryRow(id) {
  return q.get('SELECT * FROM memories WHERE id = ?', id);
}

export function requireMemory(id) {
  const r = getMemoryRow(id);
  if (!r) throw notFound('Memory');
  return r;
}

export function listMemories(characterId, { search = '', status = 'active', category = '' } = {}) {
  if (!getCharacterRow(characterId)) throw notFound('Character');
  const where = ['character_id = ?'];
  const params = [characterId];
  if (status && status !== 'all') {
    where.push('status = ?');
    params.push(status);
  }
  if (category) {
    where.push('category = ?');
    params.push(category);
  }
  const s = String(search || '').trim();
  if (s) {
    where.push("content LIKE ? ESCAPE '\\'");
    params.push(`%${s.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
  }
  return q
    .all(`SELECT * FROM memories WHERE ${where.join(' AND ')} ORDER BY pinned DESC, importance DESC, updated_at DESC LIMIT 1000`, ...params)
    .map(toMemory);
}

export function memoryCounts(characterId) {
  const rows = q.all('SELECT status, COUNT(*) AS n FROM memories WHERE character_id = ? GROUP BY status', characterId);
  const out = { active: 0, pending: 0, superseded: 0 };
  for (const r of rows) out[r.status] = r.n;
  return out;
}

/** A memory the user writes by hand. */
export function createMemory(characterId, input) {
  if (!getCharacterRow(characterId)) throw notFound('Character');
  const content = cleanContent(input.content);
  const id = uid();
  const t = now();
  q.run(
    `INSERT INTO memories (id, character_id, content, category, importance, pinned, source, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?, 'user', 'active', ?, ?)`,
    id, characterId, content, cleanCategory(input.category), cleanImportance(input.importance ?? 4), !!input.pinned, t, t
  );
  return toMemory(getMemoryRow(id));
}

export function updateMemory(id, input) {
  const row = requireMemory(id);
  const sets = [];
  const vals = [];
  if ('content' in input) {
    sets.push('content = ?', "source = 'user'"); // an edited memory is now the user's own statement
    vals.push(cleanContent(input.content));
  }
  if ('category' in input) {
    sets.push('category = ?');
    vals.push(cleanCategory(input.category));
  }
  if ('importance' in input) {
    sets.push('importance = ?');
    vals.push(cleanImportance(input.importance));
  }
  if ('pinned' in input) {
    sets.push('pinned = ?');
    vals.push(!!input.pinned);
  }
  if (sets.length) {
    sets.push('updated_at = ?');
    q.run(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`, ...vals, now(), row.id);
  }
  return toMemory(getMemoryRow(id));
}

export function deleteMemory(id) {
  requireMemory(id);
  tx(() => {
    q.run('UPDATE memories SET superseded_by = NULL WHERE superseded_by = ?', id);
    q.run('UPDATE memories SET conflicts_with = NULL WHERE conflicts_with = ?', id);
    q.run('DELETE FROM memories WHERE id = ?', id);
  });
}

/** Approve a pending memory. If it conflicted with an existing one, the user's approval settles it. */
export function approveMemory(id) {
  const row = requireMemory(id);
  if (row.status !== 'pending') throw bad('Only memories awaiting review can be approved.');
  tx(() => {
    const t = now();
    q.run("UPDATE memories SET status = 'active', source = 'user', conflicts_with = NULL, updated_at = ? WHERE id = ?", t, id);
    if (row.conflicts_with) {
      q.run("UPDATE memories SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ? AND status = 'active'", id, t, row.conflicts_with);
    }
  });
  return toMemory(getMemoryRow(id));
}

/** Bring a superseded memory back (the user decided the old version was right). */
export function restoreMemory(id) {
  const row = requireMemory(id);
  if (row.status !== 'superseded') throw bad('Only replaced memories can be restored.');
  tx(() => {
    const t = now();
    q.run("UPDATE memories SET status = 'active', superseded_by = NULL, updated_at = ? WHERE id = ?", t, id);
    if (row.superseded_by) {
      q.run("UPDATE memories SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ? AND status = 'active'", id, t, row.superseded_by);
    }
  });
  return toMemory(getMemoryRow(id));
}

export function clearMemories(characterId, { includeHistory = true } = {}) {
  if (!getCharacterRow(characterId)) throw notFound('Character');
  const r = includeHistory
    ? q.run('DELETE FROM memories WHERE character_id = ?', characterId)
    : q.run("DELETE FROM memories WHERE character_id = ? AND status != 'superseded'", characterId);
  return { deleted: Number(r.changes) };
}

export function exportMemories(characterId) {
  const c = getCharacterRow(characterId);
  if (!c) throw notFound('Character');
  return {
    format: 'folio-memories',
    version: 1,
    exportedAt: now(),
    character: { id: c.id, name: c.name },
    memories: q.all('SELECT * FROM memories WHERE character_id = ? ORDER BY created_at', characterId).map(toMemory),
  };
}

export function importMemories(characterId, payload) {
  if (!getCharacterRow(characterId)) throw notFound('Character');
  const list = payload?.format === 'folio-memories' ? payload.memories : null;
  if (!Array.isArray(list)) throw bad('That file is not a Folio memory export.');
  const have = new Set(q.all('SELECT content FROM memories WHERE character_id = ?', characterId).map((r) => r.content.toLowerCase()));
  let added = 0;
  let skipped = 0;
  tx(() => {
    for (const m of list.slice(0, 5000)) {
      let content;
      try {
        content = cleanContent(m.content);
      } catch {
        skipped++;
        continue;
      }
      if (have.has(content.toLowerCase())) {
        skipped++;
        continue;
      }
      have.add(content.toLowerCase());
      const t = now();
      q.run(
        `INSERT INTO memories (id, character_id, content, category, importance, pinned, source, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,'user',?,?,?)`,
        uid(), characterId, content, cleanCategory(m.category), cleanImportance(m.importance),
        !!m.pinned && m.status !== 'superseded', m.status === 'superseded' ? 'superseded' : 'active', t, t
      );
      added++;
    }
  });
  return { added, skipped };
}

/* ------------------------------------------------------------------------------------------------
 * Applying extracted operations
 * ---------------------------------------------------------------------------------------------- */

function findSimilar(characterId, content) {
  const rows = q.all("SELECT * FROM memories WHERE character_id = ? AND status IN ('active','pending')", characterId);
  let best = null;
  let bestScore = 0;
  for (const r of rows) {
    const lower = r.content.toLowerCase();
    const c = content.toLowerCase();
    let s = jaccard(r.content, content);
    if (lower === c || lower.includes(c) || c.includes(lower)) s = Math.max(s, 0.95);
    if (s > bestScore) {
      best = r;
      bestScore = s;
    }
  }
  return bestScore >= 0.72 ? best : null;
}

function insertAuto(characterId, { content, category, importance, conversationId, messageId, status, conflictsWith }) {
  const id = uid();
  const t = now();
  q.run(
    `INSERT INTO memories (id, character_id, content, category, importance, pinned, source, status, source_conversation_id,
       source_message_id, conflicts_with, created_at, updated_at)
     VALUES (?,?,?,?,?,0,'auto',?,?,?,?,?,?)`,
    id, characterId, content, category, importance, status, conversationId ?? null, messageId ?? null, conflictsWith ?? null, t, t
  );
  return id;
}

/**
 * Apply operations produced by the extractor (or the heuristic fallback).
 * Rules:
 *  - a near-duplicate reinforces the existing memory instead of adding a copy (recurring facts rank higher)
 *  - an "update" replaces an auto memory directly; the old version is kept as history
 *  - an update that would overwrite a pinned or user-written memory is held for review, unless the user
 *    explicitly restated the fact and the memory is not pinned
 *  - with "require approval" on, everything new waits for review and is not used in prompts until approved
 */
export function applyOperations(characterId, ops, { conversationId, messageId, requireApproval = false } = {}) {
  const result = { added: 0, updated: 0, reinforced: 0, pending: 0, skipped: 0 };
  tx(() => {
    for (const op of ops) {
      let content;
      try {
        if (op.op !== 'reinforce') content = cleanContent(op.content);
      } catch {
        result.skipped++;
        continue;
      }
      const category = cleanCategory(op.category);
      const importance = cleanImportance(op.importance);
      const target = op.id ? getMemoryRow(op.id) : null;
      const validTarget = target && target.character_id === characterId && target.status === 'active' ? target : null;

      if (op.op === 'reinforce') {
        if (!validTarget) { result.skipped++; continue; }
        q.run('UPDATE memories SET recurrence = recurrence + 1, updated_at = ? WHERE id = ?', now(), validTarget.id);
        result.reinforced++;
        continue;
      }

      if (op.op === 'update' && validTarget) {
        if (validTarget.content.toLowerCase() === content.toLowerCase()) {
          q.run('UPDATE memories SET recurrence = recurrence + 1, updated_at = ? WHERE id = ?', now(), validTarget.id);
          result.reinforced++;
          continue;
        }
        const protectedMemory = validTarget.pinned || validTarget.source === 'user';
        const allowOverride = !validTarget.pinned && op.explicit === true;
        if (requireApproval || (protectedMemory && !allowOverride)) {
          insertAuto(characterId, { content, category, importance, conversationId, messageId, status: 'pending', conflictsWith: validTarget.id });
          result.pending++;
          continue;
        }
        const newId = insertAuto(characterId, { content, category, importance: Math.max(importance, validTarget.importance), conversationId, messageId, status: 'active' });
        q.run("UPDATE memories SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?", newId, now(), validTarget.id);
        result.updated++;
        continue;
      }

      // "add" (also the fallback for an update whose target no longer exists)
      const dup = findSimilar(characterId, content);
      if (dup) {
        if (dup.status === 'active') {
          q.run('UPDATE memories SET recurrence = recurrence + 1, importance = MAX(importance, ?), updated_at = ? WHERE id = ?', importance, now(), dup.id);
          result.reinforced++;
        } else result.skipped++;
        continue;
      }
      const status = requireApproval ? 'pending' : 'active';
      insertAuto(characterId, { content, category, importance, conversationId, messageId, status });
      if (status === 'pending') result.pending++;
      else result.added++;
    }
  });
  return result;
}
