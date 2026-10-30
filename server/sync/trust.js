import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from '../config.js';

/**
 * Which servers may sync with this one. Pairing is how a server becomes trusted: run `npm run pair` here to get a
 * short one-time code, then `npm run link -- <this server's ID> <code>` on the other machine.
 */
const PEERS = path.join(DATA_DIR, 'peers.json');
const PAIR = path.join(DATA_DIR, 'pairing.json');
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const write = (f, v) => fs.writeFileSync(f, `${JSON.stringify(v, null, 2)}\n`, { mode: 0o600 });
const hash = (c) => crypto.createHash('sha256').update(c).digest('hex');
const ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789';

export const listTrusted = () => read(PEERS, []);
export const isTrusted = (serverId) => listTrusted().some((p) => p.serverId === serverId);
export function trust(serverId, name) {
  const list = listTrusted().filter((p) => p.serverId !== serverId);
  list.push({ serverId, name: String(name || '').slice(0, 60), pairedAt: new Date().toISOString() });
  write(PEERS, list);
}
export function untrust(key) {
  const k = String(key).toLowerCase();
  const list = listTrusted();
  const hit = list.find((p) => p.serverId === k || p.name.toLowerCase() === k);
  if (hit) write(PEERS, list.filter((p) => p !== hit));
  return hit || null;
}

/** A one-time code, valid for `minutes`. Looks like abcd-efgh-jkmn. */
export function createPairingCode(minutes = 15) {
  const bytes = crypto.randomBytes(12);
  const raw = Array.from(bytes, (b) => ALPHA[b % ALPHA.length]).join('');
  const code = `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
  write(PAIR, { hash: hash(raw), expires: Date.now() + minutes * 60_000, fails: 0 });
  return { code, minutes };
}

/** True once, for the right code. Five wrong guesses burn the code. */
export function usePairingCode(input) {
  const p = read(PAIR, null);
  if (!p || p.expires < Date.now()) return false;
  const raw = String(input || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (hash(raw) === p.hash) {
    fs.rmSync(PAIR, { force: true });
    return true;
  }
  p.fails += 1;
  if (p.fails >= 5) fs.rmSync(PAIR, { force: true });
  else write(PAIR, p);
  return false;
}

/** Saved servers: friendly names for server IDs, plus ssh targets. data/remotes.json. */
const REMOTES = path.join(DATA_DIR, 'remotes.json');
export const loadRemotes = () => { const j = read(REMOTES, []); return Array.isArray(j) ? j.filter((r) => r.target) : []; };
export function saveRemote(entry) {
  const list = loadRemotes().filter((r) => r.target !== entry.target);
  list.push(entry);
  write(REMOTES, list);
}
export function removeRemote(key) {
  const k = String(key).toLowerCase();
  const list = loadRemotes();
  const hit = list.find((r) => r.target.toLowerCase() === k || String(r.name).toLowerCase() === k);
  if (hit) write(REMOTES, list.filter((r) => r !== hit));
  return hit || null;
}
export function resolveTarget(key) {
  const k = String(key || '').toLowerCase();
  return loadRemotes().find((r) => r.target.toLowerCase() === k || String(r.name).toLowerCase() === k) || { target: key, name: null };
}
