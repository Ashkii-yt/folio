import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';
import { q } from './db.js';

/**
 * A server's ID is its public key: srv_<64 hex>. Knowing the ID is enough to find and securely reach it
 * (the connection is end-to-end encrypted and only the owner of the matching private key can answer).
 * The private seed lives in data/server.json and never leaves the machine.
 */
const FILE = path.join(DATA_DIR, 'server.json');
const ID_RE = /^srv_[0-9a-f]{64}$/;
const PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');

export const isServerId = (s) => ID_RE.test(String(s || ''));

function derive(seedHex) {
  const seed = Buffer.from(seedHex, 'hex');
  const priv = crypto.createPrivateKey({ key: Buffer.concat([PKCS8, seed]), format: 'der', type: 'pkcs8' });
  const pub = crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(-32);
  return { publicKey: Buffer.from(pub), secretKey: Buffer.concat([seed, pub]) };
}

const write = (id) => fs.writeFileSync(FILE, `${JSON.stringify(id, null, 2)}\n`, { mode: 0o600 });

export function serverIdentity() {
  let j = null;
  try {
    j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    /* create below */
  }
  if (j && /^[0-9a-f]{64}$/.test(j.seed || '') && isServerId(j.serverId)) return j;
  // New server, or one from before IDs were keys: mint a keypair. The old random ID (if any) is kept for reference.
  const seed = crypto.randomBytes(32).toString('hex');
  const id = {
    serverId: `srv_${derive(seed).publicKey.toString('hex')}`,
    seed,
    name: j?.name || os.hostname().slice(0, 60) || 'folio-server',
    createdAt: j?.createdAt || new Date().toISOString(),
    ...(j?.serverId && !isServerId(j.serverId) ? { previousId: j.serverId } : {}),
  };
  write(id);
  return id;
}

/** { publicKey, secretKey } buffers for this server. */
export const serverKeyPair = () => derive(serverIdentity().seed);
export const publicKeyOf = (serverId) => Buffer.from(serverId.slice(4), 'hex');
export const idOfKey = (buf) => `srv_${Buffer.from(buf).toString('hex')}`;

export function setServerName(name) {
  const id = serverIdentity();
  id.name = String(name || '').trim().slice(0, 60) || id.name;
  write(id);
  return id;
}

/** ID of the signed-in user's database. */
export const databaseId = () => q.get("SELECT value FROM meta WHERE key = 'database_id'").value;
