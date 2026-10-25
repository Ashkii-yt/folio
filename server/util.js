export class HttpError extends Error {
  constructor(status, message, code = 'error', extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

export const bad = (message, code = 'invalid') => new HttpError(400, message, code);
export const notFound = (what = 'Item') => new HttpError(404, `${what} not found.`, 'not_found');

export const uid = () => crypto.randomUUID();
export const now = () => new Date().toISOString();

export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** Conservative token estimate that works without a tokenizer. */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 3.5);
}

export function truncateToTokens(text, maxTokens) {
  const maxChars = Math.floor(maxTokens * 3.5);
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, maxChars - 1)).trimEnd() + '…';
}

export const STOPWORDS = new Set(
  `a about above after again against all also am an and any are aren't as at be because been before being below between both but by can can't cannot could couldn't did didn't do does doesn't doing don't down during each few for from further get got had hadn't has hasn't have haven't having he he'd he'll he's her here here's hers herself him himself his how how's i i'd i'll i'm i've if in into is isn't it it's its itself just let's like me more most mustn't my myself no nor not of off oh ok okay on once only or other ought our ours ourselves out over own really same shan't she she'd she'll she's should shouldn't so some such than that that's the their theirs them themselves then there there's these they they'd they'll they're they've this those through to too under until up very was wasn't we we'd we'll we're we've were weren't what what's when when's where where's which while who who's whom why why's will with won't would wouldn't yeah yes you you'd you'll you're you've your yours yourself yourselves tell know think want going gonna said say one thing things much many well still even`
    .split(/\s+/)
);

export function tokenize(text) {
  return (String(text || '').toLowerCase().match(/[\p{L}\p{N}']+/gu) || [])
    .map((t) => t.replace(/^'+|'+$/g, ''))
    .filter(Boolean);
}

/** Distinct content words, longer words first (they tend to be more specific). */
export function keywords(text, max = 14) {
  const seen = new Set();
  const out = [];
  for (const t of tokenize(text)) {
    if (STOPWORDS.has(t)) continue;
    if (t.length < 3 && !/\d/.test(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  out.sort((a, b) => b.length - a.length);
  return out.slice(0, max);
}

/** Build a safe FTS5 OR query from plain words. */
export function ftsQuery(words) {
  const cleaned = words
    .map((w) => String(w).replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((w) => w.length >= 2);
  if (!cleaned.length) return null;
  return cleaned.map((w) => `"${w}"`).join(' OR ');
}

export function jaccard(a, b) {
  const A = new Set(tokenize(a).filter((t) => !STOPWORDS.has(t)));
  const B = new Set(tokenize(b).filter((t) => !STOPWORDS.has(t)));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

export function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function daysBetween(isoA, isoB = new Date().toISOString()) {
  return Math.max(0, (new Date(isoB) - new Date(isoA)) / 86_400_000);
}

export function safeJson(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** Pull the first balanced JSON object/array out of model output (handles code fences and chatter). */
export function extractJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const direct = safeJson(s);
  if (direct !== null) return direct;
  const start = s.search(/[{[]/);
  if (start < 0) return null;
  const open = s[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return safeJson(s.slice(start, i + 1));
    }
  }
  return null;
}

/** Remove known secret values from any text before it is logged or returned. */
export function redact(text, secrets = []) {
  let out = String(text ?? '');
  for (const s of secrets) {
    if (s && String(s).length >= 6) out = out.split(String(s)).join('[redacted]');
  }
  out = out.replace(/(sk-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]{8,}/g, '$1…[redacted]');
  out = out.replace(/(AIza[0-9A-Za-z_-]{6})[0-9A-Za-z_-]{20,}/g, '$1…[redacted]');
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[redacted]');
  return out;
}

export function log(...args) {
  console.log(new Date().toISOString(), ...args.map((a) => (typeof a === 'string' ? redact(a) : a)));
}
