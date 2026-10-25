import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Copy, Download, MessageCircle, Pencil, Pin, Plus, Search, Trash2, Upload, Brain } from 'lucide-react';
import { useApp } from '../store.jsx';
import { api, download, uploadJson } from '../api.js';
import { Avatar, Empty, useConfirm, useToast } from '../ui.jsx';

export default function Library({ mode }) {
  const { characters, refreshCharacters } = useApp();
  const nav = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const fileRef = useRef(null);
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState('');
  const [sort, setSort] = useState(mode === 'browse' ? 'recent' : 'name');
  const mine = mode === 'mine';

  const tags = useMemo(() => {
    const n = new Map();
    characters.forEach((c) => c.tags.forEach((t) => n.set(t, (n.get(t) || 0) + 1)));
    return [...n.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
  }, [characters]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = characters.filter((c) => (!tag || c.tags.includes(tag)) && (!q || [c.name, c.description, c.personality, ...c.tags].join(' ').toLowerCase().includes(q)));
    const by = {
      name: (a, b) => a.name.localeCompare(b.name),
      recent: (a, b) => (b.lastChatAt || '').localeCompare(a.lastChatAt || '') || a.name.localeCompare(b.name),
      newest: (a, b) => b.createdAt.localeCompare(a.createdAt),
    }[sort];
    list = [...list].sort(by);
    return [...list.filter((c) => c.pinned), ...list.filter((c) => !c.pinned)];
  }, [characters, query, tag, sort]);

  const act = async (fn, okMsg) => {
    try {
      await fn();
      await refreshCharacters();
      if (okMsg) toast.info(okMsg);
    } catch (e) {
      toast.error(e.message);
    }
  };

  const remove = async (c) => {
    const ok = await confirm({
      title: `Delete ${c.name}?`,
      message: (
        <>
          This permanently deletes {c.name}, including {c.conversationCount} conversation{c.conversationCount === 1 ? '' : 's'} ({c.messageCount} message{c.messageCount === 1 ? '' : 's'}) and {c.memoryCount} memor{c.memoryCount === 1 ? 'y' : 'ies'}. This cannot be undone.
          <div className="hint" style={{ marginTop: 8 }}>You can export the character and its memories first from My characters.</div>
        </>
      ),
      confirmLabel: 'Delete character',
    });
    if (ok) act(() => api.del(`/characters/${c.id}`), `Deleted ${c.name}.`);
  };

  const onImport = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const created = await api.post('/characters/import', await uploadJson(file));
      await refreshCharacters();
      toast.info(`Imported ${created.name}.`);
    } catch (err) {
      toast.error(err.message);
    }
  };

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-head">
          <div className="grow">
            <h1>{mine ? 'My characters' : 'Browse characters'}</h1>
            <p>{mine ? 'Edit, duplicate, export or delete the characters you have made.' : 'Everyone you can talk to.'}</p>
          </div>
          {mine && (
            <>
              <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={onImport} />
              <button className="btn" onClick={() => fileRef.current.click()}><Upload size={16} aria-hidden="true" /> Import</button>
            </>
          )}
          <Link to="/characters/new" className="btn primary"><Plus size={16} aria-hidden="true" /> Make a character</Link>
        </div>

        {characters.length > 0 && (
          <div className="cluster wrap" style={{ marginBottom: 14 }}>
            <div className="search grow" style={{ maxWidth: 360 }}>
              <Search size={16} aria-hidden="true" />
              <input className="input" type="search" placeholder="Search characters" aria-label="Search characters" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <select className="select" style={{ width: 'auto' }} aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value)}>
              <option value="recent">Recently chatted</option>
              <option value="name">Name</option>
              <option value="newest">Newest</option>
            </select>
            {tags.length > 0 && (
              <div className="cluster wrap" role="group" aria-label="Filter by tag">
                {tags.map((t) => (
                  <button key={t} className="chip" aria-pressed={tag === t} onClick={() => setTag(tag === t ? '' : t)}>{t}</button>
                ))}
              </div>
            )}
          </div>
        )}

        {characters.length === 0 ? (
          <Empty
            title="Nobody here yet"
            actions={
              <>
                <Link to="/characters/new" className="btn primary">Make a character</Link>
                <button className="btn" onClick={() => act(() => api.post('/characters/starters'), 'Added the example characters.')}>Add four example characters</button>
              </>
            }
          >
            Make your first character, or add the examples to explore.
          </Empty>
        ) : shown.length === 0 ? (
          <Empty title="No matches" actions={<button className="btn" onClick={() => { setQuery(''); setTag(''); }}>Clear filters</button>}>
            Nothing matches your search.
          </Empty>
        ) : (
          <div className="cast">
            {shown.map((c) => (
              <article key={c.id} className="cast-item">
                {/* The whole tile opens the chat; real buttons sit above it. */}
                <button className="open" style={{ background: 'none', border: 0, cursor: 'pointer' }} aria-label={`Chat with ${c.name}`} onClick={() => nav(`/chat/${c.id}`)} />
                <Avatar character={c} size={64} />
                <div className="grow">
                  <h2 className="name">{c.name}</h2>
                  <p className="desc clamp-2">{c.description || 'No description yet.'}</p>
                  {c.tags.length > 0 && <div className="tags">{c.tags.map((t) => <span key={t} className="tag">{t}</span>)}</div>}
                  <div className="acts">
                    <Link to={`/chat/${c.id}`} className="btn sm primary"><MessageCircle size={14} aria-hidden="true" /> Chat</Link>
                    {mine && (
                      <>
                        <Link to={`/characters/${c.id}/edit`} className="btn sm"><Pencil size={14} aria-hidden="true" /> Edit</Link>
                        <Link to={`/characters/${c.id}/memory`} className="btn sm ghost" title="Memory"><Brain size={14} aria-hidden="true" /> {c.memoryCount}</Link>
                        <button className="btn sm ghost icon" title="Duplicate" aria-label={`Duplicate ${c.name}`} onClick={() => act(() => api.post(`/characters/${c.id}/duplicate`), `Duplicated ${c.name}.`)}><Copy size={14} /></button>
                        <button className="btn sm ghost icon" title="Export" aria-label={`Export ${c.name}`} onClick={() => download(`/characters/${c.id}/export`)}><Download size={14} /></button>
                        <button className="btn sm ghost icon" title="Delete" aria-label={`Delete ${c.name}`} onClick={() => remove(c)}><Trash2 size={14} /></button>
                      </>
                    )}
                  </div>
                </div>
                <button
                  className={`btn ghost icon sm pin ${c.pinned ? 'pin-on' : ''}`}
                  aria-pressed={c.pinned}
                  aria-label={c.pinned ? `Unpin ${c.name}` : `Pin ${c.name}`}
                  title={c.pinned ? 'Unpin' : 'Pin to home'}
                  onClick={() => act(() => api.patch(`/characters/${c.id}`, { pinned: !c.pinned }))}
                >
                  <Pin size={15} fill={c.pinned ? 'currentColor' : 'none'} />
                </button>
              </article>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
