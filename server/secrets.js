import crypto from 'node:crypto';
import { currentUser } from './db.js';

/**
 * API keys and custom header values are encrypted at rest with AES-256-GCM using the signed-in user's own
 * key, which lives in data/<username>/secrets.key next to their database.
 *
 * Limitation: anyone who can read the whole account folder can read both the database and the key. This
 * protects against a leaked or shared database file or backup, not against someone with access to the
 * server's disk.
 */
function key() {
  const c = currentUser();
  if (!c) throw new Error('No signed-in user for this operation.');
  return c.key;
}

export function encrypt(plain) {
  if (plain == null || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

export function decrypt(blob) {
  if (!blob) return null;
  const [v, iv, tag, ct] = String(blob).split(':');
  if (v !== 'v1') return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
  } catch {
    return null; // wrong key (e.g. restored on another machine): treated as "no key saved"
  }
}
