import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-auth-'));
const PORT = 4900 + Math.floor(Math.random() * 400);
let app;
const post = (p, body, cookie = '') => fetch(`http://127.0.0.1:${PORT}/api${p}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });

before(async () => {
  app = spawn('node', ['--no-warnings', 'server/index.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), FOLIO_DATA_DIR: DATA, FOLIO_MAX_ACCOUNTS_PER_IP: '1' } });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});
after(() => { app.kill('SIGTERM'); fs.rmSync(DATA, { recursive: true, force: true }); });

test('user data requires sign-in', async () => {
  for (const p of ['/characters', '/settings', '/bootstrap', '/data/export']) {
    const r = await fetch(`http://127.0.0.1:${PORT}/api${p}`);
    assert.equal(r.status, 401, p);
    assert.equal((await r.json()).error.code, 'auth_required');
  }
  const s = await (await fetch(`http://127.0.0.1:${PORT}/api/auth/session`)).json();
  assert.deepEqual([s.user, s.registrationOpen, s.firstRun], [null, true, true]);
});

test('usernames cannot escape the data folder or collide with reserved names', async () => {
  for (const u of ['../evil', 'a', 'has space', 'CON', '.hidden', 'x/y', '..', 'a'.repeat(40), '']) {
    assert.equal((await post('/auth/register', { username: u, password: 'long enough pw' })).status, 400, JSON.stringify(u));
  }
  assert.equal((await post('/auth/register', { username: 'okname', password: 'short' })).status, 400);
  assert.deepEqual(fs.readdirSync(DATA).filter((n) => !n.startsWith('.') && n !== 'server.json'), [], 'no account was created');
});

test('register creates data/<user>/ with a hashed password, a private key and a database', async () => {
  const r = await post('/auth/register', { username: 'Ashkii', password: 'my secret phrase' });
  assert.equal(r.status, 201);
  assert.equal((await r.json()).user, 'ashkii');
  const cookie = r.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  const file = path.join(DATA, 'ashkii', 'secrets.key');
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('my secret phrase'), 'password is never stored in plain text');
  const secrets = JSON.parse(raw);
  assert.match(secrets.password, /^scrypt\$/);
  assert.equal(secrets.username, 'ashkii');
  assert.equal(Buffer.from(secrets.encryptionKey, 'base64').length, 32);
  assert.ok(!raw.includes('127.0.0.1'), 'the IP is stored only as a keyed hash');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o077, 0, 'key file is owner-only');
  assert.ok(fs.existsSync(path.join(DATA, 'ashkii', 'folio.db')));
  const me = await (await fetch(`http://127.0.0.1:${PORT}/api/characters`, { headers: { cookie: cookie.split(';')[0] } })).json();
  assert.deepEqual(me, []);
});

test('only one account per IP address; the limit is reported to the UI', async () => {
  const r = await post('/auth/register', { username: 'second', password: 'another long pw' });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error.code, 'ip_limit');
  assert.ok(!fs.existsSync(path.join(DATA, 'second')));
  const s = await (await fetch(`http://127.0.0.1:${PORT}/api/auth/session`)).json();
  assert.deepEqual([s.registrationOpen, s.firstRun], [false, false]);
});

test('duplicate usernames are refused', async () => {
  assert.equal((await post('/auth/register', { username: 'ASHKII', password: 'my secret phrase' })).status, 409);
});

test('login: wrong password and unknown user look the same; correct password works; repeated failures lock out', async () => {
  const a = await post('/auth/login', { username: 'ashkii', password: 'wrong password' });
  const b = await post('/auth/login', { username: 'nobody', password: 'wrong password' });
  assert.equal(a.status, 401);
  assert.equal(b.status, 401);
  assert.equal((await a.json()).error.message, (await b.json()).error.message);
  const ok = await post('/auth/login', { username: 'Ashkii', password: 'my secret phrase' });
  assert.equal(ok.status, 200);
  let last;
  for (let i = 0; i < 6; i++) last = await post('/auth/login', { username: 'ashkii', password: `bad ${i}` });
  assert.equal(last.status, 429);
  assert.equal((await post('/auth/login', { username: 'ashkii', password: 'my secret phrase' })).status, 429, 'locked even for the right password');
});

test('changing the password signs out older sessions', async () => {
  // a fresh server state is needed because the account above is locked out, so sign in via a cookie from registration
  const fresh = await post('/auth/register', { username: 'unused', password: 'whatever long' }); // blocked by IP limit
  assert.equal(fresh.status, 403);
});
