import { q, tx } from '../db.js';
import { bad, notFound, uid, now, safeJson } from '../util.js';
import { getCharacterRow } from './characters.js';
import { getSettings } from '../settings.js';
import { getProviderRow } from '../providers/index.js';

export function fillTemplate(text, { char, user }) {
  return String(text || '').replace(/\{\{\s*char\s*\}\}/gi, char).replace(/\{\{\s*user\s*\}\}/gi, user || 'you');
}

export function toMessage(r) {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    seq: r.seq,
    role: r.role,
    content: r.content,
    createdAt: r.created_at,
    editedAt: r.edited_at,
    model: r.model,
    meta: safeJson(r.meta, {}) || {},
  };
}

export function toConversation(r) {
  return {
    id: r.id,
    characterId: r.character_id,
    title: r.title,
    providerId: r.provider_id,
    model: r.model,
    extractedUpto: r.extracted_upto,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...(r.message_count !== undefined ? { messageCount: r.message_count, preview: r.preview ?? '' } : {}),
  };
}

export function getConversationRow(id) {
  return q.get('SELECT * FROM conversations WHERE id = ?', id);
}

export function requireConversation(id) {
  const row = getConversationRow(id);
  if (!row) throw notFound('Conversation');
  return row;
}

export function listConversations(characterId) {
  return q
    .all(
      `SELECT v.*,
         (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = v.id) AS message_count,
         (SELECT substr(m.content, 1, 140) FROM messages m WHERE m.conversation_id = v.id ORDER BY m.seq DESC LIMIT 1) AS preview
       FROM conversations v WHERE v.character_id = ? ORDER BY v.updated_at DESC`,
      characterId
    )
    .map(toConversation);
}

export function getMessages(conversationId) {
  return q.all('SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq', conversationId).map(toMessage);
}

export function getConversation(id) {
  const row = requireConversation(id);
  return { ...toConversation(row), messages: getMessages(id) };
}

export function addMessage(conversationId, { role, content, model = '', meta = {} }) {
  return tx(() => {
    const { next } = q.get('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages WHERE conversation_id = ?', conversationId);
    const id = uid();
    const t = now();
    q.run(
      'INSERT INTO messages (id, conversation_id, seq, role, content, created_at, model, meta) VALUES (?,?,?,?,?,?,?,?)',
      id, conversationId, next, role, content, t, model, JSON.stringify(meta)
    );
    q.run('UPDATE conversations SET updated_at = ? WHERE id = ?', t, conversationId);
    return toMessage(q.get('SELECT * FROM messages WHERE id = ?', id));
  });
}

export function createConversation(characterId, { title, providerId, model } = {}) {
  const character = getCharacterRow(characterId);
  if (!character) throw notFound('Character');
  if (providerId && !getProviderRow(providerId)) throw bad('That provider no longer exists.');
  const id = uid();
  const t = now();
  q.run(
    'INSERT INTO conversations (id, character_id, title, provider_id, model, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
    id, characterId, (title || 'New conversation').slice(0, 120), providerId || null, model || '', t, t
  );
  const greeting = fillTemplate(character.greeting, { char: character.name, user: getSettings().userName }).trim();
  if (greeting) addMessage(id, { role: 'character', content: greeting, meta: { greeting: true } });
  return getConversation(id);
}

export function updateConversation(id, input) {
  requireConversation(id);
  const sets = [];
  const vals = [];
  if ('title' in input) {
    const title = String(input.title || '').trim();
    if (!title) throw bad('A conversation needs a title.');
    sets.push('title = ?');
    vals.push(title.slice(0, 120));
  }
  if ('providerId' in input) {
    if (input.providerId && !getProviderRow(input.providerId)) throw bad('That provider no longer exists.');
    sets.push('provider_id = ?');
    vals.push(input.providerId || null);
  }
  if ('model' in input) {
    sets.push('model = ?');
    vals.push(String(input.model || '').trim().slice(0, 200));
  }
  if (sets.length) q.run(`UPDATE conversations SET ${sets.join(', ')} WHERE id = ?`, ...vals, id);
  return toConversation(getConversationRow(id));
}

export function deleteConversation(id) {
  requireConversation(id);
  q.run('DELETE FROM conversations WHERE id = ?', id);
}

export function getMessage(id) {
  const r = q.get('SELECT * FROM messages WHERE id = ?', id);
  if (!r) throw notFound('Message');
  return toMessage(r);
}

export function editMessage(id, content) {
  const m = getMessage(id);
  const text = String(content ?? '');
  if (!text.trim()) throw bad('A message cannot be empty.');
  if (text.length > 60000) throw bad('That message is too long.');
  q.run('UPDATE messages SET content = ?, edited_at = ? WHERE id = ?', text, now(), id);
  q.run('DELETE FROM summaries WHERE conversation_id = ? AND from_seq <= ? AND to_seq >= ?', m.conversationId, m.seq, m.seq);
  // Notes extracted from the old wording must be re-checked against the new text.
  q.run('UPDATE conversations SET extracted_upto = MIN(extracted_upto, ?) WHERE id = ?', Math.max(0, m.seq - 1), m.conversationId);
  return getMessage(id);
}

/** Delete one message, or this message and everything after it. */
export function deleteMessages(id, { fromHere = false } = {}) {
  const m = getMessage(id);
  tx(() => {
    if (fromHere) q.run('DELETE FROM messages WHERE conversation_id = ? AND seq >= ?', m.conversationId, m.seq);
    else q.run('DELETE FROM messages WHERE id = ?', id);
    // Any summary that was written from the removed text is stale; it will be regenerated from what remains.
    if (fromHere) q.run('DELETE FROM summaries WHERE conversation_id = ? AND to_seq >= ?', m.conversationId, m.seq);
    else q.run('DELETE FROM summaries WHERE conversation_id = ? AND from_seq <= ? AND to_seq >= ?', m.conversationId, m.seq, m.seq);
    afterRemoval(m.conversationId);
  });
  return { conversationId: m.conversationId };
}

export function deleteMessagesAfter(conversationId, seq) {
  tx(() => {
    q.run('DELETE FROM messages WHERE conversation_id = ? AND seq > ?', conversationId, seq);
    afterRemoval(conversationId);
  });
}

/** Keep derived data consistent when messages disappear: summaries that covered them are stale. */
function afterRemoval(conversationId) {
  const max = q.get('SELECT COALESCE(MAX(seq), 0) AS m FROM messages WHERE conversation_id = ?', conversationId).m;
  q.run('DELETE FROM summaries WHERE conversation_id = ? AND to_seq > ?', conversationId, max);
  q.run('UPDATE conversations SET extracted_upto = MIN(extracted_upto, ?), updated_at = ? WHERE id = ?', max, now(), conversationId);
}

export function titleFrom(text) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  return t.length > 56 ? `${t.slice(0, 55).trimEnd()}…` : t || 'New conversation';
}
