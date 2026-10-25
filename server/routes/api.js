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
