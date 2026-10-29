import express from 'express';
import { bad, notFound, HttpError, now } from '../util.js';
import { getSettings, updateSettings } from '../settings.js';
import {
  providerTypes, listProviders, createProvider, updateProvider, deleteProvider, getProviderRow,
  resolveConfig, draftConfig, discoverModels, testConnection,
} from '../providers/index.js';
import { ProviderError } from '../providers/http.js';
import {
  listCharacters, getCharacter, createCharacter, updateCharacter, deleteCharacter, duplicateCharacter,
  exportCharacter, importCharacter, getCharacterAvatar, cleanCharacterInput, getCharacterRow,
} from '../services/characters.js';
import {
  listConversations, createConversation, getConversation, updateConversation, deleteConversation,
  addMessage, editMessage, deleteMessages, deleteMessagesAfter, getMessage, getConversationRow, titleFrom, requireConversation,
} from '../services/conversations.js';
import {
  listMemories, memoryCounts, createMemory, updateMemory, deleteMemory, approveMemory, restoreMemory,
  clearMemories, exportMemories, importMemories, requireMemory, CATEGORIES,
} from '../services/memories.js';
import { retrieveMemories, retrieveExcerpts } from '../services/retrieval.js';
import { runExtraction, flushExtraction } from '../services/extract.js';
import { maybeSummarize } from '../services/summarize.js';
import { generateReply, previewReply, previewPrompt } from '../services/chat.js';
import { getImageConfig, setImageConfig, generatePortraits, writePortraitPrompt, STYLES } from '../services/images.js';
import { suggestReplies } from '../services/suggest.js';
import { designCharacter } from '../services/designer.js';
import { listShared, getShared, getSharedAvatar, mySharedMap, publish, unpublish, unpublishShared, addShared } from '../shared.js';
import { seedStarters } from '../services/starters.js';
import { exportAll, restoreAll, wipe, dataInfo } from '../services/backup.js';
import { streamJob } from './sse.js';
import { VERSION } from '../config.js';
import { q } from '../db.js';

export const api = express.Router();

/* ---------------------------------- app ---------------------------------- */

api.get('/health', (req, res) => res.json({ ok: true, version: VERSION }));

api.get('/bootstrap', (req, res) => {
  res.json({
    version: VERSION,
    settings: getSettings(),
    providers: listProviders(),
    providerTypes: providerTypes(),
    categories: CATEGORIES,
    data: dataInfo(),
  });
});

api.get('/settings', (req, res) => res.json(getSettings()));
api.put('/settings', (req, res) => res.json(updateSettings(req.body)));

/* ------------------------------- providers ------------------------------- */

api.get('/providers', (req, res) => res.json(listProviders()));
api.post('/providers', (req, res) => res.status(201).json(createProvider(req.body)));
api.patch('/providers/:id', (req, res) => res.json(updateProvider(req.params.id, req.body)));
api.delete('/providers/:id', (req, res) => {
  deleteProvider(req.params.id);
  res.status(204).end();
});

/** Test unsaved form values (or a saved provider, optionally with edits). Never returns the key. */
api.post('/providers/test', async (req, res) => {
  const cfg = draftConfig(req.body || {});
  res.json(await testConnection(cfg));
});

api.post('/providers/models', async (req, res) => {
  const cfg = draftConfig(req.body || {});
  try {
    res.json({ ok: true, models: await discoverModels(cfg) });
  } catch (e) {
    if (e instanceof ProviderError) return res.json({ ok: false, models: [], message: e.message, hint: e.hint, code: e.code });
    throw e;
  }
});

api.get('/providers/:id/models', async (req, res) => {
  const row = getProviderRow(req.params.id);
  if (!row) throw notFound('Provider');
  try {
    res.json({ ok: true, models: await discoverModels(resolveConfig(row)) });
  } catch (e) {
    if (e instanceof ProviderError) return res.json({ ok: false, models: [], message: e.message, hint: e.hint, code: e.code });
    throw e;
  }
});

/* ------------------------------- characters ------------------------------ */

api.get('/characters', (req, res) => res.json(listCharacters()));
api.post('/characters', (req, res) => res.status(201).json(createCharacter(req.body)));
api.post('/characters/import', (req, res) => res.status(201).json(importCharacter(req.body)));
api.post('/characters/starters', (req, res) => res.status(201).json(seedStarters()));

api.post('/characters/preview-prompt', (req, res) => {
  const clean = cleanCharacterInput({ name: 'Character', ...req.body });
  res.json(previewPrompt(clean));
});

api.post('/characters/preview-chat', (req, res) =>
  streamJob(req, res, async ({ emit, signal }) => {
    const { character, messages } = req.body || {};
    const clean = cleanCharacterInput({ name: 'Character', ...(character || {}) });
    if (!Array.isArray(messages) || !messages.length) throw bad('Send at least one message.');
    await previewReply(clean, messages.slice(-12), { emit, signal });
  })
);

api.post('/characters/generate', async (req, res) => {
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });
  const { idea, fields, current, providerId, model } = req.body || {};
  try {
    const result = await designCharacter({ idea, fields, current: current || {}, providerId, model, signal: ac.signal });
    res.json({ fields: result });
  } catch (e) {
    if (ac.signal.aborted) return;
    if (e instanceof ProviderError) throw new HttpError(502, e.message, e.code || 'provider_error', { hint: e.hint });
    throw e;
  }
});

/* -------------------------------- portraits ------------------------------- */

api.get('/images/config', (req, res) => res.json({ ...getImageConfig(), styles: Object.keys(STYLES) }));
api.put('/images/config', (req, res) => res.json({ ...setImageConfig(req.body || {}), styles: Object.keys(STYLES) }));
api.post('/images/prompt', async (req, res) => {
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });
  try {
    const ch = { ...(req.body?.character || {}) };
    if (!String(ch.name || '').trim()) delete ch.name;
    res.json(await writePortraitPrompt(cleanCharacterInput(ch, { partial: true }), { signal: ac.signal }));
  } catch (e) {
    if (ac.signal.aborted) return;
    if (e instanceof ProviderError) throw new HttpError(502, e.message, e.code || 'provider_error', { hint: e.hint });
    throw e;
  }
});
api.post('/images/portraits', (req, res) =>
  streamJob(req, res, async ({ emit, signal }) => {
    const { prompt, style, count } = req.body || {};
    const out = await generatePortraits({ prompt, style, count, signal, onProgress: (p) => emit('progress', p) });
    emit('start', { provider: out.provider, prompt: out.prompt });
    out.images.forEach((dataUrl, index) => emit('image', { index, dataUrl }));
    emit('done', { count: out.images.length });
  })
);

/* --------------------------------- sharing -------------------------------- */

api.get('/shared', (req, res) => res.json(listShared({ search: req.query.search, tag: req.query.tag })));
api.get('/shared/mine', (req, res) => res.json(mySharedMap()));
api.get('/shared/:id', (req, res) => res.json(getShared(req.params.id)));
api.get('/shared/:id/avatar', (req, res) => {
  const a = getSharedAvatar(req.params.id);
  if (!a) return res.status(404).end();
  res.setHeader('Content-Type', a.mime);
  res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
  res.setHeader('ETag', `"${a.version}"`);
  res.send(a.data);
});
api.post('/shared/:id/add', (req, res) => res.status(201).json(addShared(req.params.id)));
api.delete('/shared/:id', (req, res) => {
  unpublishShared(req.params.id);
  res.status(204).end();
});
api.post('/characters/:id/share', (req, res) => {
  getCharacter(req.params.id);
  res.json(publish(req.params.id));
});
api.delete('/characters/:id/share', (req, res) => {
  unpublish(req.params.id);
  res.status(204).end();
});

api.get('/characters/:id', (req, res) => res.json(getCharacter(req.params.id, { withAvatar: true })));
api.patch('/characters/:id', (req, res) => res.json(updateCharacter(req.params.id, req.body)));
api.delete('/characters/:id', (req, res) => {
  deleteCharacter(req.params.id);
  res.status(204).end();
});
api.post('/characters/:id/duplicate', (req, res) => res.status(201).json(duplicateCharacter(req.params.id)));
api.get('/characters/:id/export', (req, res) => {
  const data = exportCharacter(req.params.id);
  res.setHeader('Content-Disposition', `attachment; filename="${data.character.name.replace(/[^\w.-]+/g, '_')}.folio-character.json"`);
  res.json(data);
});
api.get('/characters/:id/avatar', (req, res) => {
  const a = getCharacterAvatar(req.params.id);
  if (!a) return res.status(404).end();
  res.setHeader('Content-Type', a.mime);
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.send(a.data);
});

/* ----------------------------- conversations ----------------------------- */

api.get('/characters/:id/conversations', (req, res) => {
  if (!getCharacterRow(req.params.id)) throw notFound('Character');
  res.json(listConversations(req.params.id));
});

api.post('/characters/:id/conversations', (req, res) => {
  const conv = createConversation(req.params.id, req.body || {});
  // A new chat is a natural moment to file away what was learned in the previous ones.
  flushExtraction(req.params.id, conv.id);
  res.status(201).json(conv);
});

api.get('/conversations/:id', (req, res) => res.json(getConversation(req.params.id)));
api.patch('/conversations/:id', (req, res) => res.json(updateConversation(req.params.id, req.body || {})));
api.delete('/conversations/:id', (req, res) => {
  deleteConversation(req.params.id);
  res.status(204).end();
});

/* -------------------------------- messages -------------------------------- */

function autoTitle(conversationId, text) {
  const conv = getConversationRow(conversationId);
  if (conv && conv.title === 'New conversation' && getSettings().chat.autoTitle) {
    q.run('UPDATE conversations SET title = ? WHERE id = ?', titleFrom(text), conversationId);
  }
}

function validText(content) {
  const text = String(content ?? '');
  if (!text.trim()) throw bad('Write a message first.');
  if (text.length > 60000) throw bad('That message is too long.');
  return text;
}

api.post('/conversations/:id/messages', (req, res) => {
  const text = validText(req.body?.content);
  requireConversation(req.params.id);
  return streamJob(req, res, async ({ emit, signal }) => {
    const message = addMessage(req.params.id, { role: 'user', content: text });
    autoTitle(req.params.id, text);
    emit('user_message', { message, title: getConversationRow(req.params.id).title });
    await generateReply(req.params.id, { emit, signal });
  });
});

/** Regenerate the last reply (or retry after a failure, when the last message is the user's). */
api.post('/conversations/:id/suggest-reply', async (req, res) => {
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });
  try {
    res.json(await suggestReplies(req.params.id, { count: req.body?.count, signal: ac.signal }));
  } catch (e) {
    if (ac.signal.aborted) return;
    if (e instanceof ProviderError) throw new HttpError(502, e.message, e.code || 'provider_error', { hint: e.hint });
    throw e;
  }
});
api.post('/conversations/:id/regenerate', (req, res) => {
  const conv = getConversation(req.params.id);
  const last = conv.messages[conv.messages.length - 1];
  if (!last) throw bad('There is nothing to regenerate yet.');
  if (last.role === 'character') {
    if (conv.messages.length < 2 || conv.messages[conv.messages.length - 2].role !== 'user') {
      throw bad('Only replies to one of your messages can be regenerated.');
    }
    deleteMessages(last.id);
  }
  return streamJob(req, res, async ({ emit, signal }) => {
    await generateReply(req.params.id, { emit, signal });
  });
});

/** Edit one of your messages, drop everything after it, and get a fresh reply. */
api.post('/messages/:id/resend', (req, res) => {
  const text = validText(req.body?.content);
  const msg = getMessage(req.params.id);
  if (msg.role !== 'user') throw bad('Only your own messages can be edited and resent.');
  editMessage(msg.id, text);
  deleteMessagesAfter(msg.conversationId, msg.seq);
  return streamJob(req, res, async ({ emit, signal }) => {
    emit('user_message', { message: getMessage(msg.id), title: getConversationRow(msg.conversationId).title });
    await generateReply(msg.conversationId, { emit, signal });
  });
});

/** Fix the wording of any message without regenerating anything. */
api.patch('/messages/:id', (req, res) => res.json(editMessage(req.params.id, req.body?.content)));

api.delete('/messages/:id', (req, res) => {
  res.json(deleteMessages(req.params.id, { fromHere: req.query.fromHere === '1' }));
});

/* -------------------------------- memories -------------------------------- */

api.get('/characters/:id/memories', (req, res) => {
  const { search = '', status = 'active', category = '' } = req.query;
  res.json({
    memories: listMemories(req.params.id, { search, status, category }),
    counts: memoryCounts(req.params.id),
  });
});
api.post('/characters/:id/memories', (req, res) => res.status(201).json(createMemory(req.params.id, req.body || {})));
api.delete('/characters/:id/memories', (req, res) => {
  res.json(clearMemories(req.params.id, { includeHistory: req.query.keepHistory !== '1' }));
});
api.get('/characters/:id/memories/export', (req, res) => {
  const data = exportMemories(req.params.id);
  res.setHeader('Content-Disposition', `attachment; filename="${data.character.name.replace(/[^\w.-]+/g, '_')}.memories.json"`);
  res.json(data);
});
api.post('/characters/:id/memories/import', (req, res) => res.json(importMemories(req.params.id, req.body)));

/** What would this character recall for a given message? Powers the memory inspector. */
api.get('/characters/:id/recall', (req, res) => {
  if (!getCharacterRow(req.params.id)) throw notFound('Character');
  const text = String(req.query.q || '').slice(0, 500);
  if (!text.trim()) return res.json({ memories: [], excerpts: [] });
  res.json({
    memories: retrieveMemories(req.params.id, text, { limit: 15 }).map((r) => ({ ...r.memory, score: Number(r.score.toFixed(3)) })),
    excerpts: retrieveExcerpts(req.params.id, text, { limit: 6 }),
  });
});

api.patch('/memories/:id', (req, res) => res.json(updateMemory(req.params.id, req.body || {})));
api.delete('/memories/:id', (req, res) => {
  deleteMemory(req.params.id);
  res.status(204).end();
});
api.post('/memories/:id/approve', (req, res) => res.json(approveMemory(req.params.id)));
api.post('/memories/:id/restore', (req, res) => res.json(restoreMemory(req.params.id)));

/** Run extraction right now on a conversation (the "Scan this chat" button). */
api.post('/conversations/:id/extract', async (req, res) => {
  requireConversation(req.params.id);
  const result = await runExtraction(req.params.id, { force: true });
  maybeSummarize(req.params.id).catch(() => {});
  res.json(result);
});

/** Read-only: the summaries stored for a conversation (originals are never replaced). */
api.get('/conversations/:id/summaries', (req, res) => {
  requireConversation(req.params.id);
  res.json(
    q.all('SELECT id, from_seq AS fromSeq, to_seq AS toSeq, content, method, created_at AS createdAt FROM summaries WHERE conversation_id = ? ORDER BY from_seq', req.params.id)
  );
});

/* ----------------------------------- data ---------------------------------- */

api.get('/data/info', (req, res) => res.json(dataInfo()));
api.get('/data/export', (req, res) => {
  res.setHeader('Content-Disposition', `attachment; filename="folio-backup-${now().slice(0, 10)}.json"`);
  res.json(exportAll());
});
api.post('/data/import', (req, res) => res.json(restoreAll(req.body)));
api.post('/data/wipe', (req, res) => {
  const { confirm, scope = 'content' } = req.body || {};
  if (confirm !== 'DELETE') throw new HttpError(400, 'Type DELETE to confirm.', 'confirm_required');
  if (!['content', 'everything'].includes(scope)) throw bad('Unknown scope.');
  wipe(scope);
  res.json({ ok: true });
});

api.use((req, res) => res.status(404).json({ error: { message: 'Unknown API route.', code: 'not_found' } }));
