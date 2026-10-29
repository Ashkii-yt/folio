import { NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { Compass, LogOut, Home as HomeIcon, Settings as SettingsIcon, Users } from 'lucide-react';
import { useApp } from './store.jsx';
import { Avatar, Notice } from './ui.jsx';
import Home from './pages/Home.jsx';
import Library from './pages/Library.jsx';
import Editor from './pages/Editor.jsx';
import Chat from './pages/Chat.jsx';
import MemoryPage from './pages/MemoryPage.jsx';
import Settings from './pages/Settings.jsx';
import AuthScreen from './pages/AuthScreen.jsx';

function Rail() {
  const { characters, auth, signOut } = useApp();
  const loc = useLocation();
  const recent = [...characters].filter((c) => c.lastChatAt).sort((a, b) => b.lastChatAt.localeCompare(a.lastChatAt)).slice(0, 5);
  const link = (to, Icon, label, extra, short) => (
    <NavLink to={to} end={to === '/'} className={({ isActive }) => `rail-link ${isActive ? 'active' : ''}`}>
      <Icon size={17} aria-hidden="true" />
      {short ? <><span className="lbl-long">{label}</span><span className="lbl-short">{short}</span></> : label}
      {extra}
    </NavLink>
  );
  return (
    <nav className="rail" aria-label="Main">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">F</span>
        Folio
      </div>
      {link('/', HomeIcon, 'Home')}
      {link('/browse', Compass, 'Browse characters', null, 'Browse')}
      {link('/mine', Users, 'My characters', characters.length ? <span className="count">{characters.length}</span> : null, 'Mine')}
      {recent.length > 0 && <div className="rail-section">Recent chats</div>}
      {recent.map((c) => (
        <NavLink key={c.id} to={`/chat/${c.id}`} className={`rail-recent ${loc.pathname.startsWith(`/chat/${c.id}`) ? 'active' : ''}`}>
          <Avatar character={c} size={22} />
          <span className="clamp-1 voice" style={{ fontWeight: 560 }}>{c.name}</span>
        </NavLink>
      ))}
      <div className="rail-spacer" />
      {link('/settings', SettingsIcon, 'Settings')}
      {auth?.user && (
        <div className="rail-user">
          <span className="clamp-1" title={auth.user}>{auth.user}</span>
          <button className="btn ghost sm" onClick={signOut} aria-label={`Sign out ${auth.user}`} title="Sign out">
            <LogOut size={15} aria-hidden="true" />
          </button>
        </div>
      )}
    </nav>
  );
}

export default function App() {
  const { ready, fatal, reload, auth } = useApp();
  if (fatal) {
    return (
      <div style={{ maxWidth: 520, margin: '12vh auto', padding: 20 }}>
        <Notice kind="danger" title={fatal.message} action={<button className="btn sm" onClick={reload}>Try again</button>}>
          {fatal.hint}
        </Notice>
      </div>
    );
  }
  if (auth && !auth.user) return <AuthScreen />;
  if (!ready) return <p className="muted" style={{ padding: 24 }} role="status">Loading…</p>;
  return (
    <div className="app">
      <Rail />
      <main className="main">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/browse" element={<Library mode="browse" />} />
          <Route path="/mine" element={<Library mode="mine" />} />
          <Route path="/characters/new" element={<Editor />} />
          <Route path="/characters/:id/edit" element={<Editor />} />
          <Route path="/characters/:id/memory" element={<MemoryPage />} />
          <Route path="/chat/:characterId/:conversationId?" element={<Chat />} />
          <Route path="/settings/:section?" element={<Settings />} />
          <Route path="*" element={<Home />} />
        </Routes>
      </main>
    </div>
  );
}
