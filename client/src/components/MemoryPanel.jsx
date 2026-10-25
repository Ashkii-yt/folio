import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, ChevronDown, ChevronRight, Download, Pencil, Pin, Plus, RotateCcw, ScanSearch, Search, Trash2, Upload, X } from 'lucide-react';
import { api, download, uploadJson } from '../api.js';
import { useApp } from '../store.jsx';
import { ErrorNotice, Spinner, useConfirm, useToast } from '../ui.jsx';
import { CATEGORY_LABEL, timeAgo } from '../lib.js';

const STATUS_TABS = [
  ['active', 'Saved'],
  ['pending', 'Review'],
  ['superseded', 'Replaced'],
];

export default function MemoryPanel({ character, conversationId, onOpenConversation, compact = false }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { categories, refreshCharacters } = useApp();
  const [all, setAll] = useState(null);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('active');
  const [query, setQuery] = useState('');
  const [cat, setCat] = useState('');
  const [adding, setAdding] = useState(false);
  const [scanning, setScanning] = useState(false);
  const fileRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get(`/characters/${character.id}/memories?status=all`);
      setAll(r.memories);
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, [character.id]);
  useEffect(() => { setAll(null); load(); }, [load]);

  // Memories are extracted in the background after replies; refresh when the panel regains focus.
  useEffect(() => {
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  const byId = useMemo(() => new Map((all || []).map((m) => [m.id, m])), [all]);
  const counts = useMemo(() => {
    const c = { active: 0, pending: 0, superseded: 0 };
    (all || []).forEach((m) => { c[m.status] = (c[m.status] || 0) + 1; });
    return c;
  }, [all]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (all || [])
      .filter((m) => m.status === tab && (!cat || m.category === cat) && (!q || m.content.toLowerCase().includes(q)))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.importance - a.importance || b.updatedAt.localeCompare(a.updatedAt));
  }, [all, tab, cat, query]);

  const run = async (fn, msg) => {
    try {
      await fn();
      await load();
      refreshCharacters();
      if (msg) toast.info(msg);
    } catch (e) {
      toast.error(e.message);
    }
  };

  const scan = async () => {
    setScanning(true);
    try {
      const r = await api.post(`/conversations/${conversationId}/extract`);
      await load();
      refreshCharacters();
      if (r.skipped === 'memory_disabled') toast.info('Memory is turned off for this character.');
      else if (r.error) toast.error(`Could not scan: ${r.error}`);
      else {
        const parts = [r.added && `${r.added} new`, r.updated && `${r.updated} updated`, r.pending && `${r.pending} to review`, r.reinforced && `${r.reinforced} confirmed again`].filter(Boolean);
        toast.info(parts.length ? `Scanned this chat: ${parts.join(', ')}.` : 'Scanned this chat. Nothing new worth remembering.');
        if (r.notes?.length) toast.info(r.notes[0], { ms: 6000 });
      }
    } catch (e) {
      toast.error(e.message);
    } finally {
      setScanning(false);
    }
  };

  const clearAll = async () => {
    const ok = await confirm({
      title: `Clear all of ${character.name}'s memories?`,
      message: <>This deletes {all?.length || 0} saved memor{all?.length === 1 ? 'y' : 'ies'}, including replaced ones. Conversations are not affected, and automatic extraction may learn things again from them. Export first if you want a copy.</>,
      confirmLabel: 'Clear memories',
      require: 'CLEAR',
    });
    if (ok) run(() => api.del(`/characters/${character.id}/memories`), 'Memories cleared.');
  };

  const onImport = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const r = await api.post(`/characters/${character.id}/memories/import`, await uploadJson(file));
      await load();
      refreshCharacters();
      toast.info(`Imported ${r.added} memor${r.added === 1 ? 'y' : 'ies'}${r.skipped ? ` (${r.skipped} skipped as duplicates or invalid)` : ''}.`);
    } catch (err) {
      toast.error(err.message);
    }
  };

  if (error && !all) return <ErrorNotice error={error} action={<button className="btn sm" onClick={load}>Retry</button>} />;
  if (!all) return <Spinner />;

  return (
    <div className="stack" style={{ gap: 14 }}>
      {!compact && <p className="hint">Everything {character.name} knows about you, with where it came from. Edit anything that is wrong. Your edits and pins always win over automatic changes.</p>}

      <div className="mem-tools">
        <div className="tabs" role="tablist" aria-label="Memory status">
          {STATUS_TABS.map(([k, label]) => (
            <button key={k} role="tab" className="tab" aria-selected={tab === k} onClick={() => setTab(k)} style={{ padding: '8px 9px' }}>
              {label}{counts[k] ? <span className="muted" style={{ marginLeft: 5, fontWeight: 450 }}>{counts[k]}</span> : null}
            </button>
          ))}
        </div>
        <div className="cluster">
          <div className="search grow">
            <Search size={15} aria-hidden="true" />
            <input className="input sm" type="search" aria-label="Search memories" placeholder="Search memories" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <select className="select sm" style={{ width: 'auto', maxWidth: 140 }} aria-label="Filter by category" value={cat} onChange={(e) => setCat(e.target.value)}>
            <option value="">All types</option>
            {categories.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c] || c}</option>)}
          </select>
        </div>
        <div className="cluster wrap">
          <button className="btn sm" onClick={() => setAdding((v) => !v)} aria-expanded={adding}><Plus size={14} aria-hidden="true" /> Add a memory</button>
          {conversationId && <button className="btn sm" onClick={scan} disabled={scanning} title="Look for new things to remember in this conversation right now"><ScanSearch size={14} aria-hidden="true" /> {scanning ? 'Scanning…' : 'Scan this chat'}</button>}
        </div>
      </div>

      {adding && <AddMemory categories={categories} onCancel={() => setAdding(false)} onSave={async (body) => { await run(() => api.post(`/characters/${character.id}/memories`, body), 'Memory added.'); setAdding(false); }} />}

      {!character.memoryEnabled && <p className="notice warn">Memory is turned off for {character.name}. Saved memories are kept but not used in chats. Turn it back on in Details.</p>}

      <div>
        {shown.length === 0 && (
          <p className="muted" style={{ padding: '14px 0' }}>
            {tab === 'active' && (all.length === 0 ? `${character.name} hasn't learned anything yet. Memories appear here as you talk, or add one yourself.` : 'No memories match.')}
            {tab === 'pending' && 'Nothing is waiting for review.'}
            {tab === 'superseded' && 'No memories have been replaced.'}
          </p>
        )}
        {shown.map((m) => (
          <MemoryItem
            key={m.id}
            m={m}
            replaced={m.conflictsWith ? byId.get(m.conflictsWith) : null}
            replacedBy={m.supersededBy ? byId.get(m.supersededBy) : null}
            categories={categories}
            onOpenConversation={onOpenConversation}
            onPatch={(body, msg) => run(() => api.patch(`/memories/${m.id}`, body), msg)}
            onDelete={async () => {
              const ok = await confirm({ title: 'Delete this memory?', message: <>“{m.content}”<div className="hint" style={{ marginTop: 6 }}>{character.name} will no longer recall it. Automatic extraction could learn it again if you mention it later.</div></>, confirmLabel: 'Delete memory' });
              if (ok) run(() => api.del(`/memories/${m.id}`));
            }}
            onApprove={() => run(() => api.post(`/memories/${m.id}/approve`), m.conflictsWith ? 'Updated. The old version is kept under Replaced.' : 'Memory approved.')}
            onRestore={() => run(() => api.post(`/memories/${m.id}/restore`), 'Restored.')}
          />
        ))}
      </div>

      <Recall character={character} onOpenConversation={onOpenConversation} />
      <Records character={character} onOpenConversation={onOpenConversation} />

      <div className="cluster wrap" style={{ borderTop: '1px solid var(--line)', paddingTop: 12 }}>
        <button className="btn sm" onClick={() => download(`/characters/${character.id}/memories/export`)}><Download size={14} aria-hidden="true" /> Export</button>
        <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={onImport} />
        <button className="btn sm" onClick={() => fileRef.current.click()}><Upload size={14} aria-hidden="true" /> Import</button>
        <button className="btn sm danger" onClick={clearAll} disabled={!all.length}><Trash2 size={14} aria-hidden="true" /> Clear all</button>
        <Link to="/settings/memory" className="hint" style={{ marginLeft: 'auto', textDecoration: 'underline' }}>Memory settings</Link>
      </div>
    </div>
  );
}

function Stars({ n }) {
  return <span className="imp" title={`Importance ${n} of 5`} aria-label={`Importance ${n} of 5`}>{[1, 2, 3, 4, 5].map((i) => <i key={i} className={i <= n ? 'on' : ''} />)}</span>;
}

function MemoryItem({ m, replaced, replacedBy, categories, onPatch, onDelete, onApprove, onRestore, onOpenConversation }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(m.content);
  const [cat, setCat] = useState(m.category);
  const [imp, setImp] = useState(m.importance);
  useEffect(() => { if (!editing) { setText(m.content); setCat(m.category); setImp(m.importance); } }, [m, editing]);

  if (editing) {
    return (
      <div className="mem">
        <div className="stack" style={{ gap: 8 }}>
          <textarea className="textarea" rows={3} autoFocus aria-label="Memory text" value={text} maxLength={600} onChange={(e) => setText(e.target.value)} style={{ minHeight: 64 }} />
          <div className="cluster wrap">
            <select className="select sm" style={{ width: 'auto' }} aria-label="Type" value={cat} onChange={(e) => setCat(e.target.value)}>{categories.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c] || c}</option>)}</select>
            <select className="select sm" style={{ width: 'auto' }} aria-label="Importance" value={imp} onChange={(e) => setImp(Number(e.target.value))}>
              {[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>Importance {n}</option>)}
            </select>
          </div>
          <div className="cluster">
            <button className="btn sm primary" disabled={text.trim().length < 3} onClick={async () => { await onPatch({ content: text, category: cat, importance: imp }, 'Memory updated.'); setEditing(false); }}>Save</button>
            <button className="btn sm" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`mem ${m.status}`}>
      {m.status === 'pending' && replaced && <p className="small" style={{ marginBottom: 4 }}><b>Proposed change.</b> Replaces: “{replaced.content}”</p>}
      {m.status === 'pending' && !replaced && <p className="small" style={{ marginBottom: 4 }}><b>New, waiting for your approval.</b> It is not used in chats until you approve it.</p>}
      <div className="text">{m.content}</div>
      <div className="meta">
        <span className="chip">{CATEGORY_LABEL[m.category] || m.category}</span>
        {m.pinned && <span className="chip accent"><Pin size={11} aria-hidden="true" /> Pinned</span>}
        <span>{m.source === 'user' ? 'Written or edited by you' : 'Learned automatically'}</span>
        <span>· {timeAgo(m.updatedAt)}</span>
        <Stars n={m.importance} />
        {m.recurrence > 1 && <span>· came up {m.recurrence}×</span>}
        {m.useCount > 0 && <span>· recalled {m.useCount}×</span>}
        {m.sourceConversationId && onOpenConversation && <button className="btn ghost sm" style={{ height: 'auto', padding: 0, textDecoration: 'underline', fontSize: 'inherit', color: 'inherit' }} onClick={() => onOpenConversation(m.sourceConversationId)}>from a conversation</button>}
      </div>
      {m.status === 'superseded' && replacedBy && <p className="hint" style={{ marginTop: 4 }}>Replaced by: “{replacedBy.content}”</p>}
      <div className="acts">
        {m.status === 'pending' && (
          <>
            <button className="btn sm primary" onClick={onApprove}><Check size={14} aria-hidden="true" /> {replaced ? 'Apply change' : 'Approve'}</button>
            <button className="btn sm" onClick={onDelete}><X size={14} aria-hidden="true" /> Dismiss</button>
          </>
        )}
        {m.status === 'active' && (
          <>
            <button className="btn ghost icon sm" aria-pressed={m.pinned} aria-label={m.pinned ? 'Unpin memory' : 'Pin memory'} title={m.pinned ? 'Unpin' : 'Pin: always remembered'} onClick={() => onPatch({ pinned: !m.pinned })}><Pin size={14} fill={m.pinned ? 'currentColor' : 'none'} className={m.pinned ? 'pin-on' : ''} /></button>
            <button className="btn ghost icon sm" aria-label="Edit memory" title="Edit" onClick={() => setEditing(true)}><Pencil size={14} /></button>
            <button className="btn ghost icon sm" aria-label="Delete memory" title="Delete" onClick={onDelete}><Trash2 size={14} /></button>
          </>
        )}
        {m.status === 'superseded' && (
          <>
            <button className="btn sm" onClick={onRestore}><RotateCcw size={14} aria-hidden="true" /> Restore this version</button>
            <button className="btn ghost icon sm" aria-label="Delete memory" title="Delete" onClick={onDelete}><Trash2 size={14} /></button>
          </>
        )}
      </div>
    </div>
  );
}

function AddMemory({ categories, onSave, onCancel }) {
  const [text, setText] = useState('');
  const [cat, setCat] = useState('fact');
  const [pin, setPin] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <div className="stack" style={{ gap: 8, padding: 12, border: '1px solid var(--line)', borderRadius: 'var(--r)', background: 'var(--surface)' }}>
      <label className="sr-only" htmlFor="new-mem">New memory</label>
      <textarea id="new-mem" className="textarea" rows={2} autoFocus placeholder="A fact for them to remember, for example: The user's cat is named Biscuit." value={text} maxLength={600} onChange={(e) => setText(e.target.value)} style={{ minHeight: 56 }} />
      <div className="cluster wrap">
        <select className="select sm" style={{ width: 'auto' }} aria-label="Type" value={cat} onChange={(e) => setCat(e.target.value)}>{categories.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c] || c}</option>)}</select>
        <label className="check small"><input type="checkbox" checked={pin} onChange={(e) => setPin(e.target.checked)} /> Pin it</label>
        <span className="grow" />
        <button className="btn sm" onClick={onCancel}>Cancel</button>
        <button className="btn sm primary" disabled={busy || text.trim().length < 3} onClick={async () => { setBusy(true); try { await onSave({ content: text, category: cat, pinned: pin }); } finally { setBusy(false); } }}>Add memory</button>
      </div>
    </div>
  );
}

/** "What would they recall if I said…": shows exactly what retrieval would pull for a message. */
function Recall({ character, onOpenConversation }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [res, setRes] = useState(null);
  const [err, setErr] = useState(null);
  const go = async (e) => {
    e?.preventDefault();
    if (!q.trim()) return;
    try { setRes(await api.get(`/characters/${character.id}/recall?q=${encodeURIComponent(q)}`)); setErr(null); } catch (x) { setErr(x); }
  };
  return (
    <div>
      <button className="btn ghost sm" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />} Test what they would recall</button>
      {open && (
        <form onSubmit={go} className="stack" style={{ gap: 8, marginTop: 8 }}>
          <div className="cluster">
            <input className="input sm" aria-label="A message to test" placeholder="Type a message, for example: any gift ideas for my sister?" value={q} onChange={(e) => setQ(e.target.value)} />
            <button className="btn sm" type="submit">Test</button>
          </div>
          <ErrorNotice error={err} />
          {res && res.memories.length === 0 && res.excerpts.length === 0 && <p className="hint">Nothing relevant. They would answer without recalling anything.</p>}
          {res?.memories.map((m) => (<div key={m.id} className="recall-hit"><span className="l">Memory · relevance {m.score}</span>{m.content}</div>))}
          {res?.excerpts.map((e) => (
            <div key={e.conversationId + e.messages[0].id} className="recall-hit">
              <span className="l">Past conversation: {onOpenConversation ? <button className="btn ghost sm" style={{ height: 'auto', padding: 0, textDecoration: 'underline', fontSize: 'inherit', color: 'inherit' }} onClick={() => onOpenConversation(e.conversationId)}>{e.title}</button> : e.title}</span>
              {e.messages.map((m) => <div key={m.id}><b>{m.role === 'user' ? 'You' : character.name}:</b> {m.text}</div>)}
            </div>
          ))}
        </form>
      )}
    </div>
  );
}

/** The chronological record. Summaries are shown here for inspection; the originals always remain. */
function Records({ character, onOpenConversation }) {
  const [open, setOpen] = useState(false);
  const [convs, setConvs] = useState(null);
  const [sums, setSums] = useState({});
  useEffect(() => {
    if (open && !convs) api.get(`/characters/${character.id}/conversations`).then(setConvs).catch(() => setConvs([]));
  }, [open, convs, character.id]);
  const toggle = async (id) => {
    if (sums[id]) return setSums((s) => ({ ...s, [id]: null }));
    const r = await api.get(`/conversations/${id}/summaries`).catch(() => []);
    setSums((s) => ({ ...s, [id]: r }));
  };
  return (
    <div>
      <button className="btn ghost sm" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />} Conversation records</button>
      {open && (
        <div style={{ marginTop: 6 }}>
          {!convs && <Spinner />}
          {convs?.length === 0 && <p className="hint">No conversations yet.</p>}
          {convs?.map((c) => (
            <div key={c.id} className="mem">
              <div className="cluster">
                <div className="grow">
                  <div style={{ fontWeight: 560 }}>{c.title}</div>
                  <div className="hint">{c.messageCount} message{c.messageCount === 1 ? '' : 's'} · {new Date(c.createdAt).toLocaleDateString()}</div>
                </div>
                <button className="btn sm ghost" onClick={() => toggle(c.id)}>Summaries</button>
                {onOpenConversation && <button className="btn sm ghost" onClick={() => onOpenConversation(c.id)}>Open</button>}
              </div>
              {sums[c.id] && (sums[c.id].length === 0
                ? <p className="hint" style={{ marginTop: 4 }}>No summary yet. Long conversations are summarized automatically; the full text is always kept.</p>
                : sums[c.id].map((s) => <p key={s.id} className="small" style={{ marginTop: 6 }}><span className="muted">Messages {s.fromSeq}–{s.toSeq} ({s.method === 'model' ? 'written by the model' : 'extracted from the text'}): </span>{s.content}</p>))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
