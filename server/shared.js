import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';
import { currentUser } from './db.js';
import { bad, notFound, now, safeJson, HttpError } from './util.js';
import { getCharacter, createCharacter, cleanCharacterInput } from './services/characters.js';

/**
 * Characters that users choose to share live in one database for the whole server, data/shared.db.
 * Only the character card is stored (never chats, memories, provider settings or API keys).
 * Nobody can read another account's own folder through this; they can only copy a published card.
 */

const MAX_SHARED_PER_USER = 50;
const CARD_FIELDS = ['name', 'description', 'personality', 'background', 'speakingStyle', 'goals', 'exampleDialogue', 'greeting', 'systemPromptAddition', 'tags'];

let db = null;
function store() {
  if (db) return db;
  db = new DatabaseSync(path.join(DATA_DIR, 'shared.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS shared_characters (
      id         TEXT PRIMARY KEY,
      owner      TEXT NOT NULL,
      source_id  TEXT NOT NULL,
      name       TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      tags       TEXT NOT NULL DEFAULT '[]',
      card       TEXT NOT NULL,
      avatar     TEXT,
      adds       INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (owner, source_id)
    );
    CREATE INDEX IF NOT EXISTS idx_shared_updated ON shared_characters(updated_at DESC);
  `);
  return db;
}

export function closeShared() {
  try {
    db?.close();
  } catch {
    /* ignore */
  }
  db = null;
}

const me = () => {
  const u = currentUser();
  if (!u) throw new Error('No signed-in user for this operation.');
  return u.username;
};

const summary = (r, viewer) => ({
  id: r.id,
  owner: r.owner,
  name: r.name,
  description: r.description,
  tags: safeJson(r.tags, []),
  hasAvatar: !!r.has_avatar,
  adds: r.adds,
  updatedAt: r.updated_at,
  mine: r.owner === viewer,
});

export function listShared({ search = '', tag = '' } = {}) {
  const viewer = me();
  const rows = store()
    .prepare(
      `SELECT id, owner, name, description, tags, adds, updated_at, created_at, (avatar IS NOT NULL) AS has_avatar
       FROM shared_characters ORDER BY updated_at DESC LIMIT 500`
    )
    .all();
  const s = String(search).trim().toLowerCase();
  const t = String(tag).trim().toLowerCase();
  return rows
    .map((r) => summary(r, viewer))
    .filter((c) => (!t || c.tags.includes(t)) && (!s || [c.name, c.description, c.owner, ...c.tags].join(' ').toLowerCase().includes(s)));
}

function row(id) {
  const r = store().prepare('SELECT *, (avatar IS NOT NULL) AS has_avatar FROM shared_characters WHERE id = ?').get(String(id));
  if (!r) throw notFound('Shared character');
  return r;
}

/** Full card, so people can read exactly what they are adding (including the system prompt addition). */
export function getShared(id) {
  const r = row(id);
  return { ...summary(r, me()), card: safeJson(r.card, {}) };
}

export function getSharedAvatar(id) {
  const r = store().prepare('SELECT avatar, updated_at FROM shared_characters WHERE id = ?').get(String(id));
  const m = r?.avatar?.match(/^data:(image\/[a-z]+);base64,(.*)$/);
  return m ? { mime: m[1], data: Buffer.from(m[2], 'base64'), version: r.updated_at } : null;
}

/** What this user has published, keyed by their local character id. */
export function mySharedMap() {
  const rows = store().prepare('SELECT id, source_id, updated_at FROM shared_characters WHERE owner = ?').all(me());
  return Object.fromEntries(rows.map((r) => [r.source_id, { sharedId: r.id, updatedAt: r.updated_at }]));
}

/** Publish (or republish) a snapshot of one of the signed-in user's characters. */
export function publish(characterId) {
  const owner = me();
  const c = getCharacter(characterId, { withAvatar: true });
  if (c.origin && c.origin.owner !== owner) {
    // Re-sharing someone else's card is allowed only after the person has changed it into something of their own.
    const orig = store().prepare('SELECT card FROM shared_characters WHERE id = ?').get(c.origin.sharedId);
    if (orig && CARD_FIELDS.every((k) => JSON.stringify(safeJson(orig.card, {})[k] ?? null) === JSON.stringify(c[k] ?? null))) {
      throw bad(`${c.name} is still exactly ${c.origin.owner}'s card. Change it before sharing, or ask ${c.origin.owner} to share it.`, 'unchanged_copy');
    }
  }
  if (!c.name.trim()) throw bad('Give the character a name before sharing it.');
  const card = Object.fromEntries(CARD_FIELDS.map((k) => [k, c[k]]));
  const d = store();
  const existing = d.prepare('SELECT id FROM shared_characters WHERE owner = ? AND source_id = ?').get(owner, characterId);
  if (!existing) {
    const n = d.prepare('SELECT COUNT(*) AS n FROM shared_characters WHERE owner = ?').get(owner).n;
    if (n >= MAX_SHARED_PER_USER) throw bad(`You can share at most ${MAX_SHARED_PER_USER} characters. Unshare one first.`, 'share_limit');
  }
  const id = existing?.id || crypto.randomBytes(9).toString('base64url');
  const t = now();
  if (existing) {
    d.prepare('UPDATE shared_characters SET name=?, description=?, tags=?, card=?, avatar=?, updated_at=? WHERE id=?')
      .run(c.name, c.description, JSON.stringify(c.tags), JSON.stringify(card), c.avatar || null, t, id);
  } else {
    d.prepare('INSERT INTO shared_characters (id, owner, source_id, name, description, tags, card, avatar, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, owner, characterId, c.name, c.description, JSON.stringify(c.tags), JSON.stringify(card), c.avatar || null, t, t);
  }
  return { sharedId: id, updatedAt: t };
}

export function unpublish(characterId) {
  store().prepare('DELETE FROM shared_characters WHERE owner = ? AND source_id = ?').run(me(), characterId);
}

/** Remove a published card by its shared id. Only its owner can. */
export function unpublishShared(id) {
  const r = row(id);
  if (r.owner !== me()) throw new HttpError(403, 'Only the person who shared this can remove it.', 'forbidden');
  store().prepare('DELETE FROM shared_characters WHERE id = ?').run(r.id);
}

/** Copy a shared card into the signed-in user's own characters. Their chats and memories stay theirs alone. */
export function addShared(id) {
  const r = row(id);
  if (r.owner === me()) throw bad('That character is already yours.', 'own_character');
  const card = safeJson(r.card, {});
  const clean = cleanCharacterInput({ ...card, avatar: r.avatar || null, pinned: false });
  const created = createCharacter(clean, { sharedId: r.id, owner: r.owner });
  store().prepare('UPDATE shared_characters SET adds = adds + 1 WHERE id = ?').run(r.id);
  return created;
}
