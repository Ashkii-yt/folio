import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ImagePlus, MessageCircle, Send, Sparkles, WandSparkles, Square, Trash2 } from 'lucide-react';
import { useApp } from '../store.jsx';
import { api, stream } from '../api.js';
import { Avatar, ErrorNotice, Field, Notice, Spinner, Styled, Toggle, useConfirm, useToast } from '../ui.jsx';
import { imageToAvatar } from '../lib.js';
import PortraitDialog from '../components/PortraitDialog.jsx';

const BLANK = {
  name: '', description: '', tags: [], avatar: null,
  personality: '', background: '', speakingStyle: '', goals: '', exampleDialogue: '', greeting: '',
  systemPromptAddition: '',
  providerId: null, model: '', memoryEnabled: true, autoExtract: null,
};
const FIELDS = Object.keys(BLANK);
const pick = (c) => Object.fromEntries(FIELDS.map((k) => [k, c[k] ?? BLANK[k]]));
const AI_FIELDS = ['name', 'description', 'tags', 'personality', 'background', 'speakingStyle', 'goals', 'greeting', 'exampleDialogue', 'systemPromptAddition'];
const AI_LABEL = { name: 'name', description: 'description', tags: 'tags', personality: 'personality', background: 'background', speakingStyle: 'speaking style', goals: 'goals', greeting: 'greeting', exampleDialogue: 'example dialogue', systemPromptAddition: 'system prompt addition' };
const draftKey = (id) => `folio.draft.${id || 'new'}`;

export default function Editor() {
  const { id } = useParams();
  const isNew = !id;
  const nav = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const { providers, refreshCharacters } = useApp();

  const [initial, setInitial] = useState(null); // last saved values
  const [f, setF] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [errors, setErrors] = useState({});
  const [saveError, setSaveError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [restored, setRestored] = useState(false);
  const [tagText, setTagText] = useState('');
  const [side, setSide] = useState('card');
  const [portraitOpen, setPortraitOpen] = useState(false);
  const closePortrait = useCallback(() => setPortraitOpen(false), []);
  const [ai, setAi] = useState({ idea: '', providerId: '', model: '', busy: null, error: null });
  const aiCtl = useRef(null);
  useEffect(() => () => aiCtl.current?.abort(), []);
  const nameRef = useRef(null);
  const fileRef = useRef(null);

  /* ---- load ---- */
  useEffect(() => {
    let alive = true;
    setF(null);
    setLoadError(null);
    setRestored(false);
    (async () => {
      try {
        const base = isNew ? { ...BLANK } : pick(await api.get(`/characters/${id}`));
        if (!alive) return;
        setInitial(base);
        let draft = null;
        try {
          draft = JSON.parse(sessionStorage.getItem(draftKey(id)) || 'null');
        } catch {
          /* no draft */
        }
        if (draft && JSON.stringify(draft) !== JSON.stringify(base)) {
          setF({ ...base, ...draft });
          setRestored(true);
        } else setF(base);
        setTagText((draft?.tags || base.tags).join(', '));
      } catch (e) {
        if (alive) setLoadError(e);
      }
    })();
    return () => { alive = false; };
  }, [id, isNew]);

  const dirty = useMemo(() => !!f && !!initial && JSON.stringify(f) !== JSON.stringify(initial), [f, initial]);

  /* ---- keep unsaved work: warn on tab close, and stash a draft for in-app navigation ---- */
  useEffect(() => {
    if (!dirty) return;
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  useEffect(() => {
    if (!f || !initial) return;
    try {
      if (dirty) sessionStorage.setItem(draftKey(id), JSON.stringify(f));
      else sessionStorage.removeItem(draftKey(id));
    } catch {
      /* storage unavailable: the beforeunload warning still applies */
    }
  }, [f, dirty, id, initial]);

  const set = (k, v) => {
    setF((x) => ({ ...x, [k]: v }));
    if (errors[k]) setErrors((e) => ({ ...e, [k]: undefined }));
  };

  const isEmpty = (k) => (k === 'tags' ? !f.tags.length : !String(f[k] ?? '').trim());

  /** Ask the model to write some fields. Everything it writes can be undone from the toast. */
  const generate = async (fields, { fromField = false } = {}) => {
    if (ai.busy) return;
    const before = f;
    aiCtl.current = new AbortController();
    setAi((a) => ({ ...a, busy: fields.length === 1 ? fields[0] : 'all', error: null }));
    try {
      const { fields: got } = await api.post('/characters/generate', {
        idea: ai.idea, fields, current: pick(f), providerId: ai.providerId || undefined, model: ai.model || undefined,
      }, { signal: aiCtl.current.signal });
      const keys = Object.keys(got);
      setF((x) => ({ ...x, ...got }));
      if (got.tags) setTagText(got.tags.join(', '));
      setErrors((e) => ({ ...e, ...(got.name ? { name: undefined } : {}) }));
      toast.info(keys.length === 1 ? `Drafted the ${AI_LABEL[keys[0]]}.` : `Drafted ${keys.length} parts. Read it over and make it yours.`, {
        ms: 12000,
        action: { label: 'Undo', run: () => { setF((x) => ({ ...x, ...Object.fromEntries(keys.map((k) => [k, before[k]])) })); if (got.tags) setTagText(before.tags.join(', ')); } },
      });
    } catch (e) {
      if (e.code !== 'aborted') {
        setAi((a) => ({ ...a, error: e }));
        if (fromField) toast.error(e.message);
      }
    } finally {
      setAi((a) => ({ ...a, busy: null }));
    }
  };

  const writeAll = async () => {
    if (AI_FIELDS.some((k) => !isEmpty(k))) {
      const ok = await confirm({ title: 'Replace what you have written?', message: 'The model will write every part again from your idea. You can undo it right after.', confirmLabel: 'Write it again', cancelLabel: 'Cancel', danger: false });
      if (!ok) return;
    }
    generate(AI_FIELDS);
  };

  const aiBtn = (k) => (
    <button type="button" className="btn sm ghost ai-btn" onClick={() => generate([k], { fromField: true })} disabled={!!ai.busy} aria-label={`${isEmpty(k) ? 'Draft' : 'Rewrite'} the ${AI_LABEL[k]} with AI`}>
      {ai.busy === k ? <span className="spin" aria-hidden="true" /> : <Sparkles size={13} aria-hidden="true" />} {ai.busy === k ? 'Writing…' : isEmpty(k) ? 'Draft with AI' : 'Rewrite'}
    </button>
  );

  const commitTags = (text) => {
    const tags = [...new Set(text.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 12);
    set('tags', tags);
  };

  /* ---- save ---- */
  const validate = () => {
    const e = {};
    if (!f.name.trim()) e.name = 'Give your character a name.';
    if (f.name.length > 80) e.name = 'Names can be at most 80 characters.';
    if (f.description.length > 600) e.description = 'Keep the short description under 600 characters.';
    setErrors(e);
    if (e.name) nameRef.current?.focus();
    return !Object.keys(e).length;
  };

  const save = useCallback(async () => {
    if (!validate()) return null;
    setSaving(true);
    setSaveError(null);
    try {
      let saved;
      if (isNew) saved = await api.post('/characters', { ...f, name: f.name.trim() });
      else {
        // Send only what changed, so editing one field can never overwrite another (such as the custom prompt).
        const patch = {};
        for (const k of FIELDS) if (JSON.stringify(f[k]) !== JSON.stringify(initial[k])) patch[k] = k === 'name' ? f.name.trim() : f[k];
        saved = Object.keys(patch).length ? await api.patch(`/characters/${id}`, patch) : await api.get(`/characters/${id}`);
      }
      try { sessionStorage.removeItem(draftKey(id)); } catch { /* ignore */ }
      const next = pick(saved);
      setInitial(next);
      setF(next);
      setRestored(false);
      await refreshCharacters();
      toast.info(isNew ? `Created ${saved.name}.` : 'Saved.');
      if (isNew) nav(`/characters/${saved.id}/edit`, { replace: true });
      return saved;
    } catch (e) {
      setSaveError(e);
      return null;
    } finally {
      setSaving(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f, initial, id, isNew]);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (!saving) save(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save, saving]);

  const leave = async () => {
    if (dirty) {
      const ok = await confirm({ title: 'Discard unsaved changes?', message: 'Your edits to this character have not been saved.', confirmLabel: 'Discard changes', cancelLabel: 'Keep editing' });
      if (!ok) return;
      try { sessionStorage.removeItem(draftKey(id)); } catch { /* ignore */ }
    }
    nav(isNew ? '/mine' : '/mine');
  };

  const discardDraft = () => {
    setF(initial);
    setTagText(initial.tags.join(', '));
    setRestored(false);
  };

  const chatNow = async () => {
    const saved = dirty || isNew ? await save() : { id };
    if (saved) nav(`/chat/${saved.id}`);
  };

  const pickImage = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      set('avatar', await imageToAvatar(file));
    } catch (err) {
      toast.error(err.message);
    }
  };

  if (loadError) return <div className="page-inner"><ErrorNotice error={loadError} action={<Link className="btn sm" to="/mine">Back</Link>} /></div>;
  if (!f) return <Spinner />;

  const previewChar = { ...f, id: id || 'draft', hasAvatar: !!f.avatar, avatarVersion: f.avatar ? 'draft' : '' };

  return (
    <div className="stack" style={{ height: '100%', minHeight: 0 }}>
      <div className="topbar">
        <button className="btn ghost icon" onClick={leave} aria-label="Back to my characters"><ArrowLeft size={18} /></button>
        <h1 className="grow clamp-1">{isNew ? 'New character' : f.name || 'Untitled character'}</h1>
        {dirty && <span className="chip warn" role="status">Unsaved changes</span>}
        <button className="btn" onClick={chatNow} disabled={saving}><MessageCircle size={16} aria-hidden="true" /> <span className="hide-sm">{isNew || dirty ? 'Save and chat' : 'Chat'}</span><span className="only-sm">Chat</span></button>
        <button className="btn primary" onClick={save} disabled={saving || (!dirty && !isNew)}>{saving ? 'Saving…' : isNew ? <><span className="hide-sm">Create character</span><span className="only-sm">Create</span></> : <><span className="hide-sm">Save changes</span><span className="only-sm">Save</span></>}</button>
      </div>

      <div className="editor grow">
        <div className="editor-form">
          <div className="page-inner">
            {restored && (
              <div style={{ marginBottom: 18 }}>
                <Notice kind="warn" title="Restored your unsaved edits" action={<button className="btn sm" onClick={discardDraft}>Discard them</button>}>
                  You left this page without saving. They are back, but not stored until you save.
                </Notice>
              </div>
            )}
            <ErrorNotice error={saveError} />

            <AiPanel ai={ai} setAi={setAi} providers={providers} isNew={isNew} empties={AI_FIELDS.filter(isEmpty)} hasDraft={AI_FIELDS.some((k) => !isEmpty(k))} onAll={writeAll} onEmpty={() => generate(AI_FIELDS.filter(isEmpty))} onCancel={() => aiCtl.current?.abort()} />

            <section className="form-section" aria-labelledby="s-id">
              <h2 id="s-id">Identity</h2>
              <p className="lead">Who they are at a glance.</p>
              <div className="fields">
                <div className="avatar-edit">
                  <Avatar character={previewChar} size={80} />
                  <div className="stack" style={{ gap: 6 }}>
                    <div className="cluster">
                      <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={pickImage} />
                      <button className="btn sm" onClick={() => fileRef.current.click()}><ImagePlus size={14} aria-hidden="true" /> {f.avatar ? 'Change portrait' : 'Add portrait'}</button>
                      <button className="btn sm" onClick={() => setPortraitOpen(true)}><WandSparkles size={14} aria-hidden="true" /> Generate portrait</button>
                      {f.avatar && <button className="btn sm ghost" onClick={() => set('avatar', null)}><Trash2 size={14} aria-hidden="true" /> Remove</button>}
                    </div>
                    <span className="hint">Optional. Upload one or generate it. Cropped to a square and stored in your database.</span>
                  </div>
                </div>
                <Field label="Name" htmlFor="c-name" action={aiBtn('name')} error={errors.name}>
                  <input id="c-name" ref={nameRef} className="input" value={f.name} maxLength={90} aria-invalid={!!errors.name} onChange={(e) => set('name', e.target.value)} placeholder="Wren Halloway" autoComplete="off" />
                </Field>
                <Field label="Short description" htmlFor="c-desc" action={aiBtn('description')} error={errors.description} hint="One or two lines, shown in the library.">
                  <input id="c-desc" className="input" value={f.description} onChange={(e) => set('description', e.target.value)} placeholder="Navigator of a salvage tug. Dry humor, steady hands." />
                </Field>
                <Field label="Tags" htmlFor="c-tags" action={aiBtn('tags')} hint="Comma-separated. Used to filter the library.">
                  <input id="c-tags" className="input" value={tagText} onChange={(e) => { setTagText(e.target.value); commitTags(e.target.value); }} onBlur={() => setTagText(f.tags.join(', '))} placeholder="adventure, banter" />
                </Field>
              </div>
            </section>

            <section className="form-section" aria-labelledby="s-pers">
              <h2 id="s-pers">Personality and background</h2>
              <p className="lead">Use {'{{user}}'} for the person chatting and {'{{char}}'} for this character's name in any field.</p>
              <div className="fields">
                <Field label="Personality traits" htmlFor="c-pers" action={aiBtn('personality')} hint="How they think, feel and behave.">
                  <textarea id="c-pers" className="textarea" rows={4} value={f.personality} onChange={(e) => set('personality', e.target.value)} placeholder="Dry, observant, quietly loyal. Distrusts anyone who is never tired." />
                </Field>
                <Field label="Background and lore" htmlFor="c-bg" action={aiBtn('background')} hint="History, setting, relationships, facts about their world.">
                  <textarea id="c-bg" className="textarea" rows={6} value={f.background} onChange={(e) => set('background', e.target.value)} />
                </Field>
                <Field label="Goals, motivations and preferences" htmlFor="c-goals" action={aiBtn('goals')} hint="What they want, and what they like or avoid.">
                  <textarea id="c-goals" className="textarea" rows={4} value={f.goals} onChange={(e) => set('goals', e.target.value)} />
                </Field>
              </div>
            </section>

            <section className="form-section" aria-labelledby="s-voice">
              <h2 id="s-voice">Voice</h2>
              <p className="lead">How they sound, and how a conversation begins.</p>
              <div className="fields">
                <Field label="Speaking style and mannerisms" htmlFor="c-style" action={aiBtn('speakingStyle')}>
                  <textarea id="c-style" className="textarea" rows={4} value={f.speakingStyle} onChange={(e) => set('speakingStyle', e.target.value)} placeholder="Short, wry sentences. Goes quieter instead of louder." />
                </Field>
                <Field label="Greeting" htmlFor="c-greet" action={aiBtn('greeting')} hint="Optional opening message for each new conversation.">
                  <textarea id="c-greet" className="textarea voice-input" rows={4} value={f.greeting} onChange={(e) => set('greeting', e.target.value)} />
                </Field>
                <Field label="Example dialogue" htmlFor="c-ex" action={aiBtn('exampleDialogue')} hint="Optional. A few lines that show the voice, for example “{{user}}: …” then “{{char}}: …”.">
                  <textarea id="c-ex" className="textarea voice-input" rows={5} value={f.exampleDialogue} onChange={(e) => set('exampleDialogue', e.target.value)} />
                </Field>
              </div>
            </section>

            <div className="prompt-block">
              <div className="label-row"><h2 id="s-prompt">System prompt addition</h2>{aiBtn('systemPromptAddition')}</div>
              <p className="hint" style={{ margin: '2px 0 12px' }}>
                Your own instructions for how this character behaves, thinks and replies. Folio sends them after the fields above, as a separate block the model is told to follow. Nothing else you edit changes this text.
              </p>
              <label className="sr-only" htmlFor="c-prompt">System prompt addition</label>
              <textarea id="c-prompt" className="textarea code" value={f.systemPromptAddition} onChange={(e) => set('systemPromptAddition', e.target.value)} placeholder={'Keep replies to one to four short paragraphs.\nNever speak or act for {{user}}.'} spellCheck="false" />
              <div className="hint" style={{ marginTop: 6 }}>{f.systemPromptAddition.length.toLocaleString('en-US')} / 40,000 characters</div>
            </div>

            <section className="form-section" aria-labelledby="s-model" style={{ marginTop: 24 }}>
              <h2 id="s-model">Model and memory</h2>
              <p className="lead">Optional overrides for this character. Leave blank to use your default model.</p>
              <ModelOverride f={f} set={set} providers={providers} />
              <div style={{ marginTop: 8 }}>
                <Toggle label="Remember across conversations" hint="Turn off for a character who starts fresh every time. Saved memories stay, but are not used." checked={f.memoryEnabled} onChange={(v) => set('memoryEnabled', v)} />
                <div className="switch">
                  <div className="grow">
                    <div>Learn from conversations</div>
                    <div className="hint">Whether Folio extracts new memories automatically for this character.</div>
                  </div>
                  <select className="select sm" style={{ width: 'auto' }} aria-label="Learn from conversations" value={f.autoExtract == null ? 'default' : f.autoExtract ? 'on' : 'off'} onChange={(e) => set('autoExtract', e.target.value === 'default' ? null : e.target.value === 'on')}>
                    <option value="default">Follow global setting</option>
                    <option value="on">Always</option>
                    <option value="off">Never</option>
                  </select>
                </div>
              </div>
            </section>
          </div>
        </div>

        {portraitOpen && <PortraitDialog character={f} onClose={closePortrait} onUse={(a) => { set('avatar', a); setPortraitOpen(false); }} />}
        <aside className="editor-side" aria-label="Preview">
          <div className="tabs" role="tablist">
            {[['card', 'Card'], ['chat', 'Test chat'], ['prompt', 'Prompt']].map(([k, label]) => (
              <button key={k} role="tab" className="tab" aria-selected={side === k} onClick={() => setSide(k)}>{label}</button>
            ))}
          </div>
          <div className="pane">
            {side === 'card' && <CardPreview c={previewChar} />}
            {side === 'chat' && <TestChat f={f} character={previewChar} />}
            {side === 'prompt' && <PromptPreview f={f} />}
          </div>
        </aside>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ pieces */

function AiPanel({ ai, setAi, providers, isNew, empties, hasDraft, onAll, onEmpty, onCancel }) {
  const [models, setModels] = useState([]);
  const [open, setOpen] = useState(isNew);
  useEffect(() => {
    setModels([]);
    if (!ai.providerId) return;
    let alive = true;
    api.get(`/providers/${ai.providerId}/models`).then((r) => { if (alive && r.ok) setModels(r.models.map((m) => m.id)); }).catch(() => {});
    return () => { alive = false; };
  }, [ai.providerId]);
  const busy = !!ai.busy;
  const noIdea = !ai.idea.trim() && !hasDraft;
  const noProvider = ai.error?.code === 'no_provider';
  return (
    <section className="ai-panel" aria-labelledby="s-ai">
      <button type="button" className="ai-head" aria-expanded={open} aria-controls="ai-body" onClick={() => setOpen((v) => !v)}>
        <Sparkles size={16} aria-hidden="true" />
        <span id="s-ai">Create with AI</span>
        <span className="hint">{open ? '' : 'Describe an idea and let the model write the card'}</span>
      </button>
      {open && (
        <div id="ai-body" className="stack" style={{ gap: 12 }}>
          <Field label="Your idea" htmlFor="ai-idea" hint="A few words are enough. Add anything you care about: setting, mood, how they talk. Your idea and any text already written below are sent to the model you pick.">
            <textarea id="ai-idea" className="textarea" rows={3} maxLength={3000} value={ai.idea} disabled={busy} onChange={(e) => setAi((a) => ({ ...a, idea: e.target.value }))} placeholder="A gruff lighthouse keeper who secretly writes love poems to the sea" />
          </Field>
          <details className="ai-model">
            <summary>Model: {ai.providerId ? `${providers.find((p) => p.id === ai.providerId)?.name || 'Chosen provider'}${ai.model ? ` · ${ai.model}` : ''}` : 'your default model'}</summary>
            <div className="fields two" style={{ marginTop: 10 }}>
              <Field label="Provider" htmlFor="ai-prov">
                <select id="ai-prov" className="select" value={ai.providerId} disabled={busy} onChange={(e) => setAi((a) => ({ ...a, providerId: e.target.value, model: '' }))}>
                  <option value="">Default provider</option>
                  {providers.filter((p) => p.enabled).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </Field>
              <Field label="Model" htmlFor="ai-model" hint={ai.providerId ? 'Leave empty for that provider’s default.' : 'Choose a provider first to pick a different model.'}>
                <input id="ai-model" className="input" list="ai-models" value={ai.model} disabled={busy || !ai.providerId} onChange={(e) => setAi((a) => ({ ...a, model: e.target.value }))} placeholder="Provider default" />
                <datalist id="ai-models">{models.map((m) => <option key={m} value={m} />)}</datalist>
              </Field>
            </div>
          </details>
          <div className="cluster wrap">
            <button type="button" className="btn primary" onClick={onAll} disabled={busy || noIdea}>
              {ai.busy === 'all' ? <span className="spin" aria-hidden="true" /> : <Sparkles size={15} aria-hidden="true" />} {ai.busy === 'all' ? 'Writing the character…' : 'Write the whole character'}
            </button>
            {hasDraft && <button type="button" className="btn" onClick={onEmpty} disabled={busy || !empties.length}>Fill in only the empty parts</button>}
            {busy && <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>}
          </div>
          <p className="hint">Prefer to write it yourself? Every part below also has its own “Draft with AI” button, and the portrait is always yours to choose.</p>
          <ErrorNotice error={ai.error} action={noProvider ? <Link className="btn sm" to="/settings/providers">Set up a provider</Link> : undefined} />
        </div>
      )}
    </section>
  );
}

function ModelOverride({ f, set, providers }) {
  const [models, setModels] = useState([]);
  const [note, setNote] = useState('');
  useEffect(() => {
    setModels([]);
    setNote('');
    if (!f.providerId) return;
    let alive = true;
    api.get(`/providers/${f.providerId}/models`).then((r) => {
      if (!alive) return;
      if (r.ok) setModels(r.models.map((m) => m.id));
      else setNote(r.message);
    }).catch(() => {});
    return () => { alive = false; };
  }, [f.providerId]);
  const gone = f.providerId && !providers.some((p) => p.id === f.providerId);
  return (
    <div className="fields two">
      <Field label="Provider" htmlFor="c-prov">
        <select id="c-prov" className="select" value={f.providerId || ''} onChange={(e) => { set('providerId', e.target.value || null); set('model', ''); }}>
          <option value="">Default provider</option>
          {providers.map((p) => <option key={p.id} value={p.id}>{p.name}{p.enabled ? '' : ' (disabled)'}</option>)}
          {gone && <option value={f.providerId}>(removed provider)</option>}
        </select>
      </Field>
      <Field label="Model" htmlFor="c-model" hint={note || (f.providerId ? 'Pick a discovered model or type a name.' : 'Choose a provider first to override the model.')}>
        <input id="c-model" className="input" list="c-models" value={f.model} disabled={!f.providerId} onChange={(e) => set('model', e.target.value)} placeholder="Provider default" />
        <datalist id="c-models">{models.map((m) => <option key={m} value={m} />)}</datalist>
      </Field>
    </div>
  );
}

function CardPreview({ c }) {
  const rows = [['Personality', c.personality], ['Background', c.background], ['Speaking style', c.speakingStyle], ['Goals', c.goals], ['Example dialogue', c.exampleDialogue]].filter(([, v]) => v?.trim());
  return (
    <div className="card-preview">
      <div className="cluster" style={{ alignItems: 'flex-start', gap: 14 }}>
        <Avatar character={c} size={64} />
        <div className="grow">
          <div className="name">{c.name || 'Unnamed character'}</div>
          <p className="muted" style={{ marginTop: 3 }}>{c.description || 'No description yet.'}</p>
          {c.tags.length > 0 && <div className="cluster wrap" style={{ marginTop: 8, gap: 5 }}>{c.tags.map((t) => <span key={t} className="chip">{t}</span>)}</div>}
        </div>
      </div>
      {c.greeting.trim() && (
        <>
          <div className="small muted" style={{ marginTop: 16, fontWeight: 600 }}>Opens with</div>
          <p className="voice" style={{ marginTop: 3, whiteSpace: 'pre-wrap', fontSize: '1.08em', lineHeight: 1.55 }}><Styled text={c.greeting.replace(/\{\{\s*char\s*\}\}/gi, c.name || 'the character').replace(/\{\{\s*user\s*\}\}/gi, 'you')} /></p>
        </>
      )}
      <dl>
        {rows.map(([k, v]) => (<div key={k}><dt>{k}</dt><dd className="clamp-4" style={{ display: 'block' }}>{v.length > 320 ? `${v.slice(0, 320)}…` : v}</dd></div>))}
      </dl>
      {!rows.length && !c.greeting.trim() && <p className="hint" style={{ marginTop: 14 }}>Fill in the form and the card updates here.</p>}
    </div>
  );
}

function TestChat({ f, character }) {
  const [msgs, setMsgs] = useState([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const ctl = useRef(null);
  const end = useRef(null);
  const greeting = f.greeting.trim().replace(/\{\{\s*char\s*\}\}/gi, f.name || 'the character').replace(/\{\{\s*user\s*\}\}/gi, 'you');
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [msgs]);
  useEffect(() => () => ctl.current?.abort(), []);

  async function send() {
    const t = text.trim();
    if (!t || busy) return;
    const history = [...msgs, { role: 'user', content: t }];
    setMsgs([...history, { role: 'character', content: '', pending: true }]);
    setText('');
    setBusy(true);
    setError(null);
    ctl.current = new AbortController();
    const { avatar, ...draft } = f;
    const payload = [...(greeting ? [{ role: 'character', content: greeting }] : []), ...history].map(({ role, content }) => ({ role, content }));
    let acc = '';
    try {
      await stream('/characters/preview-chat', { character: draft, messages: payload }, {
        signal: ctl.current.signal,
        onEvent: (ev, d) => {
          if (ev === 'delta') { acc += d.text; setMsgs([...history, { role: 'character', content: acc, pending: true }]); }
          if (ev === 'error') setError(d);
        },
      });
    } catch (e) {
      setError(e);
    } finally {
      setMsgs(acc ? [...history, { role: 'character', content: acc }] : history);
      setBusy(false);
    }
  }

  return (
    <div className="stack" style={{ gap: 12 }}>
      <p className="hint">Try the unsaved character right now. Nothing here is saved, and memory is not used.</p>
      <div className="stack" style={{ gap: 10 }}>
        {greeting && <div className="voice" style={{ whiteSpace: 'pre-wrap', lineHeight: 1.55 }}><b>{f.name || 'Character'}</b><br /><Styled text={greeting} /></div>}
        {msgs.map((m, i) => (
          <div key={i} className={m.role === 'user' ? 'msg user' : 'voice'} style={m.role === 'user' ? { margin: 0 } : { whiteSpace: 'pre-wrap', lineHeight: 1.55 }}>
            {m.role === 'user' ? m.content : <><b>{f.name || 'Character'}</b><br />{m.content ? <Styled text={m.content} /> : <span className="muted">…</span>}</>}
          </div>
        ))}
        <div ref={end} />
      </div>
      <ErrorNotice error={error} />
      <div className="cluster" style={{ alignItems: 'flex-end' }}>
        <textarea className="textarea" rows={2} style={{ minHeight: 56 }} aria-label="Test message" placeholder="Say something" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
        {busy ? <button className="btn icon" onClick={() => ctl.current?.abort()} aria-label="Stop"><Square size={15} /></button> : <button className="btn primary icon" onClick={send} disabled={!text.trim()} aria-label="Send"><Send size={15} /></button>}
      </div>
      {msgs.length > 0 && <button className="btn sm ghost" style={{ alignSelf: 'flex-start' }} onClick={() => { setMsgs([]); setError(null); }}>Clear test chat</button>}
    </div>
  );
}

function PromptPreview({ f }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const key = JSON.stringify([f.name, f.description, f.personality, f.background, f.speakingStyle, f.goals, f.exampleDialogue, f.systemPromptAddition]);
  useEffect(() => {
    const t = setTimeout(() => {
      api.post('/characters/preview-prompt', { name: f.name, description: f.description, personality: f.personality, background: f.background, speakingStyle: f.speakingStyle, goals: f.goals, exampleDialogue: f.exampleDialogue, systemPromptAddition: f.systemPromptAddition })
        .then((d) => { setData(d); setErr(null); }).catch(setErr);
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return (
    <div className="stack" style={{ gap: 10 }}>
      <p className="hint">Exactly what the model is told about this character. At chat time, relevant memories and past conversation excerpts are added below this.</p>
      <ErrorNotice error={err} />
      {data && <><span className="chip" style={{ alignSelf: 'flex-start' }}>About {data.estimatedTokens.toLocaleString('en-US')} tokens</span><div className="prompt-view">{data.system}</div></>}
    </div>
  );
}
