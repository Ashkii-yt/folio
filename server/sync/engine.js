import { q, tx } from '../db.js';
import { bad, now } from '../util.js';
import { SYNC_TABLES, TABLE_ORDER } from './tables.js';
import { serverIdentity, databaseId } from '../identity.js';

/* ------------------------------------------------------------------ local side (runs inside runAs(user)) */

export function localManifest() {
  const id = serverIdentity();
  const rows = {};
  for (const t of TABLE_ORDER) {
    rows[t] = q.all(`SELECT id, ${SYNC_TABLES[t].version} AS v FROM ${t}`).map((r) => [r.id, r.v]);
  }
  const tombstones = q.all('SELECT tbl, id, deleted_at FROM tombstones').map((r) => [r.tbl, r.id, r.deleted_at]);
  return { databaseId: databaseId(), serverId: id.serverId, serverName: id.name, rows, tombstones };
}

export function localRows(keys) {
  const out = {};
  for (const t of TABLE_ORDER) {
    const ids = (keys?.[t] || []).slice(0, 500);
    if (!ids.length) continue;
    const cols = Object.keys(SYNC_TABLES[t].cols).join(', ');
    out[t] = q.all(`SELECT ${cols} FROM ${t} WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids);
  }
  return out;
}

function clean(table, row) {
  const spec = SYNC_TABLES[table];
  const out = {};
  for (const [c, [type, max]] of Object.entries(spec.cols)) {
    let v = row?.[c];
    const nullable = type.endsWith('?');
    const base = type.replace('?', '');
    if (v === undefined || v === null) {
      if (!nullable) throw new Error(`missing ${c}`);
      out[c] = null;
      continue;
    }
    if (base === 'text') {
      if (typeof v !== 'string' || v.length > max) throw new Error(`bad ${c}`);
    } else {
      v = Number(v);
      if (!Number.isInteger(v) || v < 0 || v > max) throw new Error(`bad ${c}`);
    }
    if (spec.enums?.[c] && !spec.enums[c].includes(v)) throw new Error(`bad ${c}`);
    out[c] = v;
  }
  if (table === 'characters' && out.avatar && !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(out.avatar)) out.avatar = null;
  return out;
}

const localVersion = (t, id) => q.get(`SELECT ${SYNC_TABLES[t].version} AS v FROM ${t} WHERE id = ?`, id)?.v ?? null;

/**
 * Apply changes from another database. Newer wins, per row; a row is never overwritten by an older copy.
 * `rows` is { table: [row] }, `tombstones` is [[table, id, deletedAt]].
 */
export function applyChanges({ rows = {}, tombstones = [] } = {}) {
  const stats = { added: 0, updated: 0, deleted: 0, skipped: 0, warnings: [] };
  const warn = (m) => stats.warnings.length < 20 && stats.warnings.push(m);
  tx(() => {
    for (const t of TABLE_ORDER) {
      const spec = SYNC_TABLES[t];
      const cols = Object.keys(spec.cols);
      for (const raw of rows[t] || []) {
        let r;
        try {
          r = clean(t, raw);
        } catch (e) {
          stats.skipped++;
          warn(`${t}: ${e.message}`);
          continue;
        }
        const incoming = t === 'messages' ? r.edited_at || r.created_at : r[spec.version];
        const tomb = q.get('SELECT deleted_at FROM tombstones WHERE tbl = ? AND id = ?', t, r.id);
        if (tomb && tomb.deleted_at >= incoming) { stats.skipped++; continue; }
        const have = localVersion(t, r.id);
        if (have !== null && have >= incoming) { stats.skipped++; continue; }
        try {
          q.run('SAVEPOINT row_apply');
          if (have === null) {
            const local = spec.local || {};
            const insertCols = [...cols, ...Object.keys(local)];
            const vals = [...cols.map((c) => r[c]), ...Object.values(local)];
            if (t === 'messages') {
              const clash = q.get('SELECT id FROM messages WHERE conversation_id = ? AND seq = ?', r.conversation_id, r.seq);
              if (clash) vals[cols.indexOf('seq')] = q.get('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM messages WHERE conversation_id = ?', r.conversation_id).n;
            }
            q.run(`INSERT INTO ${t} (${insertCols.join(',')}) VALUES (${insertCols.map(() => '?').join(',')})`, ...vals);
            stats.added++;
          } else {
            const skip = new Set(['id', ...(spec.keepOnUpdate || [])]);
            const upd = cols.filter((c) => !skip.has(c));
            q.run(`UPDATE ${t} SET ${upd.map((c) => (spec.merge?.[c] ? `${c} = ${spec.merge[c]}` : `${c} = ?`)).join(', ')} WHERE id = ?`, ...upd.map((c) => r[c]), r.id);
            stats.updated++;
          }
          q.run('RELEASE row_apply');
        } catch (e) {
          q.run('ROLLBACK TO row_apply');
          q.run('RELEASE row_apply');
          stats.skipped++;
          warn(`${t} ${r.id}: ${String(e.message).slice(0, 80)}`);
        }
      }
    }
    // Deletions come last, so a row that was changed after being deleted elsewhere (and so was just applied) survives.
    for (const [t, id, at] of tombstones) {
      if (!SYNC_TABLES[t] || typeof id !== 'string' || typeof at !== 'string' || at.length > 40) { stats.skipped++; continue; }
      const have = localVersion(t, id);
      if (have !== null && have > at) { stats.skipped++; continue; }
      if (have !== null) {
        q.run(`DELETE FROM ${t} WHERE id = ?`, id);
        stats.deleted++;
      }
      q.run('INSERT INTO tombstones (tbl, id, deleted_at) VALUES (?,?,?) ON CONFLICT(tbl, id) DO UPDATE SET deleted_at = MAX(deleted_at, excluded.deleted_at)', t, id, at);
    }
  });
  return stats;
}

export function recordPeer(peer, action, stats) {
  q.run(
    `INSERT INTO sync_peers (peer_database_id, peer_server_id, peer_server_name, last_sync_at, last_action, last_stats)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(peer_database_id) DO UPDATE SET peer_server_id=excluded.peer_server_id, peer_server_name=excluded.peer_server_name,
       last_sync_at=excluded.last_sync_at, last_action=excluded.last_action, last_stats=excluded.last_stats`,
    String(peer.databaseId), String(peer.serverId), String(peer.serverName || '').slice(0, 60), now(), String(action).slice(0, 20), JSON.stringify(stats || {})
  );
}

export const listPeers = () => q.all('SELECT * FROM sync_peers ORDER BY last_sync_at DESC');

/* ------------------------------------------------------------------ planning (pure, works on two manifests) */

/**
 * Decide what each side needs. For every record the newer state wins; a deletion beats an edit only if it
 * happened after the edit.
 */
export function plan(local, remote) {
  const state = (m) => {
    const map = new Map();
    for (const t of TABLE_ORDER) for (const [id, v] of m.rows[t] || []) map.set(`${t}\u0000${id}`, { row: v });
    for (const [t, id, at] of m.tombstones || []) {
      const k = `${t}\u0000${id}`;
      const cur = map.get(k);
      if (!cur) map.set(k, { tomb: at });
      else if (at > cur.row) map.set(k, { tomb: at }); // deleted after its last edit
    }
    return map;
  };
  const L = state(local);
  const R = state(remote);
  const out = { push: { rows: {}, tombstones: [] }, pull: { rows: {}, tombstones: [] } };
  const stamp = (s) => s.row ?? s.tomb;
  for (const k of new Set([...L.keys(), ...R.keys()])) {
    const [t, id] = k.split('\u0000');
    const l = L.get(k);
    const r = R.get(k);
    const give = (to, s) => {
      if (s.row !== undefined) (out[to].rows[t] ||= []).push(id);
      else out[to].tombstones.push([t, id, s.tomb]);
    };
    if (l && !r) give('push', l);
    else if (r && !l) give('pull', r);
    else if (stamp(l) > stamp(r)) give('push', l);
    else if (stamp(r) > stamp(l)) give('pull', r);
  }
  const count = (side) => Object.values(side.rows).reduce((n, a) => n + a.length, 0) + side.tombstones.length;
  out.summary = { toSend: count(out.push), toReceive: count(out.pull) };
  return out;
}

export { bad };
