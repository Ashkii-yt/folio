import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

/**
 * API keys and custom header values are encrypted at rest with AES-256-GCM.
 * The key lives in data/secret.key (mode 0600) or in FOLIO_SECRET_KEY (base64/hex, 32 bytes).
 *
 * Limitation: anyone who can read the whole data directory can read both the database and the
 * key file. This protects against a leaked/shared database file or backup, not against a
 * compromised local account. Use FOLIO_SECRET_KEY to keep the key out of the data directory.
 */
function loadKey() {
  const env = process.env.FOLIO_SECRET_KEY;
  if (env) {
    const buf = /^[0-9a-f]{64}$/i.test(env) ? Buffer.from(env, 'hex') : Buffer.from(env, 'base64');
    if (buf.length !== 32) throw new Error('FOLIO_SECRET_KEY must decode to exactly 32 bytes.');
    return buf;
  }
  const file = path.join(DATA_DIR, 'secret.key');
  if (fs.existsSync(file)) return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
  const key = crypto.randomBytes(32);
  fs.writeFileSync(file, key.toString('base64'), { mode: 0o600 });
  return key;
}

const KEY = loadKey();

export function encrypt(plain) {
  if (plain == null || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

export function decrypt(blob) {
  if (!blob) return null;
  const [v, iv, tag, ct] = String(blob).split(':');
  if (v !== 'v1') return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
  } catch {
    return null; // wrong key (e.g. restored on another machine): treated as "no key saved"
  }
}
