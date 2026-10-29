import { bad, HttpError } from '../util.js';
import { complete, resolveRun } from './generate.js';

/**
 * Character creation with the model's help. Two modes:
 *  - one small prompt: write a whole character from an idea
 *  - assist: write only the fields asked for (empty ones, or one field), using what the person already wrote
 * The model answers in labelled sections rather than JSON: long prose inside JSON strings breaks easily on small local models.
 */

export const DESIGN_FIELDS = ['name', 'description', 'tags', 'personality', 'background', 'speakingStyle', 'goals', 'greeting', 'exampleDialogue', 'systemPromptAddition'];
const LIMITS = { name: 80, description: 280, personality: 2500, background: 4000, speakingStyle: 2000, goals: 2000, greeting: 1500, exampleDialogue: 3500, systemPromptAddition: 3000 };

const GUIDE = {
  name: 'a memorable name (just the name)',
  description: 'one or two lines for a library card, under 200 characters',
  tags: 'three to six lowercase tags separated by commas',
  personality: 'traits, temperament, quirks, how they treat people; concrete and specific, 80-200 words',
  background: 'history, setting and relationships, with a few specific facts to build on; 120-300 words',
  speakingStyle: 'how they talk: rhythm, vocabulary, habits, what they never say; 50-120 words',
  goals: 'what they want, fear, like and avoid; 50-120 words',
  greeting: "the character's opening message to {{user}}, written in their own voice, 40-120 words, with a hook that invites a reply",
  exampleDialogue: 'a short exchange of 4-6 lines that shows the voice, formatted as "{{user}}: ..." and "{{char}}: ..." lines',
  systemPromptAddition: 'brief behaviour rules for the roleplay (reply length, never speak for {{user}}, staying in character); not a repeat of the personality; 40-120 words',
};

const SYSTEM = `You help write characters for a roleplay chat app. You write the character card only; you do not chat as the character.
Rules:
- Write in the language of the person's idea.
- Use {{user}} for the person chatting and {{char}} for the character's name wherever either is referred to by name.
- Be specific and original. Prefer concrete details over adjectives. Avoid cliches such as "mysterious past".
- Keep content suitable for a general audience unless the idea clearly asks for something else, and never sexualise minors.
- Output ONLY the requested sections, each introduced by a line like === fieldname === and nothing else: no preface, no commentary, no markdown fences.`;

function clip(s, n) {
  s = String(s ?? '');
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function parseSections(text, wanted) {
  const out = {};
  const re = /^[ \t]*={2,}[ \t]*([A-Za-z]+)[ \t]*={2,}[ \t]*$/gm;
  const marks = [...text.matchAll(re)];
  marks.forEach((m, i) => {
    const key = DESIGN_FIELDS.find((f) => f.toLowerCase() === m[1].toLowerCase());
    if (!key) return;
    const body = text.slice(m.index + m[0].length, marks[i + 1]?.index ?? text.length).replace(/^\s*\n/, '').trim();
    if (body && !(key in out)) out[key] = body;
  });
  // Models sometimes ignore the format and return JSON; accept that too.
  if (!Object.keys(out).length) {
    const j = text.match(/\{[\s\S]*\}/);
    if (j) {
      try {
        const o = JSON.parse(j[0]);
        for (const k of wanted) if (o[k] != null && o[k] !== '') out[k] = Array.isArray(o[k]) ? o[k].join(', ') : String(o[k]);
      } catch {
        /* fall through */
      }
    }
  }
  const clean = {};
  for (const k of wanted) {
    if (!(k in out)) continue;
    let v = out[k].replace(/^["“]|["”]$/g, k === 'name' ? '' : '$&').trim();
    if (k === 'name') v = v.split('\n')[0].replace(/^[#*\s"']+|[#*\s"'.]+$/g, '');
    if (k === 'tags') {
      clean.tags = [...new Set(v.split(/[,\n]/).map((t) => t.replace(/^[#\s-]+/, '').trim().toLowerCase()).filter((t) => t && t.length <= 30))].slice(0, 8);
      continue;
    }
    if (k === 'description') v = v.replace(/\s*\n\s*/g, ' ');
    clean[k] = clip(v, LIMITS[k]).trim();
  }
  return clean;
}

/**
 * @param {object} p
 * @param {string} p.idea       what the person wants (a few words up to a paragraph); optional in assist mode
 * @param {string[]} p.fields   which fields to write (default: all)
 * @param {object} p.current    the draft so far, so new text agrees with what the person already wrote
 * @param {string} p.providerId optional provider override; empty uses the default
 * @param {string} p.model      optional model override
 */
export async function designCharacter({ idea = '', fields, current = {}, providerId, model, signal }) {
  idea = String(idea || '').trim();
  if (idea.length > 3000) throw bad('Keep the idea under 3,000 characters.');
  const wanted = (Array.isArray(fields) && fields.length ? fields : DESIGN_FIELDS).filter((f) => DESIGN_FIELDS.includes(f));
  if (!wanted.length) throw bad('Choose which parts to write.');
  const hasDraft = DESIGN_FIELDS.some((k) => String(Array.isArray(current[k]) ? current[k].join('') : current[k] || '').trim());
  if (!idea && !hasDraft) throw bad('Describe the character you have in mind first, even in a few words.', 'idea_required');

  const { cfg } = resolveRun(
    providerId || model ? { provider_id: providerId || null, model: model || '' } : null,
    null
  );

  const draft = DESIGN_FIELDS.filter((k) => !wanted.includes(k))
    .map((k) => [k, Array.isArray(current[k]) ? current[k].join(', ') : String(current[k] || '').trim()])
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${clip(v, 1200)}`)
    .join('\n\n');
  const rewriting = wanted.filter((k) => String((Array.isArray(current[k]) ? current[k].join(', ') : current[k]) || '').trim());

  const prompt = [
    idea ? `Idea from the person:\n"""${idea}"""` : 'The person gave no extra idea: build on what is already written.',
    draft ? `Already written (keep consistent with it, do not repeat it):\n${draft}` : '',
    rewriting.length ? `These fields already have text, which the person wants improved or replaced: ${rewriting.join(', ')}. Existing text:\n${rewriting.map((k) => `${k}: ${clip(Array.isArray(current[k]) ? current[k].join(', ') : current[k], 1200)}`).join('\n\n')}` : '',
    `Write these sections, in this order:\n${wanted.map((k) => `=== ${k} === : ${GUIDE[k]}`).join('\n')}`,
  ].filter(Boolean).join('\n\n');

  const maxTokens = Math.min(3500, 300 + wanted.reduce((n, k) => n + (k === 'name' || k === 'tags' ? 30 : k === 'description' ? 90 : 600), 0));
  const messages = [{ role: 'user', content: prompt }];
  let text = await complete(cfg, { system: SYSTEM, messages, maxTokens, temperature: 0.85, signal });
  let result = parseSections(text, wanted);
  if (!Object.keys(result).length) {
    // One retry with the format restated, which fixes most small-model slips.
    text = await complete(cfg, {
      system: SYSTEM,
      messages: [...messages, { role: 'assistant', content: clip(text, 1500) }, { role: 'user', content: `That was not in the requested format. Reply again with only the sections, each starting with a line like "=== ${wanted[0]} ===".` }],
      maxTokens, temperature: 0.6, signal,
    });
    result = parseSections(text, wanted);
  }
  if (!Object.keys(result).length) {
    throw new HttpError(502, "The model's answer could not be read as a character.", 'bad_model_output', { hint: 'Try again, or pick a more capable model for character creation.' });
  }
  return result;
}
