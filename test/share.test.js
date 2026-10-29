import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-share-'));
const PORT = 4900 + Math.floor(Math.random() * 90);
let mock, mockPort, app, alice, bob;
const prompts = [];
let designReply = null;

function startMock() {
  return new Promise((resolve) => {
    mock = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        if (req.url.endsWith('/models')) return res.setHeader('content-type', 'application/json'), res.end(JSON.stringify({ data: [{ id: 'm1' }] }));
        const j = JSON.parse(body || '{}');
        prompts.push(j);
        const sys = j.messages?.[0]?.content || '';
        let reply = 'ok';
        if (sys.startsWith('You help write characters')) {
          const asked = [...j.messages.at(-1).content.matchAll(/^=== (\w+) ===/gm)].map((m) => m[1]);
          reply = designReply ?? asked.map((k) => `=== ${k} ===\n${k === 'tags' ? 'Space, Salvage, #Banter' : `Written ${k} for {{char}}.`}`).join('\n');
        }
        res.setHeader('content-type', 'text/event-stream');
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
        res.end();
      });
    });
    mock.listen(0, '127.0.0.1', () => ((mockPort = mock.address().port), resolve()));
  });
}

const url = (p) => `http://127.0.0.1:${PORT}/api${p}`;
async function signUp(username) {
  const r = await fetch(url('/auth/register'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: 'correct horse battery' }) });
  assert.equal(r.status, 201);
  return r.headers.get('set-cookie').split(';')[0];
}
const call = async (ck, method, p, body) => {
  const r = await fetch(url(p), { method, headers: { 'content-type': 'application/json', cookie: ck }, body: body && JSON.stringify(body) });
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : null };
};

before(async () => {
  await startMock();
  app = spawn('node', ['--no-warnings', 'server/index.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), FOLIO_DATA_DIR: DATA, FOLIO_MAX_ACCOUNTS_PER_IP: '0' } });
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(url('/health'))).ok) break;
    } catch {
      /* wait */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  alice = await signUp('alice');
  bob = await signUp('bobby');
  for (const ck of [alice, bob]) {
    const p = await call(ck, 'POST', '/providers', { name: 'Mock', type: 'openai-compatible', baseUrl: `http://127.0.0.1:${mockPort}/v1`, defaultModel: 'm1' });
    assert.equal(p.status, 201, JSON.stringify(p.body));
  }
});
after(async () => {
  await new Promise((r) => { app.once('exit', r); app.kill('SIGTERM'); });
  mock.close();
  fs.rmSync(DATA, { recursive: true, force: true });
});

test('one small prompt writes a whole card, cleaned up and clipped', async () => {
  const r = await call(alice, 'POST', '/characters/generate', { idea: 'a gruff space salvager' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const f = r.body.fields;
  for (const k of ['name', 'description', 'personality', 'background', 'speakingStyle', 'goals', 'greeting', 'exampleDialogue', 'systemPromptAddition']) assert.ok(f[k], k);
  assert.deepEqual(f.tags, ['space', 'salvage', 'banter']);
  assert.ok(prompts.at(-1).messages.at(-1).content.includes('a gruff space salvager'));
});

test('assist mode writes only the asked fields and shows the model what is already written', async () => {
  const r = await call(alice, 'POST', '/characters/generate', { fields: ['greeting'], current: { name: 'Wren', personality: 'Dry and loyal.', greeting: '' } });
  assert.deepEqual(Object.keys(r.body.fields), ['greeting']);
  const sent = prompts.at(-1).messages.at(-1).content;
  assert.match(sent, /name: Wren/);
  assert.match(sent, /personality: Dry and loyal\./);
  assert.doesNotMatch(sent, /=== personality ===/);
});

test('needs some idea or draft; model JSON and garbage are handled', async () => {
  assert.equal((await call(alice, 'POST', '/characters/generate', {})).status, 400);
  designReply = '```json\n{"name":"Juno","description":"Pilot."}\n```';
  const ok = await call(alice, 'POST', '/characters/generate', { idea: 'pilot', fields: ['name', 'description'] });
  assert.equal(ok.body.fields.name, 'Juno');
  designReply = 'I cannot do that.';
  const no = await call(alice, 'POST', '/characters/generate', { idea: 'pilot', fields: ['name'] });
  assert.equal(no.status, 502);
  assert.equal(no.body.error.code, 'bad_model_output');
  designReply = null;
});

test('generation can use a chosen provider and reports a missing one', async () => {
  const r = await call(alice, 'POST', '/characters/generate', { idea: 'x', fields: ['name'], providerId: 'nope' });
  assert.equal(r.status, 409);
  const fresh = await signUp('carol');
  const none = await call(fresh, 'POST', '/characters/generate', { idea: 'x' });
  assert.equal(none.body.error.code, 'no_provider');
});

let sharedId, wrenId;
test('sharing: publish, others see it without private data, add a copy', async () => {
  const c = await call(alice, 'POST', '/characters', { name: 'Wren', description: 'Navigator', tags: ['sea'], personality: 'Dry.', systemPromptAddition: 'Be brief.', providerId: null, avatar: 'data:image/png;base64,iVBORw0KGgo=' });
  wrenId = c.body.id;
  await call(alice, 'POST', `/characters/${wrenId}/memories`, { content: 'Alice secretly likes tea.' });
  assert.deepEqual((await call(bob, 'GET', '/shared')).body, []);
  const p = await call(alice, 'POST', `/characters/${wrenId}/share`);
  assert.equal(p.status, 200);
  sharedId = p.body.sharedId;
  const list = (await call(bob, 'GET', '/shared')).body;
  assert.equal(list.length, 1);
  assert.equal(list[0].owner, 'alice');
  assert.equal(list[0].mine, false);
  assert.equal((await call(alice, 'GET', '/shared')).body[0].mine, true);
  const full = (await call(bob, 'GET', `/shared/${sharedId}`)).body;
  assert.equal(full.card.systemPromptAddition, 'Be brief.');
  assert.ok(!JSON.stringify(full).includes('tea'), 'no memories leak');
  assert.equal((await fetch(url(`/shared/${sharedId}/avatar`), { headers: { cookie: bob } })).status, 200);

  const added = await call(bob, 'POST', `/shared/${sharedId}/add`);
  assert.equal(added.status, 201);
  assert.equal(added.body.name, 'Wren');
  assert.deepEqual(added.body.origin, { sharedId, owner: 'alice' });
  const mine = (await call(bob, 'GET', '/characters')).body;
  assert.equal(mine.length, 1);
  assert.equal(mine[0].memoryCount, 0);
  assert.equal((await call(alice, 'GET', '/characters')).body[0].memoryCount, 1);
  assert.equal((await call(bob, 'GET', '/shared')).body[0].adds, 1);
  assert.equal((await call(alice, 'POST', `/shared/${sharedId}/add`)).status, 400, 'cannot add your own');
});

test('sharing: only the owner can change or remove; edits republish; bob cannot reshare an untouched copy', async () => {
  assert.equal((await call(bob, 'DELETE', `/shared/${sharedId}`)).status, 403);
  const bobsCopy = (await call(bob, 'GET', '/characters')).body[0];
  const reshare = await call(bob, 'POST', `/characters/${bobsCopy.id}/share`);
  assert.equal(reshare.status, 400);
  assert.equal(reshare.body.error.code, 'unchanged_copy');
  await call(bob, 'PATCH', `/characters/${bobsCopy.id}`, { personality: 'Bob changed this.' });
  assert.equal((await call(bob, 'POST', `/characters/${bobsCopy.id}/share`)).status, 200);

  await call(alice, 'PATCH', `/characters/${wrenId}`, { description: 'Navigator, updated' });
  assert.equal((await call(alice, 'POST', `/characters/${wrenId}/share`)).body.sharedId, sharedId, 'same card is updated in place');
  assert.equal((await call(bob, 'GET', `/shared/${sharedId}`)).body.description, 'Navigator, updated');
  assert.deepEqual(Object.keys((await call(alice, 'GET', '/shared/mine')).body), [wrenId]);

  await call(alice, 'DELETE', `/characters/${wrenId}/share`);
  assert.equal((await call(bob, 'GET', `/shared/${sharedId}`)).status, 404);
  assert.equal((await call(bob, 'GET', '/characters')).body.length, 1, 'copies people already added are theirs to keep');
});

test('sharing requires sign-in', async () => {
  assert.equal((await fetch(url('/shared'))).status, 401);
});
