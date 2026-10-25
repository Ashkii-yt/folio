import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Compass, Plus, Pin, Plug } from 'lucide-react';
import { useApp } from '../store.jsx';
import { api } from '../api.js';
import { Avatar, Empty, Notice, useToast } from '../ui.jsx';
import { timeAgo } from '../lib.js';

function greeting(name) {
  const h = new Date().getHours();
  const part = h < 5 ? 'Late night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  return name ? `${part}, ${name}` : part;
}

export default function Home() {
  const { characters, providers, settings, refreshCharacters } = useApp();
  const nav = useNavigate();
  const toast = useToast();
  const [seeding, setSeeding] = useState(false);

  const recent = [...characters].filter((c) => c.lastChatAt).sort((a, b) => b.lastChatAt.localeCompare(a.lastChatAt)).slice(0, 5);
  const pinned = characters.filter((c) => c.pinned);
  const newest = [...characters].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 4);
  const hasProvider = providers.some((p) => p.enabled);

  async function seed() {
    setSeeding(true);
    try {
      await api.post('/characters/starters');
      await refreshCharacters();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSeeding(false);
    }
  }

  return (
    <div className="page">
      <div className="page-inner">
        <div className="home-intro">
          <h1>{greeting(settings.userName)}</h1>
          <p>{characters.length ? 'Pick up a conversation, or meet someone new.' : 'Create a character, give them a voice, and they will remember you.'}</p>
          <div className="primary-actions">
            <Link to="/characters/new" className="btn primary lg"><Plus size={20} aria-hidden="true" /> Make a character</Link>
            <Link to="/browse" className="btn lg"><Compass size={20} aria-hidden="true" /> Browse characters</Link>
          </div>
        </div>

        {!hasProvider && (
          <Notice
            kind="warn"
            title="No AI model is connected yet"
            action={<Link className="btn sm" to="/settings/providers"><Plug size={14} aria-hidden="true" /> Connect a model</Link>}
          >
            Characters need a model to talk. Folio works with Ollama, OpenAI, Anthropic, Gemini and any OpenAI-compatible server.
          </Notice>
        )}

        {characters.length === 0 && (
          <div className="section">
            <Empty
              title="No characters yet"
              actions={
                <>
                  <Link to="/characters/new" className="btn primary">Make a character</Link>
                  <button className="btn" onClick={seed} disabled={seeding}>{seeding ? 'Adding…' : 'Add four example characters'}</button>
                </>
              }
            >
              Start from scratch, or add a few examples to see how a finished character is put together. Every example can be edited or deleted.
            </Empty>
          </div>
        )}

        {recent.length > 0 && (
          <section className="section" aria-labelledby="h-recent">
            <div className="section-head"><h2 id="h-recent">Continue</h2></div>
            <div className="rows divided">
              {recent.map((c) => (
                <button key={c.id} className="row" onClick={() => nav(`/chat/${c.id}`)}>
                  <Avatar character={c} size={44} />
                  <div className="grow">
                    <div className="name">{c.name}</div>
                    <div className="sub clamp-1">{c.description || 'No description'}</div>
                  </div>
                  <span className="when">{timeAgo(c.lastChatAt)}</span>
                </button>
              ))}
            </div>
          </section>
        )}

        {pinned.length > 0 && (
          <section className="section" aria-labelledby="h-pinned">
            <div className="section-head"><h2 id="h-pinned"><Pin size={14} aria-hidden="true" style={{ verticalAlign: -1, marginRight: 6 }} />Pinned</h2></div>
            <div className="strip">
              {pinned.map((c) => (
                <Link key={c.id} to={`/chat/${c.id}`} className="strip-item">
                  <Avatar character={c} size={56} />
                  <span>{c.name}</span>
                </Link>
              ))}
            </div>
          </section>
        )}

        {characters.length > 0 && (
          <section className="section" aria-labelledby="h-new">
            <div className="section-head">
              <h2 id="h-new">Recently created</h2>
              <Link className="link" to="/mine">All characters</Link>
            </div>
            <div className="rows divided">
              {newest.map((c) => (
                <Link key={c.id} to={`/characters/${c.id}/edit`} className="row">
                  <Avatar character={c} size={36} />
                  <div className="grow">
                    <div className="name">{c.name}</div>
                    <div className="sub clamp-1">{c.description || 'No description'}</div>
                  </div>
                  <span className="when">{timeAgo(c.createdAt)}</span>
                </Link>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
