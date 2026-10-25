import net from 'node:net';
import { bad } from './util.js';

const BLOCKED_HOSTNAMES = new Set(['metadata.google.internal', 'metadata', 'instance-data']);

/** Where does this host live relative to the machine running Folio? */
export function classifyHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '0.0.0.0') return 'local';
  if (net.isIPv4(h)) {
    const [a, b] = h.split('.').map(Number);
    if (a === 127) return 'local';
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return 'lan';
    return 'remote';
  }
  if (net.isIPv6(h)) {
    if (h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return 'lan';
    return 'remote';
  }
  if (h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.internal') || !h.includes('.')) return 'lan';
  return 'remote';
}

/**
 * Validate and normalise a provider base URL.
 * Returns { url, scope: 'local'|'lan'|'remote', warnings: [] }.
 */
export function validateBaseUrl(raw, { type } = {}) {
  let text = String(raw || '').trim();
  if (!text) throw bad('Enter the API base URL.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`;
  let u;
  try {
    u = new URL(text);
  } catch {
    throw bad(`"${raw}" is not a valid URL. Example: http://127.0.0.1:11434`);
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw bad('Only http:// and https:// endpoints are supported.');
  if (u.username || u.password) throw bad('Do not put credentials in the URL. Use the API key field instead.');
  if (u.search || u.hash) throw bad('Remove the query string or fragment from the base URL.');
  const host = u.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(host) || /^169\.254\./.test(host)) {
    throw bad('That address is a cloud metadata endpoint and cannot be used as a model provider.');
  }
  const scope = classifyHost(host);
  const warnings = [];
  if (u.protocol === 'http:' && scope === 'remote') {
    warnings.push('This endpoint uses plain http:// over the internet. Traffic, including your API key, is not encrypted.');
  } else if (u.protocol === 'http:' && scope === 'lan') {
    warnings.push('This endpoint uses plain http:// on your network. Anyone on that network could read the traffic.');
  }
  let url = u.toString().replace(/\/+$/, '');
  if (type === 'ollama') url = url.replace(/\/(api|v1)$/i, '');
  return { url, scope, warnings };
}

const FORBIDDEN_HEADERS = new Set([
  'host', 'content-length', 'transfer-encoding', 'connection', 'upgrade', 'te', 'trailer',
  'keep-alive', 'cookie', 'set-cookie', 'content-type', 'accept-encoding', 'expect',
]);

export function validateHeaders(headers) {
  if (headers == null) return {};
  if (typeof headers !== 'object' || Array.isArray(headers)) throw bad('Custom headers must be an object of name/value pairs.');
  const entries = Object.entries(headers);
  if (entries.length > 20) throw bad('At most 20 custom headers are allowed.');
  const out = {};
  for (const [name, value] of entries) {
    const n = String(name).trim();
    if (!n) continue;
    if (!/^[A-Za-z0-9-]{1,64}$/.test(n)) throw bad(`"${n}" is not a valid header name.`);
    const lower = n.toLowerCase();
    if (FORBIDDEN_HEADERS.has(lower) || lower.startsWith('proxy-') || lower.startsWith('sec-')) {
      throw bad(`The "${n}" header is managed by Folio and cannot be overridden.`);
    }
    const v = String(value ?? '');
    if (/[\r\n\0]/.test(v) || v.length > 2000) throw bad(`The value for header "${n}" is invalid.`);
    out[n] = v;
  }
  return out;
}
