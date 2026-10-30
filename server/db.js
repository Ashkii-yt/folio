import { DatabaseSync } from 'node:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';

/**
 * One SQLite database per account, in data/<username>/folio.db.
 * Request handlers run inside runAs(userContext, ...), and q / tx below resolve to that user's
 * database, so service code never has to know which account it is serving.
 */

const MIGRATIONS = [
  // v1: full initial schema
  `
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE providers (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    type           TEXT NOT NULL,
    base_url       TEXT NOT NULL,
    api_key_enc    TEXT,
    headers_enc    TEXT,
    default_model  TEXT NOT NULL DEFAULT '',
    context_length INTEGER,
    temperature    REAL,
    top_p          REAL,
    top_k          INTEGER,
    max_tokens     INTEGER,
    timeout_ms     INTEGER NOT NULL DEFAULT 120000,
    enabled        INTEGER NOT NULL DEFAULT 1,
    remote_ack     INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  );

  CREATE TABLE characters (
    id                     TEXT PRIMARY KEY,
    name                   TEXT NOT NULL,
    description            TEXT NOT NULL DEFAULT '',
    personality            TEXT NOT NULL DEFAULT '',
    background             TEXT NOT NULL DEFAULT '',
    speaking_style         TEXT NOT NULL DEFAULT '',
    goals                  TEXT NOT NULL DEFAULT '',
    example_dialogue       TEXT NOT NULL DEFAULT '',
    greeting               TEXT NOT NULL DEFAULT '',
    system_prompt_addition TEXT NOT NULL DEFAULT '',
    avatar                 TEXT,
    tags                   TEXT NOT NULL DEFAULT '[]',
    pinned                 INTEGER NOT NULL DEFAULT 0,
    provider_id            TEXT REFERENCES providers(id) ON DELETE SET NULL,
    model                  TEXT NOT NULL DEFAULT '',
    memory_enabled         INTEGER NOT NULL DEFAULT 1,
    auto_extract           INTEGER,
    last_chat_at           TEXT,
    created_at             TEXT NOT NULL,
    updated_at             TEXT NOT NULL
  );

  CREATE TABLE conversations (
    id             TEXT PRIMARY KEY,
    character_id   TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    title          TEXT NOT NULL DEFAULT 'New conversation',
    provider_id    TEXT REFERENCES providers(id) ON DELETE SET NULL,
    model          TEXT NOT NULL DEFAULT '',
    extracted_upto INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  );
  CREATE INDEX idx_conversations_character ON conversations(character_id, updated_at DESC);

  CREATE TABLE messages (
    rid             INTEGER PRIMARY KEY AUTOINCREMENT,
    id              TEXT NOT NULL UNIQUE,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    seq             INTEGER NOT NULL,
    role            TEXT NOT NULL CHECK (role IN ('user','character')),
    content         TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    edited_at       TEXT,
    model           TEXT NOT NULL DEFAULT '',
    meta            TEXT NOT NULL DEFAULT '{}'
  );
  CREATE UNIQUE INDEX idx_messages_conv_seq ON messages(conversation_id, seq);

  CREATE TABLE memories (
    rid                    INTEGER PRIMARY KEY AUTOINCREMENT,
    id                     TEXT NOT NULL UNIQUE,
    character_id           TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    content                TEXT NOT NULL,
    category               TEXT NOT NULL DEFAULT 'fact',
    importance             INTEGER NOT NULL DEFAULT 3,
    pinned                 INTEGER NOT NULL DEFAULT 0,
    source                 TEXT NOT NULL DEFAULT 'auto' CHECK (source IN ('auto','user')),
    status                 TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending','superseded')),
    source_conversation_id TEXT,
    source_message_id      TEXT,
    superseded_by          TEXT,
    conflicts_with         TEXT,
    recurrence             INTEGER NOT NULL DEFAULT 1,
    use_count              INTEGER NOT NULL DEFAULT 0,
    last_used_at           TEXT,
    created_at             TEXT NOT NULL,
    updated_at             TEXT NOT NULL
  );
  CREATE INDEX idx_memories_character ON memories(character_id, status);

  CREATE TABLE summaries (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    from_seq        INTEGER NOT NULL,
    to_seq          INTEGER NOT NULL,
    content         TEXT NOT NULL,
    method          TEXT NOT NULL DEFAULT 'model',
    created_at      TEXT NOT NULL
  );
  CREATE INDEX idx_summaries_conv ON summaries(conversation_id, to_seq);

  CREATE VIRTUAL TABLE memories_fts USING fts5(
    content, category, content='memories', content_rowid='rid', tokenize='porter unicode61'
  );
  CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, content, category) VALUES (new.rid, new.content, new.category);
  END;
  CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, category) VALUES ('delete', old.rid, old.content, old.category);
  END;
  CREATE TRIGGER memories_au AFTER UPDATE OF content, category ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, category) VALUES ('delete', old.rid, old.content, old.category);
    INSERT INTO memories_fts(rowid, content, category) VALUES (new.rid, new.content, new.category);
  END;

  CREATE VIRTUAL TABLE messages_fts USING fts5(
    content, content='messages', content_rowid='rid', tokenize='porter unicode61'
  );
  CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content) VALUES (new.rid, new.content);
  END;
  CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rid, old.content);
  END;
  CREATE TRIGGER messages_au AFTER UPDATE OF content ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rid, old.content);
    INSERT INTO messages_fts(rowid, content) VALUES (new.rid, new.content);
  END;
  `,
  // v2: where a character came from when it was added from another user's shared card
  `
  ALTER TABLE characters ADD COLUMN origin_shared_id TEXT;
  ALTER TABLE characters ADD COLUMN origin_owner TEXT;
  `,
  // v3: portrait image generation settings (one row)
  `
  CREATE TABLE image_config (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    provider    TEXT NOT NULL DEFAULT 'horde',
    base_url    TEXT NOT NULL DEFAULT '',
    model       TEXT NOT NULL DEFAULT '',
    size        TEXT NOT NULL DEFAULT '',
    api_key_enc TEXT,
    remote_ack  INTEGER NOT NULL DEFAULT 0,
    updated_at  TEXT NOT NULL
  );
  `,
  // v4: identity, sync bookkeeping, and portrait account id
  `
  ALTER TABLE image_config ADD COLUMN account_id TEXT NOT NULL DEFAULT '';

  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  INSERT INTO meta (key, value) VALUES ('database_id', 'db_' || lower(hex(randomblob(10))));
  INSERT INTO meta (key, value) VALUES ('created_at', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

  -- Deleted rows are remembered so a deletion can travel to other servers instead of the row being copied back.
  CREATE TABLE tombstones (
    tbl        TEXT NOT NULL,
    id         TEXT NOT NULL,
    deleted_at TEXT NOT NULL,
    PRIMARY KEY (tbl, id)
  );
  CREATE TABLE sync_peers (
    peer_database_id TEXT PRIMARY KEY,
    peer_server_id   TEXT NOT NULL,
    peer_server_name TEXT NOT NULL DEFAULT '',
    last_sync_at     TEXT NOT NULL,
    last_action      TEXT NOT NULL DEFAULT '',
    last_stats       TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TRIGGER characters_tomb AFTER DELETE ON characters BEGIN
    INSERT OR REPLACE INTO tombstones (tbl, id, deleted_at) VALUES ('characters', old.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  END;
  CREATE TRIGGER conversations_tomb AFTER DELETE ON conversations BEGIN
    INSERT OR REPLACE INTO tombstones (tbl, id, deleted_at) VALUES ('conversations', old.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  END;
  CREATE TRIGGER messages_tomb AFTER DELETE ON messages BEGIN
    INSERT OR REPLACE INTO tombstones (tbl, id, deleted_at) VALUES ('messages', old.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  END;
  CREATE TRIGGER memories_tomb AFTER DELETE ON memories BEGIN
    INSERT OR REPLACE INTO tombstones (tbl, id, deleted_at) VALUES ('memories', old.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  END;
  CREATE TRIGGER summaries_tomb AFTER DELETE ON summaries BEGIN
    INSERT OR REPLACE INTO tombstones (tbl, id, deleted_at) VALUES ('summaries', old.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  END;
  -- A row that comes back (for example from a backup restore) is alive again.
  CREATE TRIGGER characters_untomb AFTER INSERT ON characters BEGIN DELETE FROM tombstones WHERE tbl = 'characters' AND id = new.id; END;
  CREATE TRIGGER conversations_untomb AFTER INSERT ON conversations BEGIN DELETE FROM tombstones WHERE tbl = 'conversations' AND id = new.id; END;
  CREATE TRIGGER messages_untomb AFTER INSERT ON messages BEGIN DELETE FROM tombstones WHERE tbl = 'messages' AND id = new.id; END;
  CREATE TRIGGER memories_untomb AFTER INSERT ON memories BEGIN DELETE FROM tombstones WHERE tbl = 'memories' AND id = new.id; END;
  CREATE TRIGGER summaries_untomb AFTER INSERT ON summaries BEGIN DELETE FROM tombstones WHERE tbl = 'summaries' AND id = new.id; END;
  `,
];

function migrate(db) {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

export function openDatabase(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

const als = new AsyncLocalStorage();
export const runAs = (ctx, fn) => als.run(ctx, fn);
export const currentUser = () => als.getStore() || null;
function cur() {
  const c = als.getStore();
  if (!c) throw new Error('No signed-in user for this operation.');
  return c;
}
export const dbFile = () => path.join(cur().dir, 'folio.db');

/** node:sqlite rejects undefined and booleans, so normalise bound values. */
const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);

export const q = {
  get: (sql, ...p) => cur().db.prepare(sql).get(...p.map(norm)),
  all: (sql, ...p) => cur().db.prepare(sql).all(...p.map(norm)),
  run: (sql, ...p) => cur().db.prepare(sql).run(...p.map(norm)),
};

/** Synchronous transaction helper (node:sqlite is synchronous, so never await inside fn). */
export function tx(fn) {
  const { db } = cur();
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function closeDatabase(db) {
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    /* ignore */
  }
  db.close();
}
