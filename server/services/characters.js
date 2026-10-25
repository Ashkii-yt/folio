import { q, tx } from '../db.js';
import { bad, notFound, uid, now, safeJson } from '../util.js';
import { getProviderRow } from '../providers/index.js';

const TEXT_FIELDS = {
  description: 600,
  personality: 12000,
  background: 30000,
  speakingStyle: 12000,
  goals: 12000,
  exampleDialogue: 30000,
  greeting: 6000,
  systemPromptAddition: 40000,
};
const COLUMN = {
  description: 'description',
  personality: 'personality',
  background: 'background',
  speakingStyle: 'speaking_style',
  goals: 'goals',
  exampleDialogue: 'example_dialogue',
  greeting: 'greeting',
  systemPromptAddition: 'system_prompt_addition',
};
const LABEL = {
  description: 'Short description',
  personality: 'Personality',
  background: 'Background',
  speakingStyle: 'Speaking style',
  goals: 'Goals and motivations',
  exampleDialogue: 'Example dialogue',
  greeting: 'Greeting',
  systemPromptAddition: 'System prompt addition',
};

const AVATAR_RE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
const MAX_AVATAR = 600_000;

export function toCharacter(row, { withAvatar = false } = {}) {
  if (!row) return null;
  const c = {
    id: row.id,
    name: row.name,
    description: row.description,
    personality: row.personality,
    background: row.background,
    speakingStyle: row.speaking_style,
    goals: row.goals,
    exampleDialogue: row.example_dialogue,
    greeting: row.greeting,
    systemPromptAddition: row.system_prompt_addition,
    tags: safeJson(row.tags, []),
    pinned: !!row.pinned,
    providerId: row.provider_id,
    model: row.model,
    memoryEnabled: !!row.memory_enabled,
    autoExtract: row.auto_extract == null ? null : !!row.auto_extract,
    hasAvatar: !!row.has_avatar || !!row.avatar,
    avatarVersion: row.updated_at,
    lastChatAt: row.last_chat_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.conversation_count !== undefined) {
    c.conversationCount = row.conversation_count;
    c.memoryCount = row.memory_count;
    c.messageCount = row.message_count;
  }
  if (withAvatar) c.avatar = row.avatar || null;
  return c;
}

const LIST_SQL = `
  SELECT c.id, c.name, c.description, c.personality, c.background, c.speaking_style, c.goals, c.example_dialogue,
         c.greeting, c.system_prompt_addition, c.tags, c.pinned, c.provider_id, c.model, c.memory_enabled,
         c.auto_extract, c.last_chat_at, c.created_at, c.updated_at,
         (c.avatar IS NOT NULL) AS has_avatar,
         (SELECT COUNT(*) FROM conversations v WHERE v.character_id = c.id) AS conversation_count,
         (SELECT COUNT(*) FROM memories m WHERE m.character_id = c.id AND m.status != 'superseded') AS memory_count,
         (SELECT COUNT(*) FROM messages g JOIN conversations v ON v.id = g.conversation_id WHERE v.character_id = c.id) AS message_count
  FROM characters c`;

export function listCharacters() {
  return q.all(`${LIST_SQL} ORDER BY c.pinned DESC, c.name COLLATE NOCASE`).map((r) => toCharacter(r));
}

export function getCharacterRow(id) {
  return q.get('SELECT * FROM characters WHERE id = ?', id);
}

export function getCharacter(id, opts) {
  const row = getCharacterRow(id);
  if (!row) throw notFound('Character');
  return toCharacter(row, opts);
}

export function getCharacterAvatar(id) {
  const row = q.get('SELECT avatar, updated_at FROM characters WHERE id = ?', id);
  if (!row?.avatar) return null;
  const m = row.avatar.match(/^data:(image\/[a-z]+);base64,(.*)$/);
  if (!m) return null;
  return { mime: m[1], data: Buffer.from(m[2], 'base64'), version: row.updated_at };
}

/** Validate input. With partial=true only supplied fields are checked (used by PATCH). */
export function cleanCharacterInput(input, { partial = false } = {}) {
  if (typeof input !== 'object' || input === null) throw bad('Send the character as a JSON object.');
  const out = {};

  if (!partial || 'name' in input) {
    const name = String(input.name ?? '').trim();
    if (!name) throw bad('Give your character a name.', 'name_required');
    if (name.length > 80) throw bad('Character names can be at most 80 characters.');
    out.name = name;
  }

  for (const [key, max] of Object.entries(TEXT_FIELDS)) {
    if (!(key in input)) continue;
    const v = String(input[key] ?? '');
    if (v.length > max) throw bad(`${LABEL[key]} is too long (limit ${max.toLocaleString('en-US')} characters).`);
    out[key] = key === 'description' ? v.trim() : v.replace(/\r\n/g, '\n');
  }

  if ('tags' in input) {
    if (!Array.isArray(input.tags)) throw bad('Tags must be a list.');
    const tags = [...new Set(input.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean))];
    if (tags.length > 12) throw bad('Use at most 12 tags.');
    if (tags.some((t) => t.length > 30)) throw bad('Tags can be at most 30 characters.');
    out.tags = tags;
  }

  if ('avatar' in input) {
    if (input.avatar === null || input.avatar === '') out.avatar = null;
    else {
      const a = String(input.avatar);
      if (a.length > MAX_AVATAR) throw bad('That image is too large. Use one under about 400 KB.');
      if (!AVATAR_RE.test(a)) throw bad('Avatars must be PNG, JPEG, WebP or GIF images.');
      out.avatar = a;
    }
  }

  if ('pinned' in input) out.pinned = !!input.pinned;
  if ('memoryEnabled' in input) out.memoryEnabled = !!input.memoryEnabled;
  if ('autoExtract' in input) out.autoExtract = input.autoExtract == null ? null : !!input.autoExtract;

  if ('providerId' in input) {
    if (input.providerId) {
      if (!getProviderRow(input.providerId)) throw bad('That provider no longer exists.');
      out.providerId = input.providerId;
    } else out.providerId = null;
  }
  if ('model' in input) out.model = String(input.model || '').trim().slice(0, 200);

  return out;
}

const SQL_COLUMN = {
  name: 'name', tags: 'tags', avatar: 'avatar', pinned: 'pinned', providerId: 'provider_id', model: 'model',
  memoryEnabled: 'memory_enabled', autoExtract: 'auto_extract', ...COLUMN,
};

export function createCharacter(input) {
  const c = cleanCharacterInput(input);
  const id = uid();
  const t = now();
  q.run(
    `INSERT INTO characters (id, name, description, personality, background, speaking_style, goals, example_dialogue,
       greeting, system_prompt_addition, avatar, tags, pinned, provider_id, model, memory_enabled, auto_extract, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, c.name, c.description ?? '', c.personality ?? '', c.background ?? '', c.speakingStyle ?? '', c.goals ?? '',
    c.exampleDialogue ?? '', c.greeting ?? '', c.systemPromptAddition ?? '', c.avatar ?? null,
    JSON.stringify(c.tags ?? []), c.pinned ?? false, c.providerId ?? null, c.model ?? '',
    c.memoryEnabled ?? true, c.autoExtract ?? null, t, t
  );
  return getCharacter(id);
}

/** Only the fields present in the request are written, so editing one field never touches the others. */
export function updateCharacter(id, input) {
  if (!getCharacterRow(id)) throw notFound('Character');
  const c = cleanCharacterInput(input, { partial: true });
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(c)) {
    sets.push(`${SQL_COLUMN[k]} = ?`);
    vals.push(k === 'tags' ? JSON.stringify(v) : v);
  }
  if (sets.length) {
    sets.push('updated_at = ?');
    vals.push(now(), id);
    q.run(`UPDATE characters SET ${sets.join(', ')} WHERE id = ?`, ...vals);
  }
  return getCharacter(id);
}

export function deleteCharacter(id) {
  if (!getCharacterRow(id)) throw notFound('Character');
  q.run('DELETE FROM characters WHERE id = ?', id); // conversations, messages, memories cascade
}

export function duplicateCharacter(id) {
  const src = getCharacter(id, { withAvatar: true });
  const copy = createCharacter({
    ...src,
    name: `${src.name} (copy)`.slice(0, 80),
    pinned: false,
  });
  return copy;
}

export function exportCharacter(id) {
  const c = getCharacter(id, { withAvatar: true });
  const { id: _i, createdAt, updatedAt, lastChatAt, conversationCount, memoryCount, messageCount, hasAvatar, avatarVersion, providerId, model, ...rest } = c;
  return { format: 'folio-character', version: 1, exportedAt: now(), character: rest };
}

export function importCharacter(payload) {
  const data = payload?.format === 'folio-character' ? payload.character : payload;
  if (!data || typeof data !== 'object') throw bad('That file is not a Folio character export.');
  const { providerId, model, pinned, ...safe } = data;
  return createCharacter({ ...safe, pinned: false });
}

export function allConversationsFor(characterId) {
  return q.all('SELECT id FROM conversations WHERE character_id = ?', characterId).map((r) => r.id);
}

export function touchLastChat(characterId) {
  q.run('UPDATE characters SET last_chat_at = ? WHERE id = ?', now(), characterId);
}

export { tx };
