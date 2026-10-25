import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { DATA_DIR } from './config.js';

export const DB_PATH = process.env.FOLIO_DB_PATH || path.join(DATA_DIR, 'folio.db');

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA busy_timeout = 5000;');

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
];

function migrate() {
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
migrate();

/** node:sqlite rejects undefined and booleans, so normalise bound values. */
const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);

export const q = {
  get: (sql, ...p) => db.prepare(sql).get(...p.map(norm)),
  all: (sql, ...p) => db.prepare(sql).all(...p.map(norm)),
  run: (sql, ...p) => db.prepare(sql).run(...p.map(norm)),
};

/** Synchronous transaction helper (node:sqlite is synchronous, so never await inside fn). */
export function tx(fn) {
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

export function closeDb() {
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    /* ignore */
  }
  db.close();
}
