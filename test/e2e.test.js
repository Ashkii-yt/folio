import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-test-'));
const APP_PORT = 4400 + Math.floor(Math.random() * 400);
let mock, mockPort, app;
const seen = []; // every request the mock model received

const isChat = (s) => !s.messages[0].content.startsWith('You maintain') && !s.messages[0].content.startsWith('You write');

function startMock() {
  return new Promise((resolve) => {
    mock = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        if (req.url.endsWith('/models')) {
          res.setHeader('content-type', 'application/json');
          return res.end(JSON.stringify({ data: [{ id: 'mock-1' }, { id: 'mock-2' }] }));
        }
        const j = JSON.parse(body || '{}');
        const system = j.messages?.[0]?.content || '';
        seen.push(j);
        let reply;
        if (system.startsWith('You maintain the long-term memory')) {
          const user = j.messages.at(-1).content;
          const newPart = user.slice(user.lastIndexOf('\n-----\n'));
          const ops = [];
          const existing = user.match(/\[([0-9a-f-]{36})\] The user's sister is named Priya/);
          if (/Sharma/.test(newPart) && existing) {
            ops.push({ op: 'update', id: existing[1], content: "The user's sister is named Priya Sharma.", category: 'relationship', importance: 4, explicit: true });
          } else if (/Priya/.test(newPart) && !existing) {
            ops.push({ op: 'add', content: "The user's sister is named Priya.", category: 'relationship', importance: 4 });
          }
          if (/Tuesday/.test(newPart)) ops.push({ op: 'add', content: 'The user has a dentist appointment on Tuesday.', category: 'event', importance: 3 });
          reply = JSON.stringify({ memories: ops });
        } else if (system.startsWith('You write faithful summaries')) {
          reply = 'The user talked about their sister and a dentist visit.';
        } else if (j.messages.at(-1).content.includes('FAIL')) {
          res.statusCode = 500;
          res.setHeader('content-type', 'application/json');
          return res.end(JSON.stringify({ error: { message: 'boom' } }));
        } else reply = 'Aye, noted.';
        res.setHeader('content-type', 'text/event-stream');
        for (const part of reply.match(/[\s\S]{1,6}/g)) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
        res.end();
      });
    });
    mock.listen(0, '127.0.0.1', () => {
      mockPort = mock.address().port;
      resolve();
    });
  });
}

async function startApp() {
  app = spawn('node', ['--no-warnings', 'server/index.js'], { cwd: ROOT, env: { ...process.env, PORT: String(APP_PORT), FOLIO_DATA_DIR: DATA } });
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${APP_PORT}/api/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}
const stopApp = () =>
  new Promise((r) => {
    app.once('exit', r);
    app.kill('SIGTERM');
  });
const url = (p) => `http://127.0.0.1:${APP_PORT}/api${p}`;
const j = async (method, p, body) => {
  const r = await fetch(url(p), { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
};
async function sse(p, body) {
  const r = await fetch(url(p), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  const text = await r.text();
  return text
    .split('\n\n')
    .filter((b) => b.startsWith('event:'))
    .map((b) => ({ event: b.match(/event: (.*)/)[1], data: JSON.parse(b.match(/data: (.*)/)[1]) }));
}

let charId, providerId, conv1;
before(async () => {
  await startMock();
  await startApp();
});
after(async () => {
  await stopApp();
  mock.close();
  fs.rmSync(DATA, { recursive: true, force: true });
});

test('provider: saved, key never returned, encrypted at rest, tested, models discovered', async () => {
  const c = await j('POST', '/providers', {
    name: 'Mock', type: 'openai-compatible', baseUrl: `http://127.0.0.1:${mockPort}/v1`,
    apiKey: 'sk-secret-abcdef123456', defaultModel: 'mock-1', contextLength: 8192,
  });
  assert.equal(c.status, 201);
  providerId = c.body.provider.id;
  assert.equal(c.body.provider.hasKey, true);
  assert.ok(!JSON.stringify(c.body).includes('abcdef123456'));
  await j('GET', '/health');
  assert.ok(!fs.readFileSync(path.join(DATA, 'folio.db')).includes('abcdef123456'), 'key must be encrypted at rest');
  const t = await j('POST', '/providers/test', { id: providerId });
  assert.equal(t.body.ok, true);
  assert.equal(t.body.models.length, 2);
  assert.equal((await j('POST', '/providers', { name: 'x', type: 'openai-compatible', baseUrl: 'ftp://x' })).status, 400);
  assert.equal((await j('POST', '/providers', { name: 'x', type: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-1234567' })).body.error.code, 'remote_ack_required');
});

test('character: validation, create, partial edit keeps system prompt, duplicate, delete', async () => {
  assert.equal((await j('POST', '/characters', { name: '  ' })).status, 400);
  const c = await j('POST', '/characters', { name: 'Wren', personality: 'dry', systemPromptAddition: 'ALWAYS say aye.', greeting: 'Hello {{user}}' });
  charId = c.body.id;
  const e = await j('PATCH', `/characters/${charId}`, { personality: 'very dry' });
  assert.equal(e.body.systemPromptAddition, 'ALWAYS say aye.');
  assert.equal(e.body.personality, 'very dry');
  const d = await j('POST', `/characters/${charId}/duplicate`);
  assert.equal(d.body.systemPromptAddition, 'ALWAYS say aye.');
  assert.equal((await j('DELETE', `/characters/${d.body.id}`)).status, 204);
  assert.equal((await j('GET', `/characters/${d.body.id}`)).status, 404);
});

test('chat: streams, keeps order, prompt has card + custom instructions, failure keeps user message', async () => {
  const conv = (await j('POST', `/characters/${charId}/conversations`)).body;
  conv1 = conv.id;
  assert.equal(conv.messages.length, 1); // greeting
  const ev = await sse(`/conversations/${conv1}/messages`, { content: 'My sister is named Priya and I have a dentist thing on Tuesday.' });
  assert.deepEqual(ev.map((e) => e.event).filter((e) => e !== 'delta'), ['user_message', 'start', 'done']);
  const sys = seen.filter(isChat).at(-1).messages[0].content;
  assert.match(sys, /very dry/);
  assert.match(sys, /ALWAYS say aye\./);
  const fail = await sse(`/conversations/${conv1}/messages`, { content: 'FAIL please' });
  assert.equal(fail.at(-1).event, 'error');
  const msgs = (await j('GET', `/conversations/${conv1}`)).body.messages;
  assert.equal(msgs.at(-1).content, 'FAIL please');
  assert.deepEqual(msgs.map((m) => m.seq), msgs.map((_, i) => i + 1));
  // retry while the provider still fails: error again, and no duplicate user message
  const retry1 = await sse(`/conversations/${conv1}/regenerate`);
  assert.equal(retry1.at(-1).event, 'error');
  assert.equal((await j('GET', `/conversations/${conv1}`)).body.messages.length, msgs.length);
  // the provider recovers (here: the user rewords the message), and retry succeeds
  await j('PATCH', `/messages/${msgs.at(-1).id}`, { content: 'never mind, all good' });
  const retry2 = await sse(`/conversations/${conv1}/regenerate`);
  assert.equal(retry2.at(-1).event, 'done');
});

test('memory: extracted with provenance, not re-extracted, editable, pinned, deletable', async () => {
  const r = await j('POST', `/conversations/${conv1}/extract`);
  assert.ok(r.body.added >= 2 || r.body.reinforced >= 0, JSON.stringify(r.body));
  const list = (await j('GET', `/characters/${charId}/memories`)).body.memories;
  const priya = list.find((m) => /Priya/.test(m.content));
  assert.ok(priya && priya.sourceConversationId === conv1 && priya.source === 'auto', JSON.stringify(list));
  const again = await j('POST', `/conversations/${conv1}/extract`);
  assert.ok(!again.body.batches, 'nothing new to extract the second time');
  const up = await j('PATCH', `/memories/${priya.id}`, { content: "The user's sister is named Priya Rao.", pinned: true });
  assert.equal(up.body.source, 'user');
  assert.equal(up.body.pinned, true);
  const dent = list.find((m) => /dentist/.test(m.content));
  assert.equal((await j('DELETE', `/memories/${dent.id}`)).status, 204);
});

test('memory from an older conversation reaches a brand-new chat prompt', async () => {
  const conv2 = (await j('POST', `/characters/${charId}/conversations`)).body.id;
  await sse(`/conversations/${conv2}/messages`, { content: 'Hey, any idea what to get my sister for her birthday?' });
  const sys = seen.filter(isChat).at(-1).messages[0].content;
  assert.match(sys, /Priya Rao/);
  assert.match(sys, /Relevant records from earlier conversations/);
  assert.doesNotMatch(sys, /dentist appointment on Tuesday\./, 'deleted memory must not be used');
});

test('conflict: correction to a pinned memory waits for review; approval replaces, restore reverts', async () => {
  const conv3 = (await j('POST', `/characters/${charId}/conversations`)).body.id;
  await sse(`/conversations/${conv3}/messages`, { content: 'Actually my sister Priya goes by Sharma now.' });
  const r = await j('POST', `/conversations/${conv3}/extract`);
  assert.equal(r.body.pending, 1, JSON.stringify(r.body));
  let all = (await j('GET', `/characters/${charId}/memories?status=all`)).body.memories;
  const rao = all.find((m) => /Priya Rao/.test(m.content));
  assert.equal(rao.status, 'active');
  const pending = all.find((m) => m.status === 'pending');
  assert.equal(pending.conflictsWith, rao.id);
  await sse(`/conversations/${conv3}/messages`, { content: "What is my sister's name?" });
  assert.doesNotMatch(seen.filter(isChat).at(-1).messages[0].content, /Priya Sharma/, 'pending memories are not used');
  await j('POST', `/memories/${pending.id}/approve`);
  all = (await j('GET', `/characters/${charId}/memories?status=all`)).body.memories;
  assert.equal(all.find((m) => m.id === rao.id).status, 'superseded');
  assert.equal(all.find((m) => m.id === pending.id).status, 'active');
  await j('POST', `/memories/${rao.id}/restore`);
  all = (await j('GET', `/characters/${charId}/memories?status=all`)).body.memories;
  assert.equal(all.find((m) => m.id === rao.id).status, 'active');
  assert.equal(all.find((m) => m.id === pending.id).status, 'superseded');
});

test('edit & resend drops later messages; delete message removes it', async () => {
  const conv = (await j('POST', `/characters/${charId}/conversations`)).body.id;
  await sse(`/conversations/${conv}/messages`, { content: 'first' });
  await sse(`/conversations/${conv}/messages`, { content: 'second' });
  let msgs = (await j('GET', `/conversations/${conv}`)).body.messages;
  const first = msgs.find((m) => m.content === 'first');
  const ev = await sse(`/messages/${first.id}/resend`, { content: 'first, edited' });
  assert.equal(ev.at(-1).event, 'done');
  msgs = (await j('GET', `/conversations/${conv}`)).body.messages;
  assert.ok(!msgs.some((m) => m.content === 'second'));
  assert.ok(msgs.some((m) => m.content === 'first, edited' && m.editedAt));
  const last = msgs.at(-1);
  await j('DELETE', `/messages/${last.id}`);
  assert.equal((await j('GET', `/conversations/${conv}`)).body.messages.length, msgs.length - 1);
});

test('settings validated and persisted', async () => {
  assert.equal((await j('PUT', '/settings', { theme: 'neon' })).status, 400);
  assert.equal((await j('PUT', '/settings', { nope: 1 })).status, 400);
  const s = await j('PUT', '/settings', { theme: 'dark', userName: 'Ash', memory: { retrievalLimit: 99 } });
  assert.equal(s.body.theme, 'dark');
  assert.equal(s.body.memory.retrievalLimit, 50);
});

test('persistence across a server restart', async () => {
  await stopApp();
  await startApp();
  const convs = (await j('GET', `/characters/${charId}/conversations`)).body;
  assert.equal(convs.length, 4);
  assert.ok((await j('GET', `/conversations/${conv1}`)).body.messages.length >= 4);
  const mems = (await j('GET', `/characters/${charId}/memories?status=all`)).body.memories;
  assert.ok(mems.some((m) => /Priya Rao/.test(m.content) && m.status === 'active'), JSON.stringify(mems.map((m) => [m.content, m.status])));
  assert.equal((await j('GET', '/settings')).body.userName, 'Ash');
  assert.equal((await j('GET', '/providers')).body.length, 1);
  assert.equal((await j('POST', '/providers/test', { id: providerId })).body.ok, true, 'stored key still decrypts');
});

test('long chat on a small context window: prompt stays inside budget, summaries are added, originals are kept', async () => {
  const small = (await j('POST', '/providers', {
    name: 'Small', type: 'openai-compatible', baseUrl: `http://127.0.0.1:${mockPort}/v1`, defaultModel: 'mock-1', contextLength: 2048,
  })).body.provider;
  const conv = (await j('POST', `/characters/${charId}/conversations`, { providerId: small.id })).body.id;
  const filler = (i) => `Message number ${i}. ` + 'We kept talking about the lighthouse, the ferry timetable and the odd weather. '.repeat(7);
  for (let i = 1; i <= 12; i++) await sse(`/conversations/${conv}/messages`, { content: filler(i) });
  let sums = [];
  for (let i = 0; i < 40 && !sums.length; i++) {
    sums = (await j('GET', `/conversations/${conv}/summaries`)).body;
    if (!sums.length) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(sums.length >= 1, 'a summary was written for the older messages');
  assert.equal(sums[0].fromSeq, 1);
  const msgs = (await j('GET', `/conversations/${conv}`)).body.messages;
  assert.equal(msgs.length, 25, 'greeting + 24 messages are all still stored');
  assert.ok(msgs[1].content.startsWith('Message number 1.'), 'originals are not replaced by summaries');

  await sse(`/conversations/${conv}/messages`, { content: 'And one more thing about the ferry.' });
  const last = seen.filter(isChat).at(-1);
  const chars = last.messages.reduce((n, m) => n + m.content.length, 0);
  assert.ok(chars < 2048 * 3.5, `prompt is ${chars} chars, which must fit a 2048-token window`);
  assert.ok(last.messages.length < 27, 'not every old message was sent');
  assert.equal(last.messages.at(-1).content, 'And one more thing about the ferry.', 'the newest message is always sent');
  assert.match(JSON.stringify(last), /summaris/i, 'the summary stands in for what was dropped');
});

test('backup excludes secrets and round-trips; deleting a character cascades; wipe needs confirmation', async () => {
  const backup = (await j('GET', '/data/export')).body;
  assert.ok(!JSON.stringify(backup).includes('sk-secret'));
  const nMsgs = backup.tables.messages.length;
  assert.equal((await j('DELETE', `/characters/${charId}`)).status, 204);
  assert.equal((await j('GET', `/characters/${charId}/memories`)).status, 404);
  const restored = await j('POST', '/data/import', backup);
  assert.equal(restored.status, 200);
  assert.equal(restored.body.counts.messages, nMsgs);
  assert.ok((await j('GET', `/characters/${charId}/memories`)).body.memories.length >= 1);
  assert.equal((await j('POST', '/data/wipe', { confirm: 'nope' })).status, 400);
  assert.equal((await j('GET', '/providers')).body[0].hasKey, true, 'restore keeps the key on this machine');
});
