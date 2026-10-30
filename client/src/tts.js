/**
 * Read-aloud uses the voices built into the browser or phone (the Web Speech API). Nothing is sent anywhere,
 * and the voice choice is remembered per device, because every device has different voices.
 */
const KEY = 'folio.tts';
const DEFAULTS = { voiceURI: '', rate: 1, skipActions: true };

export const ttsSupported = () => typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;

export function getPrefs() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}
export function setPrefs(p) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...getPrefs(), ...p }));
  } catch {
    /* storage unavailable: the choice lasts until the page closes */
  }
}

export function listVoices() {
  return ttsSupported() ? window.speechSynthesis.getVoices() : [];
}
export function onVoices(fn) {
  if (!ttsSupported()) return () => {};
  window.speechSynthesis.addEventListener('voiceschanged', fn);
  return () => window.speechSynthesis.removeEventListener('voiceschanged', fn);
}

/** Plain speech from a chat message: markdown marks removed, and (optionally) *actions* left out. */
export function speakable(text, skipActions = true) {
  let t = String(text || '').replace(/```[\s\S]*?```/g, ' ').replace(/`([^`]*)`/g, '$1');
  const clean = (s) => s.replace(/[*_~#>]+/g, '').replace(/\s+/g, ' ').trim();
  if (skipActions) {
    const spoken = clean(t.replace(/\*[^*]*\*/g, ' '));
    if (spoken) return spoken; // a message that is only actions is read in full instead of staying silent
  }
  return clean(t);
}

function chunks(text, max = 200) {
  const sentences = text.split(/(?<=[.!?…。！？])\s+/);
  const out = [];
  let cur = '';
  const push = (s) => {
    while (s.length > max) {
      let cut = s.lastIndexOf(' ', max);
      if (cut < max / 2) cut = max;
      out.push(s.slice(0, cut).trim());
      s = s.slice(cut);
    }
    if (s.trim()) out.push(s.trim());
  };
  for (const s of sentences) {
    if ((cur + ' ' + s).length > max) {
      if (cur) push(cur);
      cur = s;
    } else cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) push(cur);
  return out;
}

let session = 0;
export function stopSpeaking() {
  session++;
  if (ttsSupported()) window.speechSynthesis.cancel();
}

/** Speak a message in short pieces (long single utterances are cut off by some browsers). Returns false if there is nothing to say. */
export function speak(text, { onEnd, onError } = {}) {
  if (!ttsSupported()) return false;
  const prefs = getPrefs();
  const parts = chunks(speakable(text, prefs.skipActions));
  if (!parts.length) return false;
  stopSpeaking();
  const mine = session;
  const voice = listVoices().find((v) => v.voiceURI === prefs.voiceURI);
  parts.forEach((p, i) => {
    const u = new SpeechSynthesisUtterance(p);
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang;
    }
    u.rate = Math.min(2, Math.max(0.5, Number(prefs.rate) || 1));
    u.onend = () => { if (session === mine && i === parts.length - 1) onEnd?.(); };
    u.onerror = (e) => {
      if (session !== mine || e.error === 'canceled' || e.error === 'interrupted') return;
      session++;
      onError?.(e.error);
    };
    window.speechSynthesis.speak(u);
  });
  return true;
}
