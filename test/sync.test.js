import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(import.meta.dirname, '..');
const DA = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-A-'));
const DB = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-B-'));
const PA = 5200 + Math.floor(Math.random() * 40);
const PB = PA + 50;
const PW = 'correct horse battery';
let mock, mp, A, B, ca, cb, tn, BOOT, idA, idB;

function startMock() {
  return new Promise((resolve) => {
    mock = http.createServer((req, res) => {
      let b = '';
      req.on('data', (d) => (b += d));
      req.on('end', () => {
        if (req.url.endsWith('/models')) return res.setHeader('content-type', 'application/json'), res.end('{"data":[{"id":"m"}]}');
        const sys = JSON.parse(b || '{}').messages?.[0]?.content || '';
        const reply = sys.startsWith('You maintain') ? '{"memories":[]}' : 'Noted.';
        res.setHeader('content-type', 'text/event-stream');
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n\ndata: [DONE]\n\n`);
        res.end();
      });
    });
    mock.listen(0, '127.0.0.1', () => ((mp = mock.address().port), resolve()));
  });
}
const boot = async (dir, port) => {
  const p = spawn('node', ['--no-warnings', 'server/index.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), FOLIO_DATA_DIR: dir, FOLIO_MAX_ACCOUNTS_PER_IP: '0', FOLIO_DHT_BOOTSTRAP: BOOT } });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return p; } catch { /* wait */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
};
const stop = (p) => new Promise((r) => { p.once('exit', r); p.kill('SIGTERM'); });
const api = (port, ck) => async (method, p, body) => {
  const r = await fetch(`http://127.0.0.1:${port}/api${p}`, { method, headers: { 'content-type': 'application/json', cookie: ck }, body: body && JSON.stringify(body) });
  const t = await r.text();
  if (t.startsWith('event:') || r.headers.get('content-type')?.includes('event-stream')) return { status: r.status, body: t };
  return { status: r.status, body: t ? JSON.parse(t) : null };
};
const signUp = async (port, u) => (await fetch(`http://127.0.0.1:${port}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: PW }) })).headers.get('set-cookie').split(';')[0];
const cli = (dir, args, env = {}) => spawnSync('node', ['--no-warnings', 'server/cli.js', ...args], { cwd: ROOT, env: { ...process.env, FOLIO_DATA_DIR: dir, FOLIO_DHT_BOOTSTRAP: BOOT, ...env }, encoding: 'utf8', timeout: 90000 });
const a = (m, p, b) => api(PA, ca)(m, p, b);
const b_ = (m, p, b) => api(PB, cb)(m, p, b);
const mkProvider = (call) => call('POST', '/providers', { name: 'M', type: 'openai-compatible', baseUrl: `http://127.0.0.1:${mp}/v1`, defaultModel: 'm' });

before(async () => {
  await startMock();
  tn = spawn('node', ['--no-warnings', path.join(ROOT, 'test/helpers/testnet.mjs')], { stdio: ['ignore', 'pipe', 'inherit'] });
  BOOT = await new Promise((r) => tn.stdout.once('data', (d) => r(String(d).trim())));
  A = await boot(DA, PA);
  B = await boot(DB, PB);
  ca = await signUp(PA, 'ann');
  cb = await signUp(PB, 'ann');
  await signUp(PB, 'ben');
  await mkProvider(a);
  await mkProvider(b_);
  idA = (await a('GET', '/sync/identity')).body;
  idB = (await b_('GET', '/sync/identity')).body;
  await new Promise((r) => setTimeout(r, 1500)); // let both announce on the DHT
});
after(async () => {
  await stop(A).catch(() => {});
  await stop(B).catch(() => {});
  tn?.kill();
  mock.close();
  for (const d of [DA, DB]) fs.rmSync(d, { recursive: true, force: true });
});

test('a server ID is its public key; the private seed is never served', async () => {
  assert.match(idA.serverId, /^srv_[0-9a-f]{64}$/);
  assert.match(idA.databaseId, /^db_[0-9a-f]{20}$/);
  assert.notEqual(idA.serverId, idB.serverId);
  assert.equal(idA.seed, undefined);
  assert.equal((await fetch(`http://127.0.0.1:${PA}/api/sync/info`)).status, 401);
  const out = cli(DA, ['ids']).stdout;
  assert.ok(out.includes(idA.serverId));
});

test('an unpaired server is refused; pairing code works once, by ID only', async () => {
  const no = cli(DB, ['sync', idA.serverId]);
  assert.notEqual(no.status, 0);
  assert.match(no.stderr, /not been paired/);
  const bad = cli(DB, ['link', idA.serverId, 'aaaa-bbbb-cccc']);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /wrong or has expired/);
  const code = cli(DA, ['pair']).stdout.match(/link -- srv_[0-9a-f]{64} ([a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})/)?.[1];
  assert.ok(code, 'pair prints a code');
  const ok = cli(DB, ['link', idA.serverId, code, '--name', 'home']);
  assert.equal(ok.status, 0, ok.stderr + ok.stdout);
  assert.match(cli(DA, ['peers']).stdout, new RegExp(idB.serverId));
  const again = cli(DB, ['link', idA.serverId, code]);
  assert.notEqual(again.status, 0, 'a code cannot be reused');
});

let wrenId, orlaId, convId;
test('whole-server sync: accounts, characters, chats, memories both ways, then a no-op', async () => {
  const w = (await a('POST', '/characters', { name: 'Wren', greeting: 'Hello {{user}}', description: 'Navigator', avatar: 'data:image/png;base64,iVBORw0KGgo=' })).body;
  wrenId = w.id;
  convId = (await a('POST', `/characters/${wrenId}/conversations`, {})).body.id;
  await a('POST', `/characters/${wrenId}/memories`, { content: 'Ann likes tea.' });
  orlaId = (await b_('POST', '/characters', { name: 'Orla' })).body.id;
  await b_('POST', `/characters/${orlaId}/memories`, { content: 'Ben has a dog.' });
  const pub = await a('POST', `/characters/${wrenId}/share`);
  assert.equal(pub.status, 200);

  const dry = cli(DB, ['sync', 'home', '--dry-run']);
  assert.equal(dry.status, 0, dry.stderr + dry.stdout);
  assert.match(dry.stdout, /Dry run/);
  assert.equal((await b_('GET', '/characters')).body.length, 1, 'dry run changed nothing');

  const r = cli(DB, ['sync', idA.serverId]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual((await a('GET', '/characters')).body.map((c) => c.name).sort(), ['Orla', 'Wren']);
  assert.deepEqual((await b_('GET', '/characters')).body.map((c) => c.name).sort(), ['Orla', 'Wren']);
  assert.equal((await b_('GET', `/characters/${wrenId}`)).body.hasAvatar, true);
  assert.equal((await b_('GET', `/conversations/${convId}`)).body.messages.length, 1);
  // ben only existed on B: now exists on A with the same password; shared card reached B.
  const login = await fetch(`http://127.0.0.1:${PA}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'ben', password: PW }) });
  assert.equal(login.status, 200, 'account was copied with its login');
  assert.equal((await api(PB, cb)('GET', '/shared')).body.length, 1);

  const again = cli(DB, ['sync', idA.serverId]);
  assert.match(again.stdout, /ann: receive nothing; send nothing/);
  assert.match(cli(DA, ['ids']).stdout, /last synced with/);
});

test('fetch only pulls, push only pushes; edits and deletions travel; newest wins; shared deletions travel', async () => {
  await a('PATCH', `/characters/${wrenId}`, { description: 'Navigator (A edit)' });
  await b_('DELETE', `/characters/${orlaId}`);
  const f = cli(DA, ['fetch', idB.serverId]);
  assert.match(f.stderr, /not been paired/, 'A does not trust B-direction until A links to B');
  const code = cli(DB, ['pair']).stdout.match(/ ([a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})\n/)?.[1];
  assert.equal(cli(DA, ['link', idB.serverId, code]).status, 0);
  assert.equal(cli(DA, ['fetch', idB.serverId]).status, 0);
  assert.equal((await a('GET', `/characters/${orlaId}`)).status, 404, 'deletion pulled');
  assert.equal((await b_('GET', `/characters/${wrenId}`)).body.description, 'Navigator', 'fetch did not push');
  assert.equal(cli(DA, ['push', idB.serverId]).status, 0);
  assert.equal((await b_('GET', `/characters/${wrenId}`)).body.description, 'Navigator (A edit)');

  await a('PATCH', `/characters/${wrenId}`, { description: 'older on A' });
  await new Promise((r) => setTimeout(r, 15));
  await b_('PATCH', `/characters/${wrenId}`, { description: 'newer on B' });
  cli(DA, ['sync', idB.serverId]);
  assert.equal((await a('GET', `/characters/${wrenId}`)).body.description, 'newer on B');

  await a('DELETE', `/characters/${wrenId}/share`);
  cli(DA, ['sync', idB.serverId]);
  assert.equal((await api(PB, cb)('GET', '/shared')).body.length, 0);
});

test('a conversation continued on both servers is merged without losing messages', async () => {
  assert.match((await a('POST', `/conversations/${convId}/messages`, { content: 'from A' })).body, /done/);
  assert.match((await b_('POST', `/conversations/${convId}/messages`, { content: 'from B' })).body, /done/);
  const r = cli(DA, ['sync', idB.serverId]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const ma = (await a('GET', `/conversations/${convId}`)).body.messages;
  const mb = (await b_('GET', `/conversations/${convId}`)).body.messages;
  for (const m of [ma, mb]) {
    const text = m.map((x) => x.content).join('|');
    assert.ok(text.includes('from A') && text.includes('from B'), text);
    assert.equal(new Set(m.map((x) => x.seq)).size, m.length);
  }
  assert.equal(ma.length, mb.length);
});

test('ssh: no pairing, no running server, no ports; a saved name works', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-S-'));
  const fake = path.join(dir, 'ssh');
  fs.writeFileSync(fake, `#!/bin/sh\ncd "${ROOT}" && FOLIO_DATA_DIR="${DB}" exec node --no-warnings server/cli.js stdio\n`, { mode: 0o755 });
  try {
    const env = { FOLIO_SSH_BIN: fake, FOLIO_SYNC_SERVICE: '0' };
    assert.equal(cli(DA, ['remote', 'add', 'lan', 'ssh://pi@192.168.1.20/home/pi/folio'], env).status, 0);
    const nb = (await a('POST', '/characters', { name: 'Via ssh' })).body;
    const r = cli(DA, ['push', 'lan'], env);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.ok((await b_('GET', '/characters')).body.some((c) => c.id === nb.id));
    assert.match(cli(DA, ['push', 'ssh://nobody@h/x'], { ...env, FOLIO_SSH_BIN: '/bin/false' }).stderr, /ssh failed|closed/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('export and import move data without a network', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-C-'));
  const port = PA + 90;
  const C = await boot(dir, port);
  try {
    const cc = await signUp(port, 'cat');
    const out = path.join(dir, 'bundle.json');
    assert.equal(cli(DA, ['export', '--as', 'ann', '--out', out]).status, 0);
    await stop(C);
    const imp = cli(dir, ['import', out, '--as', 'cat']);
    assert.equal(imp.status, 0, imp.stderr);
    const C2 = await boot(dir, port);
    assert.ok((await api(port, cc)('GET', '/characters')).body.length >= 1);
    await stop(C2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an older server (random srv_ id, database without sync tables) upgrades in place', async () => {
  await stop(B);
  fs.writeFileSync(path.join(DB, 'server.json'), JSON.stringify({ serverId: 'srv_0123456789abcdef0123', name: 'old' }));
  const file = path.join(DB, 'ann', 'folio.db');
  const raw = new DatabaseSync(file);
  const n = raw.prepare('SELECT COUNT(*) AS n FROM characters').get().n;
  for (const t of ['characters', 'conversations', 'messages', 'memories', 'summaries']) raw.exec(`DROP TRIGGER IF EXISTS ${t}_tomb; DROP TRIGGER IF EXISTS ${t}_untomb;`);
  raw.exec('DROP TABLE meta; DROP TABLE sync_peers; DROP TABLE tombstones; ALTER TABLE image_config DROP COLUMN account_id; PRAGMA user_version = 3;');
  raw.close();
  B = await boot(DB, PB);
  const ib = (await b_('GET', '/sync/identity')).body;
  assert.match(ib.serverId, /^srv_[0-9a-f]{64}$/);
  assert.match(ib.databaseId, /^db_[0-9a-f]{20}$/);
  assert.equal((await b_('GET', '/characters')).body.length, n);
  assert.equal(JSON.parse(fs.readFileSync(path.join(DB, 'server.json'), 'utf8')).previousId, 'srv_0123456789abcdef0123');
});
