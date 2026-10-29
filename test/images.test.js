import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-img-'));
const PORT = 5100 + Math.floor(Math.random() * 90);
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
let mock, mp, app, ck;
const seen = [];
let checks = 0;
let needKey = false;

function startMock() {
  return new Promise((resolve) => {
    mock = http.createServer((req, res) => {
      let b = '';
      req.on('data', (d) => (b += d));
      req.on('end', () => {
        const u = new URL(req.url, 'http://x');
        seen.push({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), headers: req.headers, body: b ? JSON.parse(b) : null });
        const json = (o, st = 200) => (res.statusCode = st, res.setHeader('content-type', 'application/json'), res.end(JSON.stringify(o)));
        if (u.pathname === '/v2/generate/async') return json({ id: 'job1' }, 202);
        if (u.pathname === '/v2/generate/check/job1') return json(++checks < 2 ? { done: false, queue_position: 2, wait_time: 9, is_possible: true } : { done: true, is_possible: true });
        if (u.pathname === '/v2/generate/status/job1' && req.method === 'GET') return json({ generations: [{ img: PNG }, { img: PNG, censored: true }] });
        if (u.pathname.startsWith('/image/')) {
          if (needKey && !req.headers.authorization) return json({ error: 'key required' }, 401);
          res.setHeader('content-type', 'image/png');
          return res.end(Buffer.from(PNG, 'base64'));
        }
        if (u.pathname === '/v1/images/generations') return json({ data: [{ b64_json: PNG }] });
        if (u.pathname.endsWith('/models')) return json({ data: [{ id: 'm1' }] });
        const sys = JSON.parse(b || '{}').messages?.[0]?.content || '';
        let reply = 'ok';
        if (sys.startsWith('You write prompts for an AI image')) reply = '"silver braid, weathered face, wool coat"';
        if (sys.startsWith('You suggest what the user could say next')) reply = '1. Who are you?\n---\n2. *steps closer* Tell me more.\n---\n3. I should go.';
        res.setHeader('content-type', 'text/event-stream');
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n\ndata: [DONE]\n\n`);
        res.end();
      });
    });
    mock.listen(0, '127.0.0.1', () => ((mp = mock.address().port), resolve()));
  });
}
const url = (p) => `http://127.0.0.1:${PORT}/api${p}`;
const call = async (method, p, body) => {
  const r = await fetch(url(p), { method, headers: { 'content-type': 'application/json', cookie: ck }, body: body && JSON.stringify(body) });
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : null };
};
async function sse(p, body) {
  const r = await fetch(url(p), { method: 'POST', headers: { 'content-type': 'application/json', cookie: ck }, body: JSON.stringify(body) });
  return (await r.text()).split('\n\n').filter((x) => x.startsWith('event:')).map((x) => ({ event: x.match(/event: (.*)/)[1], data: JSON.parse(x.match(/data: (.*)/)[1]) }));
}

before(async () => {
  await startMock();
  app = spawn('node', ['--no-warnings', 'server/index.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), FOLIO_DATA_DIR: DATA, FOLIO_MAX_ACCOUNTS_PER_IP: '0', FOLIO_IMAGE_POLL_MS: '50' } });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(url('/health'))).ok) break; } catch { /* wait */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  const r = await fetch(url('/auth/register'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'imgtester', password: 'correct horse battery' }) });
  ck = r.headers.get('set-cookie').split(';')[0];
});
after(async () => {
  await new Promise((r) => { app.once('exit', r); app.kill('SIGTERM'); });
  mock.close();
  fs.rmSync(DATA, { recursive: true, force: true });
});

test('defaults to the free no-key service and never returns a stored key', async () => {
  const c = (await call('GET', '/images/config')).body;
  assert.equal(c.provider, 'horde');
  assert.equal(c.hasKey, false);
  assert.ok(c.styles.includes('anime'));
  const s = (await call('PUT', '/images/config', { provider: 'openai', baseUrl: `http://127.0.0.1:${mp}/v1`, apiKey: 'sk-secret-1234', model: 'gpt-image-1' })).body;
  assert.equal(s.hasKey, true);
  assert.equal(s.keyHint, '••••1234');
  assert.ok(!JSON.stringify(s).includes('sk-secret'));
  const remote = await call('PUT', '/images/config', { provider: 'openai', baseUrl: 'https://api.openai.com/v1' });
  assert.equal(remote.status, 409);
  assert.equal(remote.body.error.code, 'remote_ack_required');
});

test('AI Horde: submits anonymously, reports queue progress, skips censored images', async () => {
  await call('PUT', '/images/config', { provider: 'horde', baseUrl: `http://127.0.0.1:${mp}/v2`, clearKey: true });
  seen.length = 0;
  const ev = await sse('/images/portraits', { prompt: 'a lighthouse keeper', style: 'anime', count: 2 });
  assert.ok(ev.some((e) => e.event === 'progress' && e.data.queuePosition === 2));
  const imgs = ev.filter((e) => e.event === 'image');
  assert.equal(imgs.length, 1);
  assert.match(imgs[0].data.dataUrl, /^data:image\/png;base64,/);
  const sub = seen.find((r) => r.path === '/v2/generate/async');
  assert.equal(sub.headers.apikey, '0000000000');
  assert.equal(sub.body.nsfw, false);
  assert.equal(sub.body.params.n, 2);
  assert.match(sub.body.prompt, /lighthouse keeper.*anime style.*###/);
});

test('Pollinations: sends the key as a bearer token and explains a missing key', async () => {
  await call('PUT', '/images/config', { provider: 'pollinations', baseUrl: `http://127.0.0.1:${mp}`, model: 'flux' });
  needKey = true;
  const no = await sse('/images/portraits', { prompt: 'x', count: 1 });
  assert.equal(no.at(-1).event, 'error');
  assert.equal(no.at(-1).data.code, 'auth');
  assert.match(no.at(-1).data.hint, /free/i);
  await call('PUT', '/images/config', { apiKey: 'pk_abc' });
  seen.length = 0;
  const ok = await sse('/images/portraits', { prompt: 'x', count: 2 });
  needKey = false;
  assert.equal(ok.filter((e) => e.event === 'image').length, 2);
  const r = seen.find((x) => x.path.startsWith('/image/'));
  assert.equal(r.headers.authorization, 'Bearer pk_abc');
  assert.equal(r.query.model, 'flux');
  assert.equal(r.query.safe, 'true');
});

test('OpenAI-compatible images API', async () => {
  await call('PUT', '/images/config', { provider: 'openai', baseUrl: `http://127.0.0.1:${mp}/v1`, apiKey: 'sk-1', model: 'dall-e-3' });
  seen.length = 0;
  const ev = await sse('/images/portraits', { prompt: 'a pilot', count: 1 });
  assert.equal(ev.filter((e) => e.event === 'image').length, 1);
  const r = seen.find((x) => x.path === '/v1/images/generations');
  assert.equal(r.body.response_format, 'b64_json');
  assert.equal(r.headers.authorization, 'Bearer sk-1');
});

test('prompt needs text; prompt writer uses the text model and cleans quotes', async () => {
  assert.equal((await sse('/images/portraits', { prompt: '  ' })).at(-1).data.code, 'prompt_required');
  const nothing = await call('POST', '/images/prompt', { character: { description: 'A sailor.' } });
  assert.equal(nothing.body.fromModel, false, 'works without a text provider by falling back to the card');
  assert.match(nothing.body.prompt, /sailor/);
  await call('POST', '/providers', { name: 'Mock', type: 'openai-compatible', baseUrl: `http://127.0.0.1:${mp}/v1`, defaultModel: 'm1' });
  const r = await call('POST', '/images/prompt', { character: { name: 'Old Tam', description: 'A sailor.', personality: 'Gruff.' } });
  assert.equal(r.body.fromModel, true);
  assert.equal(r.body.prompt, 'silver braid, weathered face, wool coat');
  assert.equal((await call('POST', '/images/prompt', { character: {} })).status, 400);
});

test('suggest a reply: three distinct options, nothing saved', async () => {
  const c = (await call('POST', '/characters', { name: 'Wren', greeting: 'You lost, {{user}}?', personality: 'Dry.' })).body;
  const conv = (await call('POST', `/characters/${c.id}/conversations`, {})).body;
  const before = (await call('GET', `/conversations/${conv.id}`)).body.messages.length;
  const r = await call('POST', `/conversations/${conv.id}/suggest-reply`, { count: 3 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.suggestions, ['Who are you?', '*steps closer* Tell me more.', 'I should go.']);
  assert.equal((await call('GET', `/conversations/${conv.id}`)).body.messages.length, before, 'no message was added');
  assert.equal((await call('POST', '/conversations/nope/suggest-reply', {})).status, 404);
});
