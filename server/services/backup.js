import fs from 'node:fs';
import { q, tx, db, DB_PATH } from '../db.js';
import { bad, now } from '../util.js';
import { VERSION } from '../config.js';

const TABLES = ['providers', 'characters', 'conversations', 'messages', 'memories', 'summaries'];
const SECRET_COLUMNS = { providers: ['api_key_enc', 'headers_enc'] };

const columnsOf = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name).filter((n) => n !== 'rid');

/** Full backup. API keys and custom header values are deliberately left out of the file. */
export function exportAll() {
  const out = { format: 'folio-backup', version: 1, exportedAt: now(), appVersion: VERSION, settings: {}, tables: {} };
  for (const r of q.all('SELECT key, value FROM settings')) out.settings[r.key] = r.value;
  for (const t of TABLES) {
    const skip = new Set(SECRET_COLUMNS[t] || []);
    const cols = columnsOf(t).filter((c) => !skip.has(c));
    out.tables[t] = q.all(`SELECT ${cols.join(', ')} FROM ${t}${t === 'messages' ? ' ORDER BY conversation_id, seq' : ''}`);
  }
  return out;
}

export function dataInfo() {
  const count = (t) => q.get(`SELECT COUNT(*) AS n FROM ${t}`).n;
  let size = 0;
  try {
    size = fs.statSync(DB_PATH).size;
  } catch {
    /* ignore */
  }
  return {
    path: DB_PATH,
    sizeBytes: size,
    counts: Object.fromEntries(TABLES.map((t) => [t, count(t)])),
  };
}

/** Restore replaces everything. Providers that already exist keep the keys stored on this machine. */
export function restoreAll(payload) {
  if (payload?.format !== 'folio-backup' || typeof payload.tables !== 'object') throw bad('That file is not a Folio backup.');
  if (payload.version !== 1) throw bad(`This backup was made by a newer version of Folio (format ${payload.version}).`);
  for (const t of TABLES) if (payload.tables[t] !== undefined && !Array.isArray(payload.tables[t])) throw bad(`The backup is damaged (${t}).`);

  const keep = new Map(q.all('SELECT id, api_key_enc, headers_enc FROM providers').map((r) => [r.id, r]));
  const counts = {};
  tx(() => {
    wipe('everything', { inTx: true });
    for (const t of TABLES) {
      const rows = payload.tables[t] || [];
      const allowed = new Set(columnsOf(t));
      let n = 0;
      for (const row of rows) {
        const cols = Object.keys(row).filter((c) => allowed.has(c) && !(SECRET_COLUMNS[t] || []).includes(c));
        if (!cols.length) continue;
        q.run(`INSERT INTO ${t} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...cols.map((c) => row[c]));
        n++;
      }
      counts[t] = n;
    }
    for (const [k, v] of Object.entries(payload.settings || {})) {
      if (typeof v === 'string') q.run('INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)', k, v);
    }
    for (const [id, secrets] of keep) {
      q.run('UPDATE providers SET api_key_enc = ?, headers_enc = ? WHERE id = ?', secrets.api_key_enc, secrets.headers_enc, id);
    }
  });
  const needKey = q.all('SELECT name FROM providers WHERE api_key_enc IS NULL AND type IN (\'openai\',\'anthropic\',\'gemini\')').map((r) => r.name);
  return { counts, providersNeedingKeys: needKey };
}

export function wipe(scope, { inTx = false } = {}) {
  const run = () => {
    // Children first; FTS tables are kept in sync by triggers.
    q.run('DELETE FROM summaries');
    q.run('DELETE FROM memories');
    q.run('DELETE FROM messages');
    q.run('DELETE FROM conversations');
    q.run('DELETE FROM characters');
    if (scope === 'everything') {
      q.run('DELETE FROM providers');
      q.run('DELETE FROM settings');
    }
  };
  if (inTx) run();
  else tx(run);
}
