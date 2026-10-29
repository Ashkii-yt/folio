import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { DATA_DIR } from './config.js';
import { openDatabase, closeDatabase } from './db.js';
import { HttpError, bad, now } from './util.js';

/**
 * Accounts live in the data folder itself:
 *
 *   data/<username>/secrets.key   username, salted scrypt password hash, this user's encryption key, IP fingerprint
 *   data/<username>/folio.db      everything else (characters, chats, memories, providers, settings)
 *
 * There is no separate user table, so copying or deleting a folder copies or deletes that account.
 */

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SESSION_MS = 30 * 24 * 3600 * 1000;

/** Accounts allowed per IP address (IPv6 counts per /64). 0 turns the limit off. */
export const MAX_PER_IP = Math.max(0, Number(process.env.FOLIO_MAX_ACCOUNTS_PER_IP ?? 1) || 0);
export const SECRET_FILE = 'secrets.key';

const USERNAME_RE = /^[a-z0-9][a-z0-9_-]{2,31}$/;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d|\.|\.\.)$/;

/* A server-wide secret signs session cookies and fingerprints IPs. It never leaves this folder. */
const serverSecret = (() => {
  const file = path.join(DATA_DIR, '.server-secret');
  if (fs.existsSync(file)) return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
  const s = crypto.randomBytes(32);
  fs.writeFileSync(file, s.toString('base64'), { mode: 0o600 });
  return s;
})();
const hmac = (data) => crypto.createHmac('sha256', serverSecret).update(data).digest('hex');

/* ------------------------------------------------------------------ usernames and folders */

export function normalizeUsername(raw) {
  const name = String(raw ?? '').trim().toLowerCase();
  if (!USERNAME_RE.test(name) || RESERVED.test(name)) {
    throw bad('Usernames are 3 to 32 characters: lowercase letters, numbers, dashes and underscores, starting with a letter or number.', 'bad_username');
  }
  return name;
}

export function userDir(name) {
  const dir = path.resolve(DATA_DIR, name);
  if (path.dirname(dir) !== path.resolve(DATA_DIR)) throw bad('Invalid username.', 'bad_username'); // never leave the data folder
  return dir;
}

function readSecrets(name) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(userDir(name), SECRET_FILE), 'utf8'));
    return j?.format === 'folio-account' && j.username === name ? j : null;
  } catch {
    return null;
  }
}

export function listUsernames() {
  try {
    return fs.readdirSync(DATA_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && USERNAME_RE.test(d.name) && fs.existsSync(path.join(DATA_DIR, d.name, SECRET_FILE)))
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ IP handling */

function expandV6(ip) {
  const [head, tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const mid = ip.includes('::') ? Array(Math.max(0, 8 - h.length - t.length)).fill('0') : [];
  return [...h, ...mid, ...t].map((x) => x.padStart(4, '0'));
}

/** Normalise an address so the limit applies per network, not per spelling: v4-mapped → v4, v6 → its /64. */
export function normalizeIp(raw) {
  let ip = String(raw || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) ip = mapped[1];
  if (ip.includes(':')) return `v6:${expandV6(ip).slice(0, 4).join(':')}`;
  return ip || 'unknown';
}

/**
 * The client's address. Behind a reverse proxy set FOLIO_TRUST_PROXY=1 and Folio uses the last entry the
 * proxy appended to X-Forwarded-For (earlier entries can be forged by the client). Without it, headers are ignored.
 */
export function clientIp(req) {
  if (process.env.FOLIO_TRUST_PROXY === '1') {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (xff.length) return normalizeIp(xff[xff.length - 1]);
  }
  return normalizeIp(req.socket.remoteAddress);
}

const ipFingerprint = (ip) => hmac(`ip:${ip}`);

export function accountsFromIp(ip) {
  const fp = ipFingerprint(ip);
  return listUsernames().filter((n) => readSecrets(n)?.ipHash === fp).length;
}

export const registrationOpenFor = (ip) => MAX_PER_IP === 0 || accountsFromIp(ip) < MAX_PER_IP;

/* ------------------------------------------------------------------ passwords */

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

async function checkPassword(password, stored) {
  const [alg, N, r, p, salt, hash] = String(stored || '').split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const got = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, { N: +N, r: +r, p: +p, maxmem: SCRYPT.maxmem });
  return crypto.timingSafeEqual(got, expected);
}

const DUMMY_HASH = hashPassword('folio-dummy-password'); // equalises timing when a username does not exist

function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) throw bad('Use a password of at least 8 characters.', 'weak_password');
  if (pw.length > 200) throw bad('That password is too long (200 characters at most).', 'weak_password');
}

/* ------------------------------------------------------------------ login throttling */

const fails = new Map(); // key -> { n, until }
const LIMITS = [['user', 5], ['ip', 20]];
const LOCK_MS = 15 * 60 * 1000;

function throttleKeys(ip, name) {
  return [`user:${name}:${ip}`, `ip:${ip}`];
}
function checkThrottle(ip, name) {
  for (const k of throttleKeys(ip, name)) {
    const f = fails.get(k);
    if (f?.until && f.until > Date.now()) {
      const mins = Math.ceil((f.until - Date.now()) / 60000);
      throw new HttpError(429, `Too many failed sign-in attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`, 'rate_limited');
    }
  }
}
function noteFailure(ip, name) {
  throttleKeys(ip, name).forEach((k, i) => {
    const f = fails.get(k) && (fails.get(k).until || 0) < Date.now() ? fails.get(k) : { n: 0 };
    f.n += 1;
    if (f.n >= LIMITS[i][1]) { f.until = Date.now() + LOCK_MS; f.n = 0; }
    fails.set(k, f);
  });
}
const clearFailures = (ip, name) => fails.delete(`user:${name}:${ip}`);

/* ------------------------------------------------------------------ per-user context */

const contexts = new Map();

/** Open (once) and return the runtime context for an account, or null if it does not exist. */
export function getContext(name) {
  if (contexts.has(name)) return contexts.get(name);
  const s = readSecrets(name);
  if (!s) return null;
  const dir = userDir(name);
  const ctx = {
    username: name,
    dir,
    db: openDatabase(path.join(dir, 'folio.db')),
    key: Buffer.from(s.encryptionKey, 'base64'),
    pwTag: s.password.slice(-24),
  };
  contexts.set(name, ctx);
  return ctx;
}

export function closeAll() {
  for (const c of contexts.values()) closeDatabase(c.db);
  contexts.clear();
}

/* ------------------------------------------------------------------ sessions */

const b64u = (s) => Buffer.from(s).toString('base64url');

export function issueSession(name) {
  const ctx = getContext(name);
  const payload = `${name}.${Date.now() + SESSION_MS}`;
  return `${b64u(payload)}.${hmac(`session:${payload}:${ctx.pwTag}`)}`;
}

/** Returns the username for a valid, unexpired cookie value, else null. Changing the password invalidates old sessions. */
export function verifySession(token) {
  try {
    const [p, sig] = String(token || '').split('.');
    const payload = Buffer.from(p, 'base64url').toString('utf8');
    const [name, exp] = [payload.slice(0, payload.lastIndexOf('.')), Number(payload.slice(payload.lastIndexOf('.') + 1))];
    if (!(exp > Date.now()) || !USERNAME_RE.test(name)) return null;
    const ctx = getContext(name);
    if (!ctx) return null;
    const want = hmac(`session:${payload}:${ctx.pwTag}`);
    return sig && sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want)) ? name : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ register / login / password */

let registerChain = Promise.resolve(); // serialise sign-ups so the per-IP limit cannot be raced

export function register({ username, password, ip }) {
  const run = registerChain.then(() => doRegister({ username, password, ip }));
  registerChain = run.catch(() => {});
  return run;
}

async function doRegister({ username, password, ip }) {
  const name = normalizeUsername(username);
  validatePassword(password);
  if (fs.existsSync(userDir(name))) throw new HttpError(409, 'That username is taken.', 'username_taken');
  if (MAX_PER_IP > 0 && accountsFromIp(ip) >= MAX_PER_IP) {
    throw new HttpError(403, 'An account has already been created from this network address, and this server allows one per address. Sign in to that account instead.', 'ip_limit');
  }

  const dir = userDir(name);
  let encryptionKey = crypto.randomBytes(32);

  // Data from before accounts existed (data/folio.db) is adopted by the first account, keys included.
  const legacyDb = path.join(DATA_DIR, 'folio.db');
  const adopting = fs.existsSync(legacyDb) && listUsernames().length === 0;
  fs.mkdirSync(dir, { mode: 0o700 });
  if (adopting) {
    const legacyKey = path.join(DATA_DIR, 'secret.key');
    if (fs.existsSync(legacyKey)) encryptionKey = Buffer.from(fs.readFileSync(legacyKey, 'utf8').trim(), 'base64');
    for (const ext of ['', '-wal', '-shm']) {
      if (fs.existsSync(legacyDb + ext)) fs.renameSync(legacyDb + ext, path.join(dir, `folio.db${ext}`));
    }
    if (fs.existsSync(legacyKey)) fs.renameSync(legacyKey, path.join(dir, 'legacy-secret.key.bak'));
  }

  const secrets = {
    format: 'folio-account',
    version: 1,
    username: name,
    password: await hashPassword(password),
    encryptionKey: encryptionKey.toString('base64'),
    ipHash: ipFingerprint(ip),
    createdAt: now(),
  };
  fs.writeFileSync(path.join(dir, SECRET_FILE), JSON.stringify(secrets, null, 2), { mode: 0o600, flag: 'wx' });
  getContext(name);
  return { username: name, adopted: adopting };
}

export async function login({ username, password, ip }) {
  let name;
  try {
    name = normalizeUsername(username);
  } catch {
    name = '';
  }
  checkThrottle(ip, name || '?');
  const s = name ? readSecrets(name) : null;
  const ok = s ? await checkPassword(String(password ?? ''), s.password) : (await checkPassword(String(password ?? ''), await DUMMY_HASH), false);
  if (!ok) {
    noteFailure(ip, name || '?');
    throw new HttpError(401, 'That username and password do not match.', 'bad_credentials');
  }
  clearFailures(ip, name);
  return name;
}

export async function changePassword(name, { current, next, ip }) {
  checkThrottle(ip, name);
  const s = readSecrets(name);
  if (!s || !(await checkPassword(String(current ?? ''), s.password))) {
    noteFailure(ip, name);
    throw new HttpError(401, 'The current password is not correct.', 'bad_credentials');
  }
  validatePassword(next);
  s.password = await hashPassword(next);
  fs.writeFileSync(path.join(userDir(name), SECRET_FILE), JSON.stringify(s, null, 2), { mode: 0o600 });
  getContext(name).pwTag = s.password.slice(-24); // every older session cookie stops working
}
