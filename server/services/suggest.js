import { HttpError } from '../util.js';
import { getSettings } from '../settings.js';
import { getCharacterRow, toCharacter } from './characters.js';
import { requireConversation } from './conversations.js';
import { loadHistory } from './context.js';
import { complete, resolveRun } from './generate.js';

const SYSTEM = `You suggest what the user could say next in a roleplay chat. You write only the user's possible messages, never the character's.
Rules:
- Write in the first person, as the user, in the same language and register as the user's earlier messages (if there are none, match the scene).
- Give exactly the requested number of options. Make them clearly different from each other in intent or tone (for example curious, playful, bold, cautious, emotional).
- Each option is one to three sentences, a natural thing a person would type, and moves the scene forward. Use *asterisks* for actions only if the conversation already does.
- Do not repeat anything the user already said, do not speak or act for the character, and do not add commentary.
- Output only the options, each on its own line, separated by a line containing only ---.`;

const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n)}…` : String(s));

function parse(text, count) {
  const parts = text
    .replace(/```[a-z]*\n?|```/gi, '')
    .split(/\n\s*-{3,}\s*\n|\n(?=\s*\d+[.)]\s)/)
    .map((p) => p.replace(/^\s*(?:\d+[.)]|[-*•])\s+/, '').replace(/^["“]|["”]$/g, '').replace(/^\s*(?:option|reply)\s*\d*\s*[:.-]\s*/i, '').trim())
    .filter((p) => p && !/^-+$/.test(p));
  const seen = new Set();
  const out = [];
  for (const p of parts) {
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clip(p, 500));
  }
  return out.slice(0, count);
}

/** Possible next messages for the user. Nothing here is saved, and memory is not touched. */
export async function suggestReplies(conversationId, { count = 3, signal } = {}) {
  count = Math.max(1, Math.min(5, Number(count) || 3));
  const conv = requireConversation(conversationId);
  const characterRow = getCharacterRow(conv.character_id);
  const character = toCharacter(characterRow);
  const settings = getSettings();
  const { cfg } = resolveRun(conv, characterRow, settings);
  const history = loadHistory(conversationId);

  const user = settings.userName?.trim() || 'the user';
  const transcript = history.length
    ? history.slice(-12).map((m) => `${m.role === 'user' ? user : character.name}: ${clip(m.content, 900)}`).join('\n\n')
    : '(nothing has been said yet)';
  const card = [
    `Character: ${character.name}`,
    character.description && `About them: ${clip(character.description, 300)}`,
    character.personality && `Personality: ${clip(character.personality, 400)}`,
  ].filter(Boolean).join('\n');

  const prompt = `${card}\n\nConversation so far (the last message is the most recent):\n"""\n${transcript}\n"""\n\nWrite ${count} different options for what ${user} could say ${history.length ? 'next' : 'to open the conversation'}.`;
  let text = await complete(cfg, { system: SYSTEM, messages: [{ role: 'user', content: prompt }], maxTokens: 120 * count + 120, temperature: 0.95, signal });
  let list = parse(text, count);
  if (!list.length) {
    text = await complete(cfg, { system: SYSTEM, messages: [{ role: 'user', content: `${prompt}\n\nReply with only the options, separated by lines containing ---.` }], maxTokens: 120 * count + 120, temperature: 0.8, signal });
    list = parse(text, count);
  }
  if (!list.length) throw new HttpError(502, 'The model did not return usable suggestions.', 'bad_model_output', { hint: 'Try again, or choose a more capable model for this chat.' });
  return { suggestions: list };
}
