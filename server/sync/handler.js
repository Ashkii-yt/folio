import { runAs } from '../db.js';
import { getContext, listUsernames, createAccountFromSync, passwordRecord } from '../accounts.js';
import { serverIdentity } from '../identity.js';
import { localManifest, localRows, applyChanges, recordPeer } from './engine.js';
import { sharedManifest, sharedRows, sharedApply } from '../shared.js';
import { PROTOCOL } from './tables.js';
import { SyncError } from './rpc.js';
import { trust, usePairingCode } from './trust.js';

const need = (user) => {
  const ctx = getContext(String(user || ''));
  if (!ctx) throw new SyncError(`This server has no account "${user}".`);
  return ctx;
};
const peerFrom = (f) => {
  if (!f || typeof f.databaseId !== 'string' || typeof f.serverId !== 'string') throw new SyncError('Missing the sending database.');
  return { databaseId: f.databaseId.slice(0, 60), serverId: f.serverId.slice(0, 80), serverName: String(f.serverName || '').slice(0, 60) };
};

/**
 * What a paired server (or an ssh login) may ask this one to do.
 * `conn` is { peerId, trusted }. Anything not trusted can only say hello or present a pairing code.
 */
export function makeHandler(conn) {
  return async (method, p) => {
    const me = serverIdentity();
    if (method === 'hello') {
      if (p.protocol !== PROTOCOL) throw new SyncError(`That server speaks sync protocol ${p.protocol}, this one speaks ${PROTOCOL}.`, 'Update both servers to the same version of Folio.');
      return { serverId: me.serverId, name: me.name, protocol: PROTOCOL, trusted: conn.trusted };
    }
    if (method === 'pair') {
      if (!conn.peerId) throw new SyncError('Pairing needs a network connection, not ssh.');
      if (!usePairingCode(p.code)) throw new SyncError('That pairing code is wrong or has expired.', 'Run `npm run pair` on this server again to get a fresh code.');
      trust(conn.peerId, p.name);
      conn.trusted = true;
      return { serverId: me.serverId, name: me.name };
    }
    if (!conn.trusted) throw new SyncError('This server has not been paired with you.', 'Run `npm run pair` there, then `npm run link -- <server id> <code>` here.');
    switch (method) {
      case 'accounts':
        return listUsernames();
      case 'ensureAccount':
        return { created: createAccountFromSync(p.username, p.password) };
      case 'accountRecord': {
        const pw = passwordRecord(String(p.username));
        if (!pw) throw new SyncError(`No account "${p.username}".`);
        return { password: pw };
      }
      case 'manifest':
        return runAs(need(p.user), localManifest);
      case 'rows':
        return { rows: runAs(need(p.user), () => localRows(p.keys)) };
      case 'apply':
        return runAs(need(p.user), () => applyChanges({ rows: p.rows, tombstones: p.tombstones }));
      case 'done':
        runAs(need(p.user), () => recordPeer(peerFrom(p.from), p.action || 'sync', p.stats));
        return { ok: true };
      case 'shared.manifest':
        return sharedManifest();
      case 'shared.rows':
        return { rows: sharedRows(p.ids) };
      case 'shared.apply':
        return sharedApply(p);
      default:
        throw new SyncError(`Unknown request "${method}".`);
    }
  };
}
