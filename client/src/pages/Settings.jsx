import { useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Navigate, useParams } from 'react-router-dom';
import { Download, Pencil, Plus, Trash2, Upload, Zap } from 'lucide-react';
import { useApp } from '../store.jsx';
import { api, download, stream, uploadJson } from '../api.js';
import { Dialog, ErrorNotice, Field, Notice, Toggle, useConfirm, useToast } from '../ui.jsx';
import { bytes, hostScope } from '../lib.js';
import { getPrefs, setPrefs, listVoices, onVoices, speak, stopSpeaking, ttsSupported } from '../tts.js';

const SECTIONS = [
  ['general', 'General'],
  ['appearance', 'Appearance'],
  ['providers', 'AI providers'],
  ['memory', 'Memory'],
  ['portraits', 'Portraits'],
  ['data', 'Data and privacy'],
];

export default function Settings() {
  const { section } = useParams();
  if (!section) return <Navigate to="/settings/general" replace />;
  if (!SECTIONS.some(([k]) => k === section)) return <Navigate to="/settings/general" replace />;
  return (
    <div className="settings">
      <nav className="settings-nav" aria-label="Settings sections">
        <h1>Settings</h1>
        {SECTIONS.map(([k, label]) => (
          <NavLink key={k} to={`/settings/${k}`} className={({ isActive }) => `rail-link ${isActive ? 'active' : ''}`}>{label}</NavLink>
        ))}
      </nav>
      <div className="settings-body">
        <div className="page-inner">
          {section === 'general' && <General />}
          {section === 'appearance' && <Appearance />}
          {section === 'providers' && <Providers />}
          {section === 'memory' && <MemorySettings />}
          {section === 'portraits' && <PortraitSettings />}
          {section === 'data' && <DataSettings />}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ helpers */

function useSave() {
  const { saveSettings } = useApp();
  const toast = useToast();
  return async (patch) => {
    try { await saveSettings(patch); } catch (e) { toast.error(e.message); }
  };
}

/** A number input that commits on blur or Enter, and snaps back if the value is invalid. */
function Num({ id, value, onCommit, min, max, step = 1, suffix, placeholder, allowEmpty = false, width = 120 }) {
  const [v, setV] = useState(value ?? '');
  useEffect(() => { setV(value ?? ''); }, [value]);
  const commit = () => {
    if (v === '' || v == null) {
      if (allowEmpty) return value == null ? undefined : onCommit(null);
      return setV(value ?? '');
    }
    const n = Number(v);
    if (!Number.isFinite(n)) return setV(value ?? '');
    const c = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));
    setV(c);
    if (c !== value) onCommit(c);
  };
  return (
    <span className="cluster">
      <input id={id} className="input" style={{ width }} type="number" inputMode="decimal" min={min} max={max} step={step} value={v} placeholder={placeholder}
        onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
      {suffix && <span className="muted small">{suffix}</span>}
    </span>
  );
}

function Row({ label, hint, children, htmlFor }) {
  return (
    <div className="switch">
      <div className="grow"><label htmlFor={htmlFor} style={{ fontWeight: 600 }}>{label}</label>{hint && <div className="hint">{hint}</div>}</div>
      <div>{children}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ general */

function General() {
  const { settings, version, dataInfo } = useApp();
  const save = useSave();
  const [name, setName] = useState(settings.userName);
  useEffect(() => { setName(settings.userName); }, [settings.userName]);
  return (
    <>
      <h2>General</h2>
      <p className="lead">Defaults for how Folio looks and behaves.</p>
      <div className="group">
        <Field label="Your name" htmlFor="g-name" hint="Characters use this to address you. It is sent to your model provider with each message.">
          <input id="g-name" className="input" style={{ maxWidth: 320 }} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} onBlur={() => name !== settings.userName && save({ userName: name.trim() })} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} placeholder="Optional" />
        </Field>
      </div>
      <div className="group">
        <h3>Chat</h3>
        <Toggle label="Send with Enter" hint="Shift+Enter always adds a new line. When off, use Ctrl+Enter (Cmd+Enter on Mac) to send." checked={settings.chat.sendOnEnter} onChange={(v) => save({ chat: { sendOnEnter: v } })} />
        <Toggle label="Name new conversations automatically" hint="Uses the first words of your first message. You can rename any conversation." checked={settings.chat.autoTitle} onChange={(v) => save({ chat: { autoTitle: v } })} />
        <Toggle label="Show which memories each reply used" hint="Adds a “Recalled…” link under replies so you can see what shaped them." checked={settings.chat.showContextInspector} onChange={(v) => save({ chat: { showContextInspector: v } })} />
        <Row label="Text size" htmlFor="g-size">
          <select id="g-size" className="select" value={settings.chat.textSize} onChange={(e) => save({ chat: { textSize: e.target.value } })}>
            <option value="small">Small</option><option value="medium">Medium</option><option value="large">Large</option>
          </select>
        </Row>
      </div>
      <ReadAloud />
      <Account />
      <div className="group">
        <h3>About</h3>
        <p>Folio {version}. A local app: your characters, chats and memories live on this computer.</p>
        {dataInfo && <p className="hint mono" style={{ marginTop: 6, overflowWrap: 'anywhere' }}>{dataInfo.path}</p>}
      </div>
    </>
  );
}

function ReadAloud() {
  const [prefs, setP] = useState(getPrefs);
  const [voices, setVoices] = useState(listVoices);
  useEffect(() => onVoices(() => setVoices(listVoices())), []);
  useEffect(() => () => stopSpeaking(), []);
  if (!ttsSupported()) {
    return <div className="group"><h3>Read aloud</h3><p className="muted">This browser has no built-in speech, so the read-aloud button is hidden.</p></div>;
  }
  const set = (patch) => { setPrefs(patch); setP((p) => ({ ...p, ...patch })); };
  return (
    <div className="group">
      <h3>Read aloud</h3>
      <p className="hint" style={{ marginBottom: 8 }}>The speaker button under a character's message reads it with a voice built into this device. Nothing is sent anywhere. These choices are saved on this device only.</p>
      <Row label="Voice" htmlFor="tts-voice">
        <select id="tts-voice" className="select" style={{ maxWidth: 280 }} value={prefs.voiceURI} onChange={(e) => set({ voiceURI: e.target.value })}>
          <option value="">Device default</option>
          {voices.map((v) => <option key={v.voiceURI} value={v.voiceURI}>{v.name} ({v.lang})</option>)}
        </select>
      </Row>
      <Row label="Speed" htmlFor="tts-rate">
        <div className="cluster">
          <input id="tts-rate" type="range" min="0.6" max="1.6" step="0.05" value={prefs.rate} onChange={(e) => set({ rate: Number(e.target.value) })} />
          <span className="small muted" style={{ minWidth: 34 }}>{Number(prefs.rate).toFixed(2)}×</span>
        </div>
      </Row>
      <Toggle label="Skip *actions*" hint="Reads only what the character says, not the italic action text between asterisks." checked={prefs.skipActions} onChange={(v) => set({ skipActions: v })} />
      <button className="btn sm" style={{ marginTop: 8 }} onClick={() => speak('This is how I will sound. *smiles* Shall we begin?')}>Play a sample</button>
    </div>
  );
}

function Account() {
  const { auth, signOut } = useApp();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/password', { current: cur, next });
      toast.info('Password changed. Other devices were signed out.');
      setOpen(false);
      setCur('');
      setNext('');
    } catch (err) {
      setError(err);
    }
    setBusy(false);
  }
  return (
    <div className="group">
      <h3>Account</h3>
      <p>Signed in as <strong>{auth?.user}</strong>.</p>
      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <button className="btn sm" onClick={() => setOpen((v) => !v)}>Change password</button>
        <button className="btn sm" onClick={signOut}>Sign out</button>
      </div>
      {open && (
        <form onSubmit={submit} style={{ marginTop: 14, maxWidth: 320, display: 'grid', gap: 10 }}>
          <Field label="Current password" htmlFor="pw-cur"><input id="pw-cur" className="input" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} required /></Field>
          <Field label="New password" htmlFor="pw-new" hint="At least 8 characters."><input id="pw-new" className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required /></Field>
          {error && <ErrorNotice error={error} />}
          <div><button className="btn primary sm" type="submit" disabled={busy || !cur || !next}>Save password</button></div>
        </form>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ portraits */

function PortraitSettings() {
  const toast = useToast();
  const [cfg, setCfg] = useState(null);
  const [f, setF] = useState(null);
  const [key, setKey] = useState('');
  const [err, setErr] = useState(null);
  const [saving, setSaving] = useState(false);
  const [test, setTest] = useState({ busy: false, msg: '', img: null, error: null });
  const ctl = useRef(null);
  useEffect(() => () => ctl.current?.abort(), []);
  useEffect(() => {
    api.get('/images/config').then((c) => { setCfg(c); setF({ provider: c.provider, baseUrl: c.baseUrl, model: c.model, size: c.size, accountId: c.accountId || '', remoteAck: c.remoteAck }); }).catch(setErr);
  }, []);
  if (err) return <ErrorNotice error={err} />;
  if (!cfg || !f) return <p className="muted" role="status">Loading…</p>;
  const info = cfg.providers.find((p) => p.type === f.provider);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const remote = f.provider === 'openai' && hostScope(f.baseUrl || cfg.defaults.openai) === 'remote';

  async function save(extra = {}) {
    setSaving(true);
    setErr(null);
    try {
      const c = await api.put('/images/config', { ...f, ...(key.trim() ? { apiKey: key.trim() } : {}), ...extra });
      setCfg(c);
      setKey('');
      toast.info('Portrait settings saved.');
      return true;
    } catch (e) {
      setErr(e);
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function runTest() {
    if (!(await save())) return;
    setTest({ busy: true, msg: 'Starting…', img: null, error: null });
    ctl.current = new AbortController();
    let img = null;
    let error = null;
    try {
      await stream('/images/portraits', { prompt: 'friendly lighthouse keeper with a grey beard and a yellow raincoat', style: 'illustration', count: 1 }, {
        signal: ctl.current.signal,
        onEvent: (ev, d) => {
          if (ev === 'progress') setTest((t) => ({ ...t, msg: d.message }));
          if (ev === 'image') img = d.dataUrl;
          if (ev === 'error') error = d;
        },
      });
    } catch (e) {
      if (e.code !== 'aborted') error = e;
    }
    setTest({ busy: false, msg: '', img, error });
  }

  return (
    <>
      <h2>Portraits</h2>
      <p className="lead">Which service draws character portraits when you press “Generate portrait” in the character editor.</p>
      <div className="group">
        <Field label="Image service" htmlFor="im-prov">
          <select id="im-prov" className="select" style={{ maxWidth: 360 }} value={f.provider} onChange={(e) => setF((x) => ({ ...x, provider: e.target.value, model: '', size: '', baseUrl: e.target.value === 'openai' ? x.baseUrl : '' }))}>
            {cfg.providers.map((p) => <option key={p.type} value={p.type}>{p.label}</option>)}
          </select>
        </Field>
        <Notice kind="info" title={info.label}>{info.note}</Notice>
        {info.fields.includes('baseUrl') && (
          <Field label="API base URL" htmlFor="im-url" hint="Ends in /v1 for OpenAI-style servers.">
            <input id="im-url" className="input" value={f.baseUrl} onChange={(e) => set('baseUrl', e.target.value)} placeholder={cfg.defaults.openai} />
          </Field>
        )}
        {info.fields.includes('accountId') && (
          <Field label="Account ID" htmlFor="im-acct" hint="Shown on the right side of your Cloudflare dashboard home page.">
            <input id="im-acct" className="input" autoComplete="off" value={f.accountId} onChange={(e) => set('accountId', e.target.value)} />
          </Field>
        )}
        {info.fields.includes('key') && (
          <Field label={`API key${info.needsKey ? '' : ' (optional)'}`} htmlFor="im-key" hint={cfg.hasKey && !key ? `A key ending in ${cfg.keyHint.slice(-4)} is stored encrypted. Leave blank to keep it. ${info.keyHelp}` : info.keyHelp}>
            <div className="cluster">
              <input id="im-key" className="input" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={cfg.hasKey ? '••••••••' : ''} />
              {cfg.hasKey && <button className="btn sm" onClick={() => save({ clearKey: true })}>Remove key</button>}
            </div>
          </Field>
        )}
        {info.fields.includes('model') && (
          <Field label="Model (optional)" htmlFor="im-model" hint="Leave empty to let the service choose.">
            <input id="im-model" className="input" value={f.model} onChange={(e) => set('model', e.target.value)} />
          </Field>
        )}
        {info.fields.includes('size') && (
          <Field label="Image size (optional)" htmlFor="im-size" hint="For example 1024x1024. Empty uses 1024x1024.">
            <input id="im-size" className="input" style={{ maxWidth: 160 }} value={f.size} onChange={(e) => set('size', e.target.value)} placeholder="1024x1024" />
          </Field>
        )}
        {remote && <Toggle label="Send portrait descriptions to this service" hint="This endpoint is on the internet. Only the image description is sent, never your chats." checked={f.remoteAck} onChange={(v) => set('remoteAck', v)} />}
        <ErrorNotice error={err} />
        <div className="cluster wrap" style={{ marginTop: 10 }}>
          <button className="btn primary" onClick={() => save()} disabled={saving || test.busy}>Save</button>
          <button className="btn" onClick={runTest} disabled={saving || test.busy}>{test.busy ? 'Drawing…' : 'Save and make a test image'}</button>
          {test.busy && <button className="btn ghost" onClick={() => ctl.current?.abort()}>Cancel</button>}
        </div>
        {test.busy && <p className="muted" role="status" style={{ marginTop: 8 }}>{test.msg}</p>}
        <ErrorNotice error={test.error} />
        {test.img && <img src={test.img} alt="Test portrait" style={{ width: 160, height: 160, objectFit: 'cover', borderRadius: 12, marginTop: 12 }} />}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ appearance */

function Appearance() {
  const { settings } = useApp();
  const save = useSave();
  const opts = [
    ['system', 'Match system', 'Follows your operating system.', ['#e8ebe6', '#f6f7f3', '#0d1312', '#131a19']],
    ['light', 'Light', 'Cool paper tones with deep green ink.', ['#e8ebe6', '#f6f7f3']],
    ['dark', 'Dark', 'Deep teal-black, tuned separately, not inverted.', ['#0d1312', '#131a19']],
  ];
  return (
    <>
      <h2>Appearance</h2>
      <p className="lead">The theme applies everywhere, including dialogs.</p>
      <div className="theme-pick" role="group" aria-label="Theme">
        {opts.map(([k, label, desc, colors]) => (
          <button key={k} className="theme-opt" aria-pressed={settings.theme === k} onClick={() => save({ theme: k })}>
            <div className="theme-swatch" style={k === 'system' ? { background: `linear-gradient(105deg, ${colors[1]} 50%, ${colors[3]} 50%)` } : { background: colors[1] }}>
              <i className="l" style={{ background: k === 'system' ? 'transparent' : colors[0] }}><b style={{ background: k === 'dark' ? '#5cc4b2' : '#1d6a60', width: '70%' }} /><b style={{ background: k === 'dark' ? '#36443f' : '#b7c0b6', width: '50%' }} /></i>
              <i className="r"><b style={{ background: k === 'dark' ? '#dde6e1' : '#162019', width: '40%', opacity: 0.8 }} /><b style={{ background: k === 'dark' ? '#36443f' : '#b7c0b6', width: '85%' }} /><b style={{ background: k === 'dark' ? '#36443f' : '#b7c0b6', width: '65%' }} /></i>
            </div>
            <div style={{ fontWeight: 620 }}>{label}</div>
            <div className="hint">{desc}</div>
          </button>
        ))}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ providers */

function Providers() {
  const { providers, providerTypes, settings, refreshProviders, refreshCharacters } = useApp();
  const confirm = useConfirm();
  const toast = useToast();
  const save = useSave();
  const [editing, setEditing] = useState(null); // null | 'new' | provider | { preset }
  const [models, setModels] = useState([]);
  const enabled = providers.filter((p) => p.enabled);
  const defId = settings.defaultProviderId && enabled.some((p) => p.id === settings.defaultProviderId) ? settings.defaultProviderId : enabled[0]?.id || '';

  useEffect(() => {
    setModels([]);
    if (!defId) return;
    let alive = true;
    api.get(`/providers/${defId}/models`).then((r) => alive && r.ok && setModels(r.models.map((m) => m.id))).catch(() => {});
    return () => { alive = false; };
  }, [defId]);

  const [defModel, setDefModel] = useState(settings.defaultModel);
  useEffect(() => { setDefModel(settings.defaultModel); }, [settings.defaultModel]);

  const toggle = async (p) => {
    try { await api.patch(`/providers/${p.id}`, { enabled: !p.enabled }); await refreshProviders(); } catch (e) { toast.error(e.message); }
  };
  const remove = async (p) => {
    const ok = await confirm({ title: `Remove ${p.name}?`, message: 'Characters or conversations set to use this provider will fall back to your default. The stored API key is deleted.', confirmLabel: 'Remove provider' });
    if (!ok) return;
    try { await api.del(`/providers/${p.id}`); await Promise.all([refreshProviders(), refreshCharacters()]); } catch (e) { toast.error(e.message); }
  };

  return (
    <>
      <div className="page-head" style={{ marginBottom: 6 }}>
        <div className="grow"><h2>AI providers</h2><p className="lead" style={{ marginBottom: 0 }}>Bring your own model: local or hosted. Keys stay on this computer.</p></div>
        <button className="btn primary" onClick={() => setEditing('new')}><Plus size={16} aria-hidden="true" /> Add provider</button>
      </div>

      {providers.length === 0 ? (
        <div className="group">
          <Notice title="No providers yet">Add one to start chatting. Running Ollama on this computer is the quickest local option.</Notice>
          <div className="cluster wrap" style={{ marginTop: 12 }}>
            <button className="btn" onClick={() => setEditing({ preset: 'ollama' })}>Ollama on this computer</button>
            <button className="btn" onClick={() => setEditing({ preset: 'openai-compatible' })}>LM Studio or other local server</button>
            <button className="btn" onClick={() => setEditing({ preset: 'anthropic' })}>Anthropic</button>
            <button className="btn" onClick={() => setEditing({ preset: 'openai' })}>OpenAI</button>
            <button className="btn" onClick={() => setEditing({ preset: 'gemini' })}>Google Gemini</button>
          </div>
        </div>
      ) : (
        <>
          <div className="group">
            {providers.map((p) => (
              <div className="provider-row" key={p.id}>
                <span className={`dot ${p.enabled ? 'ok' : ''}`} title={p.enabled ? 'Enabled' : 'Disabled'} />
                <div className="grow">
                  <div className="name">{p.name} {p.id === defId && <span className="chip accent" style={{ marginLeft: 6 }}>Default</span>}</div>
                  <div className="hint" style={{ overflowWrap: 'anywhere' }}>
                    {providerTypes.find((t) => t.type === p.type)?.label} · {p.baseUrl} · {p.defaultModel || 'no model chosen'}
                    {p.scope !== 'local' && <> · <b>{p.scope === 'lan' ? 'your network' : 'internet'}</b></>}
                  </div>
                </div>
                <label className="toggle" title={p.enabled ? 'Disable' : 'Enable'}><input type="checkbox" role="switch" aria-label={`${p.name} enabled`} checked={p.enabled} onChange={() => toggle(p)} /><span /></label>
                <button className="btn ghost icon sm" aria-label={`Edit ${p.name}`} onClick={() => setEditing(p)}><Pencil size={15} /></button>
                <button className="btn ghost icon sm" aria-label={`Remove ${p.name}`} onClick={() => remove(p)}><Trash2 size={15} /></button>
              </div>
            ))}
          </div>

          <div className="group">
            <h3>Default model</h3>
            <p className="hint" style={{ marginBottom: 10 }}>Used when a character or conversation does not choose its own.</p>
            <div className="fields two">
              <Field label="Provider" htmlFor="d-prov">
                <select id="d-prov" className="select" value={defId} onChange={(e) => save({ defaultProviderId: e.target.value || null, defaultModel: '' })}>
                  {enabled.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </Field>
              <Field label="Model" htmlFor="d-model" hint="Leave empty to use the provider's own default model.">
                <input id="d-model" className="input" list="d-models" value={defModel} onChange={(e) => setDefModel(e.target.value)} onBlur={() => defModel !== settings.defaultModel && save({ defaultModel: defModel.trim() })} placeholder={providers.find((p) => p.id === defId)?.defaultModel || 'Model name'} />
                <datalist id="d-models">{models.map((m) => <option key={m} value={m} />)}</datalist>
              </Field>
            </div>
          </div>
        </>
      )}

      {editing && (
        <ProviderForm
          provider={editing === 'new' || editing.preset ? null : editing}
          preset={editing.preset}
          types={providerTypes}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await refreshProviders(); }}
        />
      )}
    </>
  );
}

const numOrNull = (s) => (s === '' || s == null ? null : Number(s));

function ProviderForm({ provider, preset, types, onClose, onSaved }) {
  const isNew = !provider;
  const toast = useToast();
  const [type, setType] = useState(provider?.type || preset || 'ollama');
  const T = types.find((t) => t.type === type);
  const [f, setF] = useState(() => ({
    name: provider?.name || '',
    baseUrl: provider?.baseUrl || types.find((t) => t.type === (preset || 'ollama')).defaultBaseUrl,
    apiKey: '',
    defaultModel: provider?.defaultModel || '',
    contextLength: provider?.contextLength ?? '',
    temperature: provider?.temperature ?? '',
    topP: provider?.topP ?? '',
    topK: provider?.topK ?? '',
    maxTokens: provider?.maxTokens ?? '',
    timeoutSec: Math.round((provider?.timeoutMs || 120000) / 1000),
    remoteAck: provider?.remoteAck || false,
  }));
  const [headers, setHeaders] = useState(() => (provider?.headerNames || []).map((n) => ({ name: n, value: '', kept: true })));
  const [clearKey, setClearKey] = useState(false);
  const [test, setTest] = useState(null);
  const [testing, setTesting] = useState(false);
  const [models, setModels] = useState([]);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const scope = hostScope(f.baseUrl);
  const sup = T.supports;

  const changeType = (t) => {
    const next = types.find((x) => x.type === t);
    setType(t);
    setF((x) => ({ ...x, baseUrl: next.defaultBaseUrl, defaultModel: '', contextLength: '' }));
    setTest(null);
    setModels([]);
  };

  const headerObj = () => Object.fromEntries(headers.filter((h) => h.name.trim()).map((h) => [h.name.trim(), h.value]));
  const draft = () => ({
    id: provider?.id, type, baseUrl: f.baseUrl, apiKey: f.apiKey || undefined,
    headers: headerObj(), model: f.defaultModel, timeoutMs: Math.min(Number(f.timeoutSec) || 30, 60) * 1000,
  });

  async function runTest() {
    setTesting(true);
    setTest(null);
    try {
      const r = await api.post('/providers/test', draft());
      setTest(r);
      if (r.ok && r.models?.length) setModels(r.models.map((m) => m.id));
    } catch (e) {
      setTest({ ok: false, message: e.message, hint: e.hint });
    } finally {
      setTesting(false);
    }
  }

  async function discover() {
    try {
      const r = await api.post('/providers/models', draft());
      if (r.ok) { setModels(r.models.map((m) => m.id)); setTest({ ok: true, message: `Found ${r.models.length} model${r.models.length === 1 ? '' : 's'}. Pick one below or type a name.` }); }
      else setTest({ ok: false, message: r.message, hint: r.hint });
    } catch (e) { setTest({ ok: false, message: e.message, hint: e.hint }); }
  }

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const body = {
      name: f.name.trim() || T.label,
      baseUrl: f.baseUrl,
      defaultModel: f.defaultModel.trim(),
      contextLength: numOrNull(f.contextLength),
      temperature: sup.temperature ? numOrNull(f.temperature) : null,
      topP: sup.topP ? numOrNull(f.topP) : null,
      topK: sup.topK ? numOrNull(f.topK) : null,
      maxTokens: sup.maxTokens ? numOrNull(f.maxTokens) : null,
      timeoutMs: Math.max(5, Number(f.timeoutSec) || 120) * 1000,
      headers: headerObj(),
      remoteAck: scope === 'remote' ? f.remoteAck : false,
    };
    if (f.apiKey) body.apiKey = f.apiKey;
    if (clearKey) body.clearApiKey = true;
    try {
      const r = isNew ? await api.post('/providers', { ...body, type }) : await api.patch(`/providers/${provider.id}`, body);
      r.warnings?.forEach((w) => toast.info(w, { ms: 7000 }));
      await onSaved();
    } catch (err) {
      setError(err);
      setSaving(false);
    }
  }

  const needsKey = sup.apiKey === 'required';
  const ignored = [!sup.temperature && 'temperature', !sup.topP && 'top-p', !sup.topK && 'top-k', !sup.maxTokens && 'max output tokens'].filter(Boolean);

  return (
    <Dialog wide title={isNew ? 'Add provider' : `Edit ${provider.name}`} onClose={onClose}
      footer={<><button className="btn" type="button" onClick={onClose}>Cancel</button><button className="btn primary" form="prov-form" type="submit" disabled={saving || (scope === 'remote' && !f.remoteAck)}>{saving ? 'Saving…' : 'Save provider'}</button></>}>
      <form id="prov-form" onSubmit={submit} className="stack" style={{ gap: 16 }}>
        <ErrorNotice error={error} />
        <div className="fields two">
          <Field label="Type" htmlFor="p-type">
            <select id="p-type" className="select" value={type} disabled={!isNew} onChange={(e) => changeType(e.target.value)}>
              {types.map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}
            </select>
          </Field>
          <Field label="Name" htmlFor="p-name"><input id="p-name" className="input" value={f.name} onChange={(e) => set('name', e.target.value)} placeholder={T.label} maxLength={60} data-autofocus /></Field>
        </div>
        <p className="hint">{T.help}</p>

        <Field label="API base URL" htmlFor="p-url" hint={type === 'ollama' ? 'Where Ollama is listening. Local default: http://127.0.0.1:11434' : undefined}>
          <input id="p-url" className="input mono" value={f.baseUrl} onChange={(e) => { set('baseUrl', e.target.value); setTest(null); }} spellCheck="false" autoComplete="off" />
        </Field>
        {scope === 'remote' && (
          <Notice kind="warn" title="This endpoint is on the internet">
            <label className="check" style={{ marginTop: 6 }}>
              <input type="checkbox" checked={f.remoteAck} onChange={(e) => set('remoteAck', e.target.checked)} />
              <span>I understand that my messages, and any memories and past conversation excerpts the character recalls, are sent to this service with every request.</span>
            </label>
          </Notice>
        )}
        {scope === 'lan' && <Notice title="This endpoint is on your network">Make sure you trust that machine and network. Plain http:// traffic can be read by others on the same network.</Notice>}
        {scope === 'local' && type === 'ollama' && <p className="hint">127.0.0.1 means the computer running Folio. To use Ollama on another machine, enter that machine's address and start Ollama there with OLLAMA_HOST=0.0.0.0.</p>}

        <Field label={`API key${sup.apiKey === 'optional' ? ' (optional)' : ''}`} htmlFor="p-key" hint={provider?.hasKey && !clearKey ? `A key ending in ${provider.keyHint.slice(-4)} is stored encrypted. Leave blank to keep it.` : sup.apiKey === 'optional' ? 'Only needed for hosted endpoints or gateways that require one.' : 'Stored encrypted on this computer and never shown again.'}>
          <div className="cluster">
            <input id="p-key" className="input mono" type="password" value={f.apiKey} onChange={(e) => { set('apiKey', e.target.value); setClearKey(false); setTest(null); }} autoComplete="new-password" placeholder={provider?.hasKey && !clearKey ? '••••••••' : needsKey ? 'Required' : ''} spellCheck="false" />
            {provider?.hasKey && <button type="button" className="btn sm" onClick={() => { setClearKey(!clearKey); set('apiKey', ''); }} aria-pressed={clearKey}>{clearKey ? 'Will remove' : 'Remove key'}</button>}
          </div>
        </Field>

        <div className="field">
          <span className="label">Custom headers (optional)</span>
          {headers.map((h, i) => (
            <div className="kv" key={i}>
              <input className="input sm" aria-label="Header name" placeholder="Header name" value={h.name} onChange={(e) => setHeaders(headers.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} readOnly={h.kept} />
              <input className="input sm" type="password" aria-label={`Value for ${h.name || 'header'}`} placeholder={h.kept ? 'Stored. Leave blank to keep.' : 'Value'} value={h.value} onChange={(e) => setHeaders(headers.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} autoComplete="off" />
              <button type="button" className="btn ghost icon sm" aria-label="Remove header" onClick={() => setHeaders(headers.filter((_, j) => j !== i))}><Trash2 size={14} /></button>
            </div>
          ))}
          <div><button type="button" className="btn sm" onClick={() => setHeaders([...headers, { name: '', value: '' }])}><Plus size={14} aria-hidden="true" /> Add header</button></div>
          <span className="hint">Values are stored encrypted. Headers that Folio manages itself, such as Content-Type and Authorization from the key above, cannot be overridden.</span>
        </div>

        <div className="stack" style={{ gap: 8 }}>
          <div className="fields two">
            <Field label="Model" htmlFor="p-model" hint="Choose a discovered model, or type a name.">
              <input id="p-model" className="input" list="p-models" value={f.defaultModel} onChange={(e) => set('defaultModel', e.target.value)} placeholder="e.g. llama3.1:8b" spellCheck="false" />
              <datalist id="p-models">{models.map((m) => <option key={m} value={m} />)}</datalist>
            </Field>
            <div className="field">
              <span className="label">Connection</span>
              <div className="cluster">
                <button type="button" className="btn" onClick={runTest} disabled={testing}><Zap size={15} aria-hidden="true" /> {testing ? 'Testing…' : 'Test connection'}</button>
                <button type="button" className="btn" onClick={discover} disabled={testing}>Find models</button>
              </div>
            </div>
          </div>
          {test && (
            <div role="status">
              <Notice kind={test.ok ? 'ok' : 'danger'} title={test.message}>{test.hint}{test.ok && test.latencyMs != null ? ` Responded in ${test.latencyMs} ms.` : ''}</Notice>
            </div>
          )}
          {models.length > 0 && (
            <div className="models" aria-label="Discovered models">
              {models.slice(0, 80).map((m) => <button type="button" key={m} className="chip" aria-pressed={f.defaultModel === m} onClick={() => set('defaultModel', m)}>{m}</button>)}
            </div>
          )}
        </div>

        <div className="fields two">
          <Field label="Context length (tokens)" htmlFor="p-ctx" hint={sup.contextLength ? `Sent to the server as num_ctx. Default if empty: ${T.defaultContext.toLocaleString('en-US')}.` : `Folio uses this to size each prompt. Not sent to the provider. Default if empty: ${T.defaultContext.toLocaleString('en-US')}.`}>
            <input id="p-ctx" className="input" type="number" min={512} step={512} value={f.contextLength} onChange={(e) => set('contextLength', e.target.value)} placeholder={String(T.defaultContext)} />
          </Field>
          <Field label="Request timeout (seconds)" htmlFor="p-to" hint="How long to wait for a response before giving up. Raise it for large local models.">
            <input id="p-to" className="input" type="number" min={5} max={1800} value={f.timeoutSec} onChange={(e) => set('timeoutSec', e.target.value)} />
          </Field>
          {sup.temperature && <Field label="Temperature" htmlFor="p-temp" hint="0 to 2. Empty uses the model's default."><input id="p-temp" className="input" type="number" min={0} max={2} step={0.05} value={f.temperature} onChange={(e) => set('temperature', e.target.value)} placeholder="Default" /></Field>}
          {sup.topP && <Field label="Top-p" htmlFor="p-topp" hint="0 to 1."><input id="p-topp" className="input" type="number" min={0} max={1} step={0.05} value={f.topP} onChange={(e) => set('topP', e.target.value)} placeholder="Default" /></Field>}
          {sup.topK && <Field label="Top-k" htmlFor="p-topk"><input id="p-topk" className="input" type="number" min={1} step={1} value={f.topK} onChange={(e) => set('topK', e.target.value)} placeholder="Default" /></Field>}
          {sup.maxTokens && <Field label="Max output tokens" htmlFor="p-max" hint={type === 'anthropic' ? 'Required by this API. Defaults to 2048 if empty.' : 'Empty lets the model decide.'}><input id="p-max" className="input" type="number" min={16} step={16} value={f.maxTokens} onChange={(e) => set('maxTokens', e.target.value)} placeholder="Default" /></Field>}
        </div>
        {ignored.length > 0 && <p className="hint">{T.label} does not use {ignored.join(', ')} in Folio, so those settings are not shown.</p>}
        {type === 'openai' && <p className="hint">OpenAI reasoning models ignore temperature and top-p. Folio leaves them out for those models.</p>}
        {type === 'anthropic' && <p className="hint">If both temperature and top-p are set, only temperature is sent.</p>}
      </form>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ memory */

function MemorySettings() {
  const { settings, providers } = useApp();
  const save = useSave();
  const m = settings.memory;
  const remote = providers.filter((p) => p.enabled && p.scope !== 'local');
  const patch = (p) => save({ memory: p });
  return (
    <>
      <h2>Memory</h2>
      <p className="lead">How characters learn from conversations and what they recall.</p>
      <div className="group">
        <Toggle label="Long-term memory" hint="Characters keep what they learn across conversations. Turn off to make every chat start fresh. Saved memories are kept, just not used." checked={m.enabled} onChange={(v) => patch({ enabled: v })} />
        <Row label="Learning from chats" htmlFor="m-ex" hint="Model: your chat model reads the transcript and files memories (best quality, uses extra requests). Simple: pattern matching on your own words, no extra requests, catches less. Off: only memories you add yourself.">
          <select id="m-ex" className="select" value={m.extraction} disabled={!m.enabled} onChange={(e) => patch({ extraction: e.target.value })}>
            <option value="model">Model-based</option><option value="heuristic">Simple, no extra requests</option><option value="off">Off</option>
          </select>
        </Row>
        <Toggle label="Ask before saving" hint="New automatically learned memories wait for your approval and are not used until you approve them." checked={m.requireApproval} disabled={!m.enabled || m.extraction === 'off'} onChange={(v) => patch({ requireApproval: v })} />
        <Row label="Learn after every" htmlFor="m-every" hint="Number of your messages between automatic scans. Scans also run when you start a new conversation."><Num id="m-every" value={m.extractEveryUserMessages} min={1} max={20} onCommit={(v) => patch({ extractEveryUserMessages: v })} suffix="messages" width={80} /></Row>
      </div>
      <div className="group">
        <h3>Recall</h3>
        <Row label="Memories per reply" htmlFor="m-lim" hint="The most useful saved memories included in each request. Pinned memories are always eligible."><Num id="m-lim" value={m.retrievalLimit} min={1} max={50} onCommit={(v) => patch({ retrievalLimit: v })} width={80} /></Row>
        <Toggle label="Quote relevant past conversations" hint="Adds short excerpts from earlier chats when they match what you are discussing." checked={m.includeExcerpts} onChange={(v) => patch({ includeExcerpts: v })} />
        <Toggle label="Remind of recent conversations" hint="Adds a short, dated digest of the last few chats with this character." checked={m.includeDigest} onChange={(v) => patch({ includeDigest: v })} />
        <Row label="Memory share of the prompt" htmlFor="m-pct" hint="Upper limit for recalled memories as a share of the context window. Lower it for small models."><Num id="m-pct" value={m.budgetPct} min={5} max={50} onCommit={(v) => patch({ budgetPct: v })} suffix="%" width={80} /></Row>
        <Row label="Largest prompt to send" htmlFor="m-max" hint="Caps the prompt even when a provider allows more. Lower this to save cost or speed on large-context models."><Num id="m-max" value={m.maxPromptTokens} min={1024} max={200000} step={512} onCommit={(v) => patch({ maxPromptTokens: v })} suffix="tokens" width={110} /></Row>
        <Row label="Summarize after" htmlFor="m-sum" hint="Older parts of long conversations are summarized once a chat grows past this many messages. The full messages are always kept."><Num id="m-sum" value={m.summarizeAfterMessages} min={8} max={200} onCommit={(v) => patch({ summarizeAfterMessages: v })} suffix="messages" width={80} /></Row>
      </div>
      <div className="group">
        <h3>What leaves this computer</h3>
        {remote.length === 0 ? (
          <p>Your enabled providers all run on this computer, so memories are never sent anywhere.</p>
        ) : (
          <Notice kind="warn" title="Memories are included in requests to these providers">
            {remote.map((p) => p.name).join(', ')}. Recalled memories, past conversation excerpts and your name are part of the prompt, so the provider receives them. Use a local model for characters whose memories are private, or turn memory off per character.
          </Notice>
        )}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ data */

function SyncInfo() {
  const [info, setInfo] = useState(null);
  const toast = useToast();
  useEffect(() => { api.get('/sync/identity').then(setInfo).catch(() => {}); }, []);
  if (!info) return null;
  const copy = async (t) => { try { await navigator.clipboard.writeText(t); toast.info('Copied.'); } catch { toast.error('Copy failed.'); } };
  const id = (label, v) => (
    <div className="switch">
      <div className="grow"><div style={{ fontWeight: 600 }}>{label}</div><div className="mono small" style={{ overflowWrap: 'anywhere' }}>{v}</div></div>
      <button className="btn sm" onClick={() => copy(v)}>Copy</button>
    </div>
  );
  return (
    <div className="group">
      <h3>Server and database IDs</h3>
      <p className="hint" style={{ marginBottom: 6 }}>Anyone who knows this ID and has been paired can reach this server, with no URL or port forwarding. Sync covers every account on the server and is run from the command line: <span className="mono">npm run pair</span> here, <span className="mono">npm run link -- &lt;server id&gt; &lt;code&gt;</span> on the other machine, then <span className="mono">npm run sync -- &lt;server id&gt;</span>. See the README.</p>
      {id(`Server “${info.name}”`, info.serverId)}
      {id('This database', info.databaseId)}
      {info.peers.length > 0 && (
        <>
          <h4 style={{ margin: '12px 0 4px' }}>Synced with</h4>
          {info.peers.map((p) => (
            <p key={p.peer_database_id} className="small">{p.peer_server_name || p.peer_server_id} · <span className="mono">{p.peer_server_id}</span> · {p.last_action} on {new Date(p.last_sync_at).toLocaleString()}</p>
          ))}
        </>
      )}
    </div>
  );
}

function DataSettings() {
  const { dataInfo, providers, refreshData, reload } = useApp();
  const confirm = useConfirm();
  const toast = useToast();
  const fileRef = useRef(null);
  useEffect(() => { refreshData(); }, [refreshData]);
  const remote = providers.filter((p) => p.enabled && p.scope !== 'local');
  const c = dataInfo?.counts || {};

  const restore = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const payload = await uploadJson(file);
      const n = payload?.tables?.characters?.length ?? 0;
      const ok = await confirm({
        title: 'Restore from backup?',
        message: <>This replaces <b>everything</b> in Folio with the backup ({n} character{n === 1 ? '' : 's'}, {payload?.tables?.messages?.length ?? 0} messages). Current characters, chats and memories are deleted. API keys are not in backups, so re-enter any you need.</>,
        confirmLabel: 'Replace everything',
        require: 'RESTORE',
      });
      if (!ok) return;
      const r = await api.post('/data/import', payload);
      await reload();
      toast.info(r.providersNeedingKeys?.length ? `Restored. Add API keys again for: ${r.providersNeedingKeys.join(', ')}.` : 'Backup restored.', { ms: 7000 });
    } catch (err) {
      toast.error(err.message);
    }
  };

  const wipe = async (scope) => {
    const everything = scope === 'everything';
    const ok = await confirm({
      title: everything ? 'Reset Folio completely?' : 'Delete all characters and chats?',
      message: everything
        ? 'Deletes every character, conversation, memory, provider (including API keys) and setting. This cannot be undone.'
        : `Deletes ${c.characters || 0} character${c.characters === 1 ? '' : 's'}, ${c.conversations || 0} conversation${c.conversations === 1 ? '' : 's'} and ${c.memories || 0} memor${c.memories === 1 ? 'y' : 'ies'}. Providers and settings are kept. This cannot be undone.`,
      confirmLabel: everything ? 'Reset everything' : 'Delete everything',
      require: 'DELETE',
    });
    if (!ok) return;
    try {
      await api.post('/data/wipe', { confirm: 'DELETE', scope });
      await reload();
      toast.info(everything ? 'Folio was reset.' : 'All characters and chats were deleted.');
    } catch (e) { toast.error(e.message); }
  };

  return (
    <>
      <h2>Data and privacy</h2>
      <p className="lead">Where your data lives, what is shared, and how to take it with you.</p>
      <div className="group">
        <h3>Where it is stored</h3>
        <p>Everything is saved in your own database file on the computer running Folio. It only leaves that computer when you ask: to your model provider with each message, to the image service for portraits, or when you sync with another Folio server yourself.</p>
        {dataInfo && (
          <>
            <p className="hint mono" style={{ margin: '8px 0', overflowWrap: 'anywhere' }}>{dataInfo.path}</p>
            <div className="stat-grid">
              <div className="stat"><b>{c.characters ?? 0}</b><span>characters</span></div>
              <div className="stat"><b>{c.conversations ?? 0}</b><span>conversations</span></div>
              <div className="stat"><b>{c.messages ?? 0}</b><span>messages</span></div>
              <div className="stat"><b>{c.memories ?? 0}</b><span>memories</span></div>
              <div className="stat"><b>{bytes(dataInfo.sizeBytes)}</b><span>on disk</span></div>
            </div>
      <SyncInfo />
          </>
        )}
      </div>
      <div className="group">
        <h3>What is sent to other services</h3>
        {remote.length === 0 ? <p>Nothing. Every enabled provider runs on this computer.</p> : (
          <Notice kind="warn" title="Chats go to the providers you connected">
            With {remote.map((p) => p.name).join(', ')}, each message, the character's description, recalled memories and the earlier excerpts used for that reply are sent to the provider. Folio sends nothing anywhere else.
          </Notice>
        )}
        <p className="hint" style={{ marginTop: 8 }}>API keys and custom header values are encrypted in the database with a key stored in the data folder (or in FOLIO_SECRET_KEY). They are never sent to the browser, and they are left out of exports and backups.</p>
      </div>
      <div className="group">
        <h3>Back up and restore</h3>
        <div className="cluster wrap">
          <button className="btn" onClick={() => download('/data/export')}><Download size={15} aria-hidden="true" /> Export everything</button>
          <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={restore} />
          <button className="btn" onClick={() => fileRef.current.click()}><Upload size={15} aria-hidden="true" /> Restore from backup</button>
        </div>
        <p className="hint" style={{ marginTop: 8 }}>The backup is a JSON file with all characters, conversations, memories and settings. It contains your private conversations, so store it carefully. You can also export a single character or its memories from My characters.</p>
      </div>
      <div className="group">
        <h3>Delete data</h3>
        <div className="cluster wrap">
          <button className="btn danger" onClick={() => wipe('content')}>Delete all characters and chats</button>
          <button className="btn danger" onClick={() => wipe('everything')}>Reset Folio completely</button>
        </div>
      </div>
    </>
  );
}
