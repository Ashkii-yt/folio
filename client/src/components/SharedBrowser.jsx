import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Eye, Plus, Search, Share2 } from 'lucide-react';
import { useApp } from '../store.jsx';
import { api } from '../api.js';
import { Avatar, Dialog, Empty, ErrorNotice, Spinner, useConfirm, useToast } from '../ui.jsx';

const avatarOf = (c) => ({ ...c, avatarSrc: `/api/shared/${c.id}/avatar?v=${encodeURIComponent(c.updatedAt)}` });

/** Characters other people on this server have chosen to share. Adding one makes your own copy. */
export default function SharedBrowser() {
  const { refreshCharacters } = useApp();
  const nav = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const [list, setList] = useState(null);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState('');
  const [view, setView] = useState(null); // full card being previewed
  const [busy, setBusy] = useState(null);
  const closeView = useCallback(() => setView(null), []);

  const load = useCallback(async () => {
    try {
      setList(await api.get('/shared'));
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const tags = useMemo(() => {
    const n = new Map();
    (list || []).forEach((c) => c.tags.forEach((t) => n.set(t, (n.get(t) || 0) + 1)));
    return [...n.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
  }, [list]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (list || []).filter((c) => (!tag || c.tags.includes(tag)) && (!q || [c.name, c.description, c.owner, ...c.tags].join(' ').toLowerCase().includes(q)));
  }, [list, query, tag]);

  const add = async (c) => {
    setBusy(c.id);
    try {
      const made = await api.post(`/shared/${c.id}/add`);
      await refreshCharacters();
      setView(null);
      toast.info(`Added ${made.name} to My characters. Your chats and memories with them stay private to you.`, { action: { label: 'Chat now', run: () => nav(`/chat/${made.id}`) }, ms: 8000 });
      load();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  };

  const unshare = async (c) => {
    const ok = await confirm({ title: `Stop sharing ${c.name}?`, message: 'It disappears from this list. People who already added it keep their own copies.', confirmLabel: 'Stop sharing', danger: false });
    if (!ok) return;
    try {
      await api.del(`/shared/${c.id}`);
      setView(null);
      load();
      toast.info(`${c.name} is no longer shared.`);
    } catch (e) {
      toast.error(e.message);
    }
  };

  const open = async (c) => {
    try {
      setView(await api.get(`/shared/${c.id}`));
    } catch (e) {
      toast.error(e.message);
      load();
    }
  };

  if (error) return <ErrorNotice error={error} action={<button className="btn sm" onClick={load}>Try again</button>} />;
  if (!list) return <Spinner />;
  if (!list.length) {
    return (
      <Empty title="Nothing shared yet">
        When someone on this server shares a character, it shows up here. Share your own from My characters.
      </Empty>
    );
  }

  return (
    <>
      <div className="cluster wrap" style={{ marginBottom: 14 }}>
        <div className="search grow" style={{ maxWidth: 360 }}>
          <Search size={16} aria-hidden="true" />
          <input className="input" type="search" placeholder="Search shared characters" aria-label="Search shared characters" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        {tags.length > 0 && (
          <div className="cluster wrap" role="group" aria-label="Filter by tag">
            {tags.map((t) => <button key={t} className="chip" aria-pressed={tag === t} onClick={() => setTag(tag === t ? '' : t)}>{t}</button>)}
          </div>
        )}
      </div>
      {shown.length === 0 ? (
        <Empty title="No matches" actions={<button className="btn" onClick={() => { setQuery(''); setTag(''); }}>Clear filters</button>}>Nothing matches your search.</Empty>
      ) : (
        <div className="cast">
          {shown.map((c) => (
            <article key={c.id} className="cast-item">
              <button className="open" style={{ background: 'none', border: 0, cursor: 'pointer' }} aria-label={`Preview ${c.name}`} onClick={() => open(c)} />
              <Avatar character={avatarOf(c)} size={64} />
              <div className="grow">
                <h2 className="name">{c.name}</h2>
                <div className="by">{c.mine ? 'Shared by you' : `Shared by ${c.owner}`}{c.adds > 0 ? ` · added ${c.adds} time${c.adds === 1 ? '' : 's'}` : ''}</div>
                <p className="desc clamp-2">{c.description || 'No description.'}</p>
                {c.tags.length > 0 && <div className="tags">{c.tags.map((t) => <span key={t} className="tag">{t}</span>)}</div>}
                <div className="acts">
                  <button className="btn sm" onClick={() => open(c)}><Eye size={14} aria-hidden="true" /> Preview</button>
                  {!c.mine && <button className="btn sm primary" disabled={busy === c.id} onClick={() => add(c)}><Plus size={14} aria-hidden="true" /> Add to mine</button>}
                  {c.mine && <button className="btn sm ghost" onClick={() => unshare(c)}><Share2 size={14} aria-hidden="true" /> Stop sharing</button>}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
      {view && <Preview v={view} busy={busy === view.id} onClose={closeView} onAdd={() => add(view)} onUnshare={() => unshare(view)} />}
    </>
  );
}

function Preview({ v, busy, onClose, onAdd, onUnshare }) {
  const c = v.card;
  const rows = [['Personality', c.personality], ['Background', c.background], ['Speaking style', c.speakingStyle], ['Goals', c.goals], ['Greeting', c.greeting], ['Example dialogue', c.exampleDialogue]].filter(([, x]) => x?.trim());
  return (
    <Dialog
      title={c.name}
      wide
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Close</button>
          {v.mine ? <button className="btn" onClick={onUnshare}>Stop sharing</button> : <button className="btn primary" disabled={busy} onClick={onAdd}>Add to my characters</button>}
        </>
      }
    >
      <div className="cluster" style={{ alignItems: 'flex-start', gap: 14 }}>
        <Avatar character={avatarOf(v)} size={56} />
        <div className="grow">
          <div className="by">{v.mine ? 'Shared by you' : `Shared by ${v.owner}`}</div>
          <p style={{ marginTop: 4 }}>{c.description || 'No description.'}</p>
        </div>
      </div>
      <dl className="card-view">
        {rows.map(([k, x]) => <div key={k}><dt>{k}</dt><dd>{x}</dd></div>)}
        {c.systemPromptAddition?.trim() && <div><dt>System prompt addition (instructions sent to the model)</dt><dd className="mono">{c.systemPromptAddition}</dd></div>}
      </dl>
      <p className="hint" style={{ marginTop: 14 }}>Adding makes your own copy. You can edit it freely, and your conversations and memories with it stay private to you.</p>
    </Dialog>
  );
}
