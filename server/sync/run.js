import { runAs } from '../db.js';
import { getContext, listUsernames, createAccountFromSync, passwordRecord } from '../accounts.js';
import { localManifest, localRows, applyChanges, recordPeer, plan } from './engine.js';
import { sharedManifest, sharedRows, sharedApply } from '../shared.js';
import { TABLE_ORDER } from './tables.js';
import { SyncError } from './rpc.js';

const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
const BATCH = { characters: 40 };
const total = (rows) => Object.values(rows).reduce((n, a) => n + a.length, 0);
const blank = () => ({ added: 0, updated: 0, deleted: 0, skipped: 0 });
const add = (into, s) => { for (const k of Object.keys(into)) into[k] += s?.[k] || 0; };
const describe = (rows, tombs) => `${TABLE_ORDER.map((t) => (rows[t]?.length ? `${rows[t].length} ${t}` : null)).filter(Boolean).join(', ') || 'nothing'}${tombs.length ? `, ${tombs.length} deletion${tombs.length === 1 ? '' : 's'}` : ''}`;

async function syncAccount({ user, client, mode, dryRun, log, stats }) {
  const ctx = getContext(user);
  const here = runAs(ctx, localManifest);
  const there = await client.call('manifest', { user });
  if (there.databaseId === here.databaseId) throw new SyncError(`${user}: both sides are the same database.`);
  const p = plan(here, there);
  const sendRows = mode === 'fetch' ? {} : p.push.rows;
  const sendTombs = mode === 'fetch' ? [] : p.push.tombstones;
  const getRows = mode === 'push' ? {} : p.pull.rows;
  const getTombs = mode === 'push' ? [] : p.pull.tombstones;
  log(`  ${user}: receive ${describe(getRows, getTombs)}; send ${describe(sendRows, sendTombs)}`);
  if (dryRun) return;
  const self = { databaseId: here.databaseId, serverId: here.serverId, serverName: here.serverName };
  for (const t of TABLE_ORDER) {
    for (const ids of chunk(getRows[t] || [], BATCH[t] || 300)) {
      const { rows } = await client.call('rows', { user, keys: { [t]: ids } });
      add(stats.received, runAs(ctx, () => applyChanges({ rows })));
    }
  }
  if (getTombs.length) add(stats.received, runAs(ctx, () => applyChanges({ tombstones: getTombs })));
  for (const t of TABLE_ORDER) {
    for (const ids of chunk(sendRows[t] || [], BATCH[t] || 300)) {
      add(stats.sent, await client.call('apply', { user, rows: runAs(ctx, () => localRows({ [t]: ids })) }));
    }
  }
  if (sendTombs.length) add(stats.sent, await client.call('apply', { user, tombstones: sendTombs }));
  runAs(ctx, () => recordPeer(there, mode, { received: total(getRows) + getTombs.length, sent: total(sendRows) + sendTombs.length }));
  await client.call('done', { user, from: self, action: mode, stats: { received: total(sendRows) + sendTombs.length, sent: total(getRows) + getTombs.length } });
}

async function syncShared({ client, mode, dryRun, log, stats }) {
  const here = sharedManifest();
  const there = await client.call('shared.manifest');
  const wrap = (m) => ({ rows: { characters: m.rows }, tombstones: m.tombstones.map(([id, at]) => ['characters', id, at]) });
  const p = plan(wrap(here), wrap(there));
  const send = mode === 'fetch' ? [] : p.push.rows.characters || [];
  const sendT = mode === 'fetch' ? [] : p.push.tombstones.map((t) => [t[1], t[2]]);
  const get = mode === 'push' ? [] : p.pull.rows.characters || [];
  const getT = mode === 'push' ? [] : p.pull.tombstones.map((t) => [t[1], t[2]]);
  log(`  shared characters: receive ${get.length + getT.length}; send ${send.length + sendT.length}`);
  if (dryRun) return;
  for (const ids of chunk(get, 20)) add(stats.received, sharedApply({ rows: (await client.call('shared.rows', { ids })).rows }));
  add(stats.received, sharedApply({ tombstones: getT }));
  for (const ids of chunk(send, 20)) add(stats.sent, await client.call('shared.apply', { rows: sharedRows(ids) }));
  if (sendT.length) add(stats.sent, await client.call('shared.apply', { tombstones: sendT }));
}

/**
 * Bring this whole server (every account, plus the shared-characters store) and another one together.
 *  mode 'fetch': only take what the remote has newer.  'push': only send what is newer here.  'sync': both.
 * Accounts that exist on only one side are created on the other with the same login.
 */
export async function runFullSync({ client, hello, mode = 'sync', dryRun = false, log = () => {} }) {
  const stats = { received: blank(), sent: blank(), warnings: [] };
  const mine = listUsernames();
  const theirs = await client.call('accounts');
  for (const u of theirs.filter((x) => !mine.includes(x))) {
    if (mode === 'push') { log(`  ${u}: only on ${hello.name}, left alone (push)`); continue; }
    log(`  ${u}: new here, copying the account`);
    if (!dryRun) createAccountFromSync(u, (await client.call('accountRecord', { username: u })).password);
  }
  for (const u of mine.filter((x) => !theirs.includes(x))) {
    if (mode === 'fetch') { log(`  ${u}: only here, left alone (fetch)`); continue; }
    log(`  ${u}: new there, creating the account`);
    if (!dryRun) await client.call('ensureAccount', { username: u, password: passwordRecord(u) });
  }
  const users = new Set([...listUsernames(), ...(dryRun ? mine.filter((x) => theirs.includes(x)) : [])]);
  for (const user of [...users].sort()) {
    if (dryRun && !(mine.includes(user) && theirs.includes(user))) continue;
    if (!theirs.includes(user) && mode === 'fetch') continue;
    try {
      await syncAccount({ user, client, mode, dryRun, log, stats });
    } catch (e) {
      if (e instanceof SyncError && /same database/.test(e.message)) stats.warnings.push(e.message);
      else throw e;
    }
  }
  await syncShared({ client, mode, dryRun, log, stats });
  return stats;
}
