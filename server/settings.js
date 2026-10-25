import { q } from './db.js';
import { bad, safeJson, clamp } from './util.js';

export const DEFAULT_SETTINGS = {
  theme: 'system', // system | light | dark
  userName: '',
  defaultProviderId: null,
  defaultModel: '',
  memory: {
    enabled: true,
    extraction: 'model', // model | heuristic | off
    extractEveryUserMessages: 2,
    requireApproval: false,
    retrievalLimit: 12,
    includeExcerpts: true,
    includeDigest: true,
    budgetPct: 22,
    maxPromptTokens: 16000,
    summarizeAfterMessages: 14,
  },
  chat: {
    sendOnEnter: true,
    showContextInspector: true,
    autoTitle: true,
    textSize: 'medium', // small | medium | large
  },
};

const ENUMS = {
  theme: ['system', 'light', 'dark'],
  'memory.extraction': ['model', 'heuristic', 'off'],
  'chat.textSize': ['small', 'medium', 'large'],
};

const NUM_RANGES = {
  'memory.extractEveryUserMessages': [1, 20],
  'memory.retrievalLimit': [1, 50],
  'memory.budgetPct': [5, 50],
  'memory.maxPromptTokens': [1024, 200000],
  'memory.summarizeAfterMessages': [8, 200],
};

function deepClone(o) {
  return JSON.parse(JSON.stringify(o));
}

export function getSettings() {
  const out = deepClone(DEFAULT_SETTINGS);
  for (const row of q.all('SELECT key, value FROM settings')) {
    const val = safeJson(row.value);
    if (val === null) continue;
    if (row.key in out && typeof out[row.key] === 'object' && out[row.key] !== null && !Array.isArray(out[row.key])) {
      Object.assign(out[row.key], val);
    } else {
      out[row.key] = val;
    }
  }
  return out;
}

/** Validate a partial settings object against the defaults' shape; unknown keys are rejected. */
export function sanitizeSettings(input, path = '', template = DEFAULT_SETTINGS) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw bad('Settings must be an object.');
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    const full = path ? `${path}.${k}` : k;
    if (!(k in template)) throw bad(`Unknown setting "${full}".`);
    const def = template[k];
    if (def !== null && typeof def === 'object' && !Array.isArray(def)) {
      out[k] = sanitizeSettings(v, full, def);
    } else if (typeof def === 'boolean') {
      if (typeof v !== 'boolean') throw bad(`Setting "${full}" must be true or false.`);
      out[k] = v;
    } else if (typeof def === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n)) throw bad(`Setting "${full}" must be a number.`);
      const [lo, hi] = NUM_RANGES[full] || [-Infinity, Infinity];
      out[k] = Math.round(clamp(n, lo, hi));
    } else if (full in ENUMS) {
      if (!ENUMS[full].includes(v)) throw bad(`Setting "${full}" must be one of: ${ENUMS[full].join(', ')}.`);
      out[k] = v;
    } else if (k === 'defaultProviderId') {
      out[k] = v ? String(v) : null;
    } else if (typeof def === 'string') {
      out[k] = String(v ?? '').slice(0, 200);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function updateSettings(patch) {
  const clean = sanitizeSettings(patch);
  const current = getSettings();
  for (const [k, v] of Object.entries(clean)) {
    const merged =
      typeof v === 'object' && v !== null && !Array.isArray(v) ? { ...current[k], ...v } : v;
    q.run(
      'INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      k,
      JSON.stringify(merged)
    );
  }
  return getSettings();
}
