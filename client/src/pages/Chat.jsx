import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Brain, Check, Copy, Cpu, MessageSquarePlus, PanelLeft, PanelRight, Pencil, RefreshCw, Send, Square, Trash2, X } from 'lucide-react';
import { useApp } from '../store.jsx';
import { api, stream } from '../api.js';
import { Avatar, ErrorNotice, Spinner, Styled, useConfirm, useToast, usePopover, Empty } from '../ui.jsx';
import { clock, dayLabel, timeAgo } from '../lib.js';
import MemoryPanel from '../components/MemoryPanel.jsx';

const booting = new Map(); // characterId -> Promise, so StrictMode's double effect cannot create two chats

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
    return ok;
  }
}

export default function Chat() {
  const { characterId, conversationId } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const { characters, providers, settings, refreshCharacters } = useApp();
  const character = characters.find((c) => c.id === characterId);

  const [convs, setConvs] = useState(null);
  const [conv, setConv] = useState(null); // { id, title, providerId, model, ... }
  const [messages, setMessages] = useState([]);
  const [loadError, setLoadError] = useState(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(null); // streaming reply: { text }
  const [error, setError] = useState(null);
  const [runInfo, setRunInfo] = useState(null); // { provider, model, source } from the latest start event
  const [editing, setEditing] = useState(null); // { id, text }
  const [drawer, setDrawer] = useState(null); // null | 'memory' | 'details'
  const [convsOpen, setConvsOpen] = useState(() => window.matchMedia('(min-width: 1101px)').matches);
  const ctl = useRef(null);
  const scroller = useRef(null);
  const stick = useRef(true);
  const taRef = useRef(null);

  /* ---- bootstrap: pick (or create) a conversation ---- */
  useEffect(() => {
    if (!characterId || !character) return;
    let alive = true;
    (async () => {
      try {
        const list = await api.get(`/characters/${characterId}/conversations`);
        if (!alive) return;
        setConvs(list);
        if (!conversationId) {
          let p = booting.get(characterId);
          if (!p) {
            p = (list.length ? Promise.resolve(list[0].id) : api.post(`/characters/${characterId}/conversations`, {}).then((c) => c.id)).finally(() => setTimeout(() => booting.delete(characterId), 500));
            booting.set(characterId, p);
          }
          const id = await p;
          if (alive) nav(`/chat/${characterId}/${id}`, { replace: true });
        }
      } catch (e) {
        if (alive) setLoadError(e);
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [characterId, conversationId, !!character]);

  const loadConversation = useCallback(async (id) => {
    const c = await api.get(`/conversations/${id}`);
    setConv(c);
    setMessages(c.messages);
    return c;
  }, []);

  useEffect(() => {
    if (!conversationId) return;
    let alive = true;
    ctl.current?.abort();
    setBusy(false);
    setPending(null);
    setError(null);
    setEditing(null);
    setRunInfo(null);
    setConv(null);
    setMessages([]);
    stick.current = true;
    loadConversation(conversationId).catch((e) => alive && setLoadError(e));
    return () => { alive = false; };
  }, [conversationId, loadConversation]);

  useEffect(() => () => ctl.current?.abort(), []);

  const refreshList = useCallback(async () => {
    try { setConvs(await api.get(`/characters/${characterId}/conversations`)); } catch { /* list stays as is */ }
  }, [characterId]);

  /* ---- scrolling ---- */
  const onScroll = () => {
    const el = scroller.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
  };
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages, pending, error]);

  /* ---- composer ---- */
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`;
  }, [text, conversationId]);
  useEffect(() => { if (conv && !busy) taRef.current?.focus(); }, [conv?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- streaming ---- */
  async function run(path, body, { prepare } = {}) {
    setBusy(true);
    setError(null);
    setPending({ text: '' });
    stick.current = true;
    ctl.current = new AbortController();
    let acc = '';
    let aborted = false;
    try {
      await stream(path, body, {
        signal: ctl.current.signal,
        onEvent: (ev, d) => {
          if (ev === 'user_message') {
            setMessages((m) => {
              const base = m.filter((x) => !x.temp);
              const i = base.findIndex((x) => x.id === d.message.id);
              return i >= 0 ? base.map((x, j) => (j === i ? d.message : x)) : [...base, d.message];
            });
            setConv((c) => (c ? { ...c, title: d.title } : c));
          } else if (ev === 'start') setRunInfo({ provider: d.provider, model: d.model, source: d.source });
          else if (ev === 'delta') { acc += d.text; setPending({ text: acc }); }
          else if (ev === 'done') { setMessages((m) => [...m, d.message]); acc = ''; setPending(null); }
          else if (ev === 'error') setError(d);
        },
      });
    } catch (e) {
      setError(e);
      setMessages((m) => m.filter((x) => !x.temp)); // the request never reached the server
    } finally {
      aborted = ctl.current?.signal.aborted;
      ctl.current = null;
      setBusy(false);
      setPending(null);
      // After Stop (or any failure) re-read the truth from the database: partial replies are kept.
      if (aborted) {
        // The server saves the partial reply when it notices the disconnect; give it a moment, then re-check once more.
        await new Promise((r) => setTimeout(r, 450));
        try { await loadConversation(conversationId); } catch { /* ignore */ }
        setTimeout(() => {
          // Only if the user is still looking at this conversation and has not started another reply.
          if (!window.location.pathname.endsWith(conversationId) || ctl.current) return;
          loadConversation(conversationId).catch(() => {});
          refreshList();
        }, 1400);
      } else if (acc) {
        try { await loadConversation(conversationId); } catch { /* ignore */ }
      }
      refreshList();
      refreshCharacters();
    }
  }

  async function send() {
    const t = text.trim();
    if (!t || busy || !conv) return;
    setText('');
    setMessages((m) => [...m, { id: `temp-${Date.now()}`, temp: true, role: 'user', content: t, createdAt: new Date().toISOString() }]);
    await run(`/conversations/${conv.id}/messages`, { content: t });
  }

  async function regenerate() {
    if (busy || !conv) return;
    setMessages((m) => (m[m.length - 1]?.role === 'character' ? m.slice(0, -1) : m));
    await run(`/conversations/${conv.id}/regenerate`, {});
  }

  async function resend(msg, content) {
    if (busy) return;
    const t = content.trim();
    if (!t) return;
    setEditing(null);
    setMessages((m) => {
      const i = m.findIndex((x) => x.id === msg.id);
      return [...m.slice(0, i), { ...msg, content: t, editedAt: new Date().toISOString() }];
    });
    await run(`/messages/${msg.id}/resend`, { content: t });
  }

  async function removeMessage(msg) {
    const ok = await confirm({
      title: 'Delete this message?',
      message: msg.role === 'user'
        ? 'The message is removed from this conversation. Memories already learned from it are kept. You can review them in the memory panel.'
        : 'The reply is removed from this conversation.',
      confirmLabel: 'Delete message',
    });
    if (!ok) return;
    try {
      await api.del(`/messages/${msg.id}`);
      setMessages((m) => m.filter((x) => x.id !== msg.id));
      refreshList();
    } catch (e) {
      toast.error(e.message);
    }
  }

  async function copy(content) {
    toast.info((await copyText(content)) ? 'Copied.' : 'Copy failed. Select the text and copy it manually.');
  }

  /* ---- conversations ---- */
  async function newConversation() {
    try {
      const c = await api.post(`/characters/${characterId}/conversations`, {});
      await refreshList();
      nav(`/chat/${characterId}/${c.id}`);
    } catch (e) {
      toast.error(e.message);
    }
  }

  async function deleteConversation(c) {
    const ok = await confirm({
      title: `Delete “${c.title}”?`,
      message: `This deletes all ${c.messageCount} message${c.messageCount === 1 ? '' : 's'} in this conversation. Memories learned from it stay in ${character.name}'s memory.`,
      confirmLabel: 'Delete conversation',
    });
    if (!ok) return;
    try {
      await api.del(`/conversations/${c.id}`);
      const rest = convs.filter((x) => x.id !== c.id);
      setConvs(rest);
      refreshCharacters();
      if (c.id === conversationId) nav(rest.length ? `/chat/${characterId}/${rest[0].id}` : `/chat/${characterId}`, { replace: true });
    } catch (e) {
      toast.error(e.message);
    }
  }

  const onKeyDown = (e) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    const wantsSend = settings.chat.sendOnEnter ? !e.shiftKey : e.metaKey || e.ctrlKey;
    if (wantsSend) { e.preventDefault(); send(); }
  };

  const lastIdx = messages.length - 1;
  const lastMsg = messages[lastIdx];
  const canRegenerate = !busy && lastMsg && ((lastMsg.role === 'character' && messages.length > 1 && !lastMsg.meta?.greeting) || lastMsg.role === 'user');
  const items = useMemo(() => messages, [messages]);

  if (!character) return <div className="page-inner"><Empty title="Character not found" actions={<Link className="btn" to="/browse">Browse characters</Link>}>It may have been deleted.</Empty></div>;
  if (loadError) return <div className="page-inner"><ErrorNotice error={loadError} action={<button className="btn sm" onClick={() => { setLoadError(null); nav(`/chat/${characterId}`); }}>Try again</button>} /></div>;

  const lastModel = [...messages].reverse().find((m) => m.role === 'character' && m.meta?.provider);
  const chip = runInfo || (lastModel ? { provider: lastModel.meta.provider, model: lastModel.model } : null);
  const needsSetup = error && ['no_provider', 'no_model', 'provider_disabled'].includes(error.code);

  return (
    <div className={`chat ${drawer ? 'with-drawer' : ''}`}>
      <ConversationList
        open={convsOpen}
        convs={convs}
        activeId={conversationId}
        character={character}
        onNew={newConversation}
        onDelete={deleteConversation}
        onClose={() => setConvsOpen(false)}
        onPick={(id) => { nav(`/chat/${characterId}/${id}`); if (window.innerWidth <= 1100) setConvsOpen(false); }}
      />

      <section className="chat-main" aria-label={`Conversation with ${character.name}`}>
        <header className="chat-head">
          <button className="btn ghost icon" aria-label={convsOpen ? 'Hide conversations' : 'Show conversations'} aria-pressed={convsOpen} onClick={() => setConvsOpen((v) => !v)}><PanelLeft size={18} /></button>
          <Avatar character={character} size={36} />
          <div className="grow">
            <div className="who clamp-1">{character.name}</div>
            <TitleEditor conv={conv} onSaved={(title) => { setConv((c) => ({ ...c, title })); refreshList(); }} />
          </div>
          <ModelChip chip={chip} conv={conv} providers={providers} onChanged={(c) => { setConv((x) => ({ ...x, ...c })); setRunInfo(null); }} />
          <button className="btn ghost icon" aria-label="New conversation" title="New conversation" onClick={newConversation}><MessageSquarePlus size={18} /></button>
          <button className="btn ghost icon" aria-label="Memory" title="Memory" aria-pressed={drawer === 'memory'} onClick={() => setDrawer(drawer === 'memory' ? null : 'memory')}><Brain size={18} /></button>
          <button className="btn ghost icon" aria-label="Character details" title="Details" aria-pressed={drawer === 'details'} onClick={() => setDrawer(drawer === 'details' ? null : 'details')}><PanelRight size={18} /></button>
        </header>

        <div className="transcript" ref={scroller} onScroll={onScroll} aria-live="off">
          <div className="transcript-inner">
            {!conv && <Spinner />}
            {conv && messages.length === 0 && !pending && (
              <div className="chat-start">
                <Avatar character={character} size={72} />
                <h2 className="voice" style={{ fontSize: '1.6em', margin: '12px 0 4px' }}>{character.name}</h2>
                <p className="muted">{character.description || 'Say hello to begin.'}</p>
              </div>
            )}
            {items.map((m, i) => {
              const showDay = i === 0 || dayLabel(m.createdAt) !== dayLabel(items[i - 1].createdAt);
              return (
                <Fragment key={m.id}>
                  {showDay && <div className="muted small" style={{ textAlign: 'center', margin: '10px 0 4px' }}>{dayLabel(m.createdAt)}</div>}
                  <Message
                    m={m}
                    character={character}
                    userName={settings.userName}
                    last={i === lastIdx && !pending}
                    editing={editing?.id === m.id ? editing : null}
                    busy={busy}
                    canRegenerate={canRegenerate && i === lastIdx && m.role === 'character'}
                    onEdit={() => setEditing({ id: m.id, text: m.content })}
                    onEditChange={(t) => setEditing((e) => ({ ...e, text: t }))}
                    onEditCancel={() => setEditing(null)}
                    onEditSend={() => resend(m, editing.text)}
                    onCopy={() => copy(m.content)}
                    onDelete={() => removeMessage(m)}
                    onRegenerate={regenerate}
                    onOpenConversation={(id) => nav(`/chat/${characterId}/${id}`)}
                    memoryOn={settings.memory.enabled && character.memoryEnabled}
                    showContext={settings.chat.showContextInspector}
                  />
                </Fragment>
              );
            })}
            {pending && (
              <div className={`msg char pending ${pending.text ? '' : 'waiting'}`} aria-live="polite">
                <Avatar character={character} size={36} />
                <div>
                  <div className="who"><b>{character.name}</b></div>
                  <div className="text">{pending.text ? <Styled text={pending.text} /> : 'is thinking'}</div>
                </div>
              </div>
            )}
          </div>
          {error && (
            <div className="chat-error">
              <ErrorNotice
                error={error}
                action={needsSetup
                  ? <Link className="btn sm" to="/settings/providers">Open settings</Link>
                  : lastMsg?.role === 'user' ? <button className="btn sm" onClick={regenerate} disabled={busy}><RefreshCw size={14} aria-hidden="true" /> Try again</button> : null}
              />
            </div>
          )}
        </div>

        <div className="composer-wrap">
          <div className="composer">
            <div className="composer-box">
              <textarea
                ref={taRef}
                rows={1}
                value={text}
                disabled={!conv}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder={`Message ${character.name}`}
                aria-label={`Message ${character.name}`}
              />
              {busy ? (
                <button className="btn icon" onClick={() => ctl.current?.abort()} aria-label="Stop generating" title="Stop"><Square size={15} fill="currentColor" /></button>
              ) : (
                <button className="btn primary icon" onClick={send} disabled={!text.trim() || !conv} aria-label="Send message" title="Send"><Send size={15} /></button>
              )}
            </div>
            <div className="foot">
              <span>{settings.chat.sendOnEnter ? 'Enter to send, Shift+Enter for a new line' : 'Ctrl+Enter to send, Enter for a new line'}</span>
              {character.memoryEnabled && settings.memory.enabled ? <span>Memory on</span> : <span>Memory off for this chat</span>}
            </div>
          </div>
        </div>
      </section>

      {drawer && (
        <aside className="drawer" aria-label={drawer === 'memory' ? 'Memory' : 'Character details'}>
          <div className="tabs" role="tablist">
            <button role="tab" className="tab" aria-selected={drawer === 'memory'} onClick={() => setDrawer('memory')}>Memory</button>
            <button role="tab" className="tab" aria-selected={drawer === 'details'} onClick={() => setDrawer('details')}>Details</button>
            <span className="grow" />
            <button className="btn ghost icon sm" style={{ alignSelf: 'center' }} aria-label="Close panel" onClick={() => setDrawer(null)}><X size={16} /></button>
          </div>
          <div className="pane">
            {drawer === 'memory' ? (
              <MemoryPanel character={character} conversationId={conversationId} onOpenConversation={(id) => nav(`/chat/${characterId}/${id}`)} compact />
            ) : (
              <Details character={character} onChanged={refreshCharacters} conv={conv} />
            )}
          </div>
        </aside>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ pieces */

function Message({ m, character, userName, last, editing, busy, canRegenerate, onEdit, onEditChange, onEditCancel, onEditSend, onCopy, onDelete, onRegenerate, onOpenConversation, memoryOn, showContext }) {
  const isUser = m.role === 'user';
  const [showCtx, setShowCtx] = useState(false);
  const ctx = m.meta?.context;
  const nMem = ctx?.memories?.length || 0;
  const nEx = ctx?.excerpts?.length || 0;

  return (
    <div className={`msg ${isUser ? 'user' : 'char'} ${last ? 'last' : ''}`}>
      {!isUser && <Avatar character={character} size={36} />}
      <div style={{ minWidth: 0 }}>
        <div className="who">
          <b>{isUser ? userName || 'You' : character.name}</b>
          <time dateTime={m.createdAt}>{clock(m.createdAt)}{m.editedAt ? ' · edited' : ''}</time>
        </div>
        {editing ? (
          <div className="msg-edit">
            <textarea className="textarea" autoFocus rows={3} value={editing.text} onChange={(e) => onEditChange(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') onEditCancel(); if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onEditSend(); } }} aria-label="Edit your message" />
            <div className="cluster">
              <button className="btn primary sm" onClick={onEditSend} disabled={!editing.text.trim() || busy}><Check size={14} aria-hidden="true" /> Save and resend</button>
              <button className="btn sm" onClick={onEditCancel}>Cancel</button>
              <span className="hint">Replies after this message are replaced.</span>
            </div>
          </div>
        ) : (
          <div className="text"><Styled text={m.content} /></div>
        )}
        {m.meta?.stopped && <div className="flag">Stopped before it finished.</div>}
        {m.meta?.truncated && <div className="flag">Cut off by the model's output limit. Raise “Max output tokens” in the provider settings.</div>}
        {!editing && !m.temp && (
          <div className="tools">
            <button className="btn ghost icon sm" aria-label="Copy message" title="Copy" onClick={onCopy}><Copy size={14} /></button>
            {isUser && <button className="btn ghost icon sm" aria-label="Edit and resend" title="Edit and resend" onClick={onEdit} disabled={busy}><Pencil size={14} /></button>}
            {canRegenerate && <button className="btn ghost icon sm" aria-label="Regenerate reply" title="Regenerate" onClick={onRegenerate}><RefreshCw size={14} /></button>}
            <button className="btn ghost icon sm" aria-label="Delete message" title="Delete" onClick={onDelete} disabled={busy}><Trash2 size={14} /></button>
            {!isUser && showContext && memoryOn && ctx && (nMem > 0 || nEx > 0 || ctx.summaryUsed) && (
              <button className="recall" aria-expanded={showCtx} onClick={() => setShowCtx((v) => !v)}>
                <Brain size={13} aria-hidden="true" />
                Recalled {nMem} memor{nMem === 1 ? 'y' : 'ies'}{nEx ? ` and ${nEx} past exchange${nEx === 1 ? '' : 's'}` : ''}
              </button>
            )}
          </div>
        )}
        {showCtx && ctx && (
          <div className="recall-box">
            {nMem > 0 && (<><h4>Memories in the prompt</h4><ul>{ctx.memories.map((x) => <li key={x.id}>{x.content}{x.pinned ? ' (pinned)' : ''}</li>)}</ul></>)}
            {nEx > 0 && (<><h4>Earlier conversations quoted</h4><ul>{ctx.excerpts.map((x) => <li key={x.conversationId + x.messageIds[0]}><button className="btn ghost sm" style={{ height: 'auto', padding: '0 2px', textDecoration: 'underline' }} onClick={() => onOpenConversation(x.conversationId)}>{x.title}</button>: “{x.preview}”</li>)}</ul></>)}
            {ctx.summaryUsed && <p>A summary stood in for {ctx.olderMessagesNotShownVerbatim} older message{ctx.olderMessagesNotShownVerbatim === 1 ? '' : 's'} of this conversation. The originals are still saved.</p>}
            {ctx.warnings?.length > 0 && <p>{ctx.warnings.join(' ')}</p>}
            <p className="muted">About {ctx.budget.estimatedPrompt.toLocaleString('en-US')} of {ctx.budget.contextLimit.toLocaleString('en-US')} tokens used.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function ConversationList({ open, convs, activeId, character, onNew, onDelete, onPick, onClose }) {
  return (
    <nav className={`convs ${open ? '' : 'closed'}`} aria-label="Conversations">
      <div className="convs-head cluster">
        <button className="btn primary sm grow" onClick={onNew}><MessageSquarePlus size={15} aria-hidden="true" /> New conversation</button>
        <button className="btn ghost icon sm" aria-label="Hide conversations" onClick={onClose}><X size={15} /></button>
      </div>
      <div className="convs-list">
        {!convs && <Spinner />}
        {convs?.map((c) => (
          <div key={c.id} className={`conv ${c.id === activeId ? 'active' : ''}`} onClick={() => onPick(c.id)}>
            <div className="grow">
              <a href={`/chat/${character.id}/${c.id}`} className="t clamp-2" style={{ display: 'block' }} onClick={(e) => { e.preventDefault(); e.stopPropagation(); onPick(c.id); }} aria-current={c.id === activeId ? 'true' : undefined}>{c.title}</a>
              <div className="m">{c.messageCount} message{c.messageCount === 1 ? '' : 's'} · {timeAgo(c.updatedAt)}</div>
            </div>
            <button className="btn ghost icon sm del" aria-label={`Delete conversation ${c.title}`} onClick={(e) => { e.stopPropagation(); onDelete(c); }}><Trash2 size={13} /></button>
          </div>
        ))}
      </div>
    </nav>
  );
}

function TitleEditor({ conv, onSaved }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState('');
  if (!conv) return <div className="muted small">&nbsp;</div>;
  const commit = async () => {
    setEditing(false);
    const t = v.trim();
    if (!t || t === conv.title) return;
    try { await api.patch(`/conversations/${conv.id}`, { title: t }); onSaved(t); } catch (e) { toast.error(e.message); }
  };
  return editing ? (
    <input className="input sm" autoFocus value={v} maxLength={120} aria-label="Conversation title" onChange={(e) => setV(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setEditing(false); }} />
  ) : (
    <button className="btn ghost sm" style={{ height: 'auto', padding: '0 2px', margin: '0 -2px', color: 'var(--ink-3)', fontWeight: 450, display: 'block', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', justifyContent: 'flex-start' }} title="Rename conversation" onClick={() => { setV(conv.title); setEditing(true); }}>{conv.title}</button>
  );
}

function ModelChip({ chip, conv, providers, onChanged }) {
  const { open, setOpen, ref } = usePopover();
  const toast = useToast();
  const [pid, setPid] = useState('');
  const [model, setModel] = useState('');
  const [models, setModels] = useState([]);

  useEffect(() => { if (open && conv) { setPid(conv.providerId || ''); setModel(conv.model || ''); } }, [open, conv]);
  useEffect(() => {
    setModels([]);
    if (!open || !pid) return;
    let alive = true;
    api.get(`/providers/${pid}/models`).then((r) => alive && r.ok && setModels(r.models.map((m) => m.id))).catch(() => {});
    return () => { alive = false; };
  }, [open, pid]);

  const save = async (clear = false) => {
    try {
      const body = clear ? { providerId: null, model: '' } : { providerId: pid || null, model: pid ? model.trim() : '' };
      await api.patch(`/conversations/${conv.id}`, body);
      onChanged({ providerId: body.providerId, model: body.model });
      setOpen(false);
      toast.info(clear ? 'This chat uses the default model again.' : 'Model changed for this chat.');
    } catch (e) { toast.error(e.message); }
  };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button className="chip" onClick={() => setOpen(!open)} aria-expanded={open} title="Model for this conversation" disabled={!conv}>
        <Cpu size={13} aria-hidden="true" />
        <span className="clamp-1" style={{ maxWidth: 190 }}>{chip ? `${chip.provider} · ${chip.model}` : 'Choose model'}</span>
      </button>
      {open && (
        <div className="popover" style={{ right: 0, top: 'calc(100% + 6px)', width: 320 }} role="dialog" aria-label="Model for this conversation">
          <div className="stack" style={{ gap: 10 }}>
            <p className="hint">Override the model for this conversation only. Messages and recalled memories go to the provider you choose here.</p>
            <div className="field">
              <label htmlFor="mc-p">Provider</label>
              <select id="mc-p" className="select" value={pid} onChange={(e) => { setPid(e.target.value); setModel(''); }}>
                <option value="">Use the character or default provider</option>
                {providers.filter((p) => p.enabled).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="mc-m">Model</label>
              <input id="mc-m" className="input" list="mc-models" value={model} disabled={!pid} onChange={(e) => setModel(e.target.value)} placeholder="Provider default" />
              <datalist id="mc-models">{models.map((m) => <option key={m} value={m} />)}</datalist>
            </div>
            <div className="cluster" style={{ justifyContent: 'space-between' }}>
              <button className="btn sm ghost" onClick={() => save(true)}>Reset</button>
              <button className="btn sm primary" onClick={() => save(false)}>Apply</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Details({ character, onChanged, conv }) {
  const toast = useToast();
  const patch = async (p) => {
    try { await api.patch(`/characters/${character.id}`, p); await onChanged(); } catch (e) { toast.error(e.message); }
  };
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="cluster" style={{ alignItems: 'flex-start', gap: 12 }}>
        <Avatar character={character} size={56} />
        <div>
          <div className="voice" style={{ fontSize: '1.3em', fontWeight: 600 }}>{character.name}</div>
          <p className="muted">{character.description}</p>
        </div>
      </div>
      {character.personality && <div><div className="small muted" style={{ fontWeight: 600 }}>Personality</div><p className="voice" style={{ whiteSpace: 'pre-wrap' }}>{character.personality}</p></div>}
      {character.goals && <div><div className="small muted" style={{ fontWeight: 600 }}>Goals</div><p className="voice" style={{ whiteSpace: 'pre-wrap' }}>{character.goals}</p></div>}
      <div>
        <div className="switch">
          <div className="grow"><div>Remember across conversations</div></div>
          <span className="toggle"><input type="checkbox" role="switch" aria-label="Remember across conversations" checked={character.memoryEnabled} onChange={(e) => patch({ memoryEnabled: e.target.checked })} /><span /></span>
        </div>
      </div>
      <div className="stat-grid">
        <div className="stat"><b>{character.conversationCount}</b><span>conversations</span></div>
        <div className="stat"><b>{character.messageCount}</b><span>messages</span></div>
        <div className="stat"><b>{character.memoryCount}</b><span>memories</span></div>
      </div>
      <div className="cluster wrap">
        <Link className="btn sm" to={`/characters/${character.id}/edit`}><Pencil size={14} aria-hidden="true" /> Edit character</Link>
        <Link className="btn sm" to={`/characters/${character.id}/memory`}><Brain size={14} aria-hidden="true" /> Full memory page</Link>
      </div>
      {conv && <p className="hint">This conversation started {timeAgo(conv.createdAt)}.</p>}
    </div>
  );
}
