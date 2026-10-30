#!/usr/bin/env node
import fs from 'node:fs';
import { runAs } from './db.js';
import { getContext, listUsernames, closeAll } from './accounts.js';
import { serverIdentity, setServerName, databaseId, isServerId } from './identity.js';
import { localManifest, localRows, applyChanges, recordPeer, listPeers } from './sync/engine.js';
import { TABLE_ORDER } from './sync/tables.js';
import { SyncError, rpcServe } from './sync/rpc.js';
import { runFullSync } from './sync/run.js';
import { connectTo } from './sync/connect.js';
import { makeHandler } from './sync/handler.js';
import { createPairingCode, listTrusted, untrust, loadRemotes, saveRemote, removeRemote } from './sync/trust.js';
import { isSsh, parseSsh } from './sync/ssh.js';

const HELP = `Folio server sync: whole server (every account and the shared characters), by server ID.

  npm run ids                                   this server's ID, and each account's database ID
  npm run rename -- "Home server"               give this server a friendly name

Connect two servers (once). Both must be running (npm start); no ports, no URLs, no https needed:
  npm run pair                                  on server A: prints a one-time code (valid 15 minutes)
  npm run link -- <A's server id> <code>        on server B: pairs with A (B is allowed to reach A, and A trusts B)
  npm run peers                                 who is paired, and saved names
  npm run unlink -- <server id|name>            stop trusting a server

Move data:
  npm run sync  -- <server id|name|ssh://...>   both ways
  npm run fetch -- <server id|name|ssh://...>   only pull newer data here
  npm run push  -- <server id|name|ssh://...>   only send newer data there
      --dry-run        show what would change and change nothing
      --every <secs>   keep going: repeat every N seconds until stopped

Names and ssh:
  npm run remote -- add <name> <server id|ssh://user@host[:port]/path/to/folio>
  npm run remote -- list | remove <name>
  ssh needs no pairing (your ssh login is the proof), no running Folio, just node and the files on the other side.

Backups: npm run sync:export -- --as <account> --out file.json    npm run sync:import -- file.json --as <account>
Newer wins, record by record; deletions travel too. Providers, API keys and settings are never synced.
A paired server receives EVERY account's characters, chats and memories, so only pair servers you control.`;

function parse(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (['dry-run', 'yes'].includes(k)) opt[k] = true;
      else opt[k] = v ?? argv[++i];
    } else pos.push(a);
  }
  return { pos, opt };
}

function localUser(opt) {
  const names = listUsernames();
  if (!names.length) throw new SyncError('This server has no accounts yet. Start Folio and create one first.');
  if (opt.as) {
    if (!names.includes(opt.as)) throw new SyncError(`No local account "${opt.as}". Accounts here: ${names.join(', ')}`);
    return opt.as;
  }
  if (names.length === 1) return names[0];
  throw new SyncError(`Which account on this server? Add --as <name>. Accounts here: ${names.join(', ')}`);
}

const fmt = (s) => `${s.added} new, ${s.updated} updated, ${s.deleted} deleted${s.skipped ? `, ${s.skipped} skipped` : ''}`;

async function once(cmd, key, opt) {
  const c = await connectTo(key);
  try {
    console.log(`Connected to ${c.hello.name} (${c.hello.serverId}).`);
    const stats = await runFullSync({ client: c.client, hello: c.hello, mode: cmd, dryRun: !!opt['dry-run'], log: (m) => console.log(m) });
    if (opt['dry-run']) console.log('\nDry run: nothing was changed.');
    else {
      console.log(`\nDone.\n  here:   ${fmt(stats.received)}\n  there:  ${fmt(stats.sent)}`);
      for (const w of stats.warnings) console.log(`  note: ${w}`);
    }
  } finally {
    c.client.close();
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, opt } = parse(rest);
  switch (cmd) {
    case 'stdio': {
      // Served over ssh: the ssh login is the authorisation. stdout carries only protocol lines.
      rpcServe(process.stdin, process.stdout, makeHandler({ peerId: null, trusted: true }));
      await new Promise((r) => process.stdin.on('close', r));
      return;
    }
    case 'ids': {
      const id = serverIdentity();
      console.log(`Server ID    ${id.serverId}\nServer name  ${id.name}\n`);
      for (const u of listUsernames()) {
        const rows = runAs(getContext(u), () => ({ id: databaseId(), peers: listPeers() }));
        console.log(`Account ${u}\n  database ID  ${rows.id}`);
        for (const p of rows.peers) console.log(`  last synced with ${p.peer_server_name || p.peer_server_id} (${p.peer_database_id}) ${p.last_sync_at} [${p.last_action}]`);
      }
      return;
    }
    case 'rename':
      if (!pos[0]) throw new SyncError('Give a name: npm run rename -- "Home server"');
      console.log(`Server name is now "${setServerName(pos.join(' ')).name}".`);
      return;
    case 'pair': {
      const { code, minutes } = createPairingCode();
      console.log(`On the other server, run:\n\n  npm run link -- ${serverIdentity().serverId} ${code}\n\nThe code works once and expires in ${minutes} minutes. Keep \`npm start\` running here until then.`);
      return;
    }
    case 'link': {
      const [id, code] = pos;
      if (!isServerId(id) || !code) throw new SyncError('Use: npm run link -- <server id> <code>', 'The ID and code are printed by `npm run pair` on the other server.');
      const c = await connectTo(id);
      try {
        const r = await c.client.call('pair', { code, name: serverIdentity().name });
        saveRemote({ target: id, name: opt.name || r.name });
        console.log(`Paired with ${r.name}. It can now sync with this server, and this one with it.\nTry: npm run sync -- ${opt.name || id}`);
      } finally {
        c.client.close();
      }
      return;
    }
    case 'peers': {
      const t = listTrusted();
      console.log(t.length ? 'Servers allowed to sync with this one:' : 'No servers are paired with this one yet (npm run pair).');
      for (const p of t) console.log(`  ${p.serverId}  ${p.name}  paired ${p.pairedAt}`);
      const r = loadRemotes();
      if (r.length) console.log('\nSaved names:');
      for (const x of r) console.log(`  ${x.name || '(no name)'}  ->  ${x.target}`);
      return;
    }
    case 'unlink': {
      const hit = untrust(pos[0] || '');
      if (!hit) throw new SyncError('No paired server matches that.');
      console.log(`${hit.name} (${hit.serverId}) can no longer sync with this server.`);
      return;
    }
    case 'remote': {
      const [sub, a, b] = pos;
      if (sub === 'add') {
        if (!a || !b) throw new SyncError('Use: npm run remote -- add <name> <server id|ssh://user@host/path>');
        if (!isServerId(b) && !isSsh(b)) throw new SyncError('The target must be a server ID or an ssh:// address.');
        if (isSsh(b)) parseSsh(b);
        saveRemote({ target: b, name: a });
        console.log(`Saved "${a}".`);
        return;
      }
      if (sub === 'remove') {
        const hit = removeRemote(a || '');
        if (!hit) throw new SyncError('No saved name matches that.');
        console.log(`Removed ${hit.name}.`);
        return;
      }
      for (const x of loadRemotes()) console.log(`${x.name || '(no name)'}  ->  ${x.target}`);
      return;
    }
    case 'fetch':
    case 'push':
    case 'sync': {
      if (!pos[0]) throw new SyncError('Which server? Give its ID, a saved name or an ssh:// address.');
      const every = opt.every ? Math.max(5, Number(opt.every) || 0) : 0;
      if (!every) return once(cmd, pos[0], opt);
      console.log(`Repeating every ${every}s. Press Ctrl+C to stop.`);
      for (;;) {
        try { await once(cmd, pos[0], opt); } catch (e) { console.error(`\n${e.message}${e.hint ? `\n${e.hint}` : ''}\n(will try again)`); }
        await new Promise((r) => setTimeout(r, every * 1000));
      }
    }
    case 'export': {
      const as = localUser(opt);
      const out = opt.out || `${as}.folio-sync.json`;
      const ctx = getContext(as);
      const bundle = runAs(ctx, () => {
        const m = localManifest();
        const keys = Object.fromEntries(TABLE_ORDER.map((t) => [t, m.rows[t].map((r) => r[0])]));
        const rows = {};
        for (const t of TABLE_ORDER) for (let i = 0; i < keys[t].length; i += 200) Object.assign(rows, { [t]: [...(rows[t] || []), ...(localRows({ [t]: keys[t].slice(i, i + 200) })[t] || [])] });
        return { format: 'folio-sync-bundle', protocol: 1, from: { databaseId: m.databaseId, serverId: m.serverId, serverName: m.serverName }, exportedAt: new Date().toISOString(), rows, tombstones: m.tombstones };
      });
      fs.writeFileSync(out, JSON.stringify(bundle), { mode: 0o600 });
      console.log(`Wrote ${out}. It contains every character, chat and memory of ${as}, so keep it private.`);
      return;
    }
    case 'import': {
      const as = localUser(opt);
      const file = pos[0];
      if (!file) throw new SyncError('Give the file: npm run sync:import -- file.json --as <account>');
      const b = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (b.format !== 'folio-sync-bundle') throw new SyncError('That is not a Folio sync bundle.');
      const ctx = getContext(as);
      if (runAs(ctx, databaseId) === b.from?.databaseId) throw new SyncError('That bundle came from this same database.');
      const s = runAs(ctx, () => {
        const r = applyChanges({ rows: b.rows, tombstones: b.tombstones });
        if (b.from?.databaseId) recordPeer(b.from, 'import', r);
        return r;
      });
      console.log(`Imported: ${s.added} new, ${s.updated} updated, ${s.deleted} deleted, ${s.skipped} skipped (older than what you already have).`);
      return;
    }
    default:
      console.log(HELP);
  }
}

try {
  await main();
  closeAll();
  process.exit(0);
} catch (e) {
  closeAll();
  if (e instanceof SyncError) {
    console.error(`\n${e.message}${e.hint ? `\n${e.hint}` : ''}`);
  } else console.error(e?.stack || e);
  process.exit(1);
}
