import { useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../store.jsx';
import { ErrorNotice, Field, Notice } from '../ui.jsx';

export default function AuthScreen() {
  const { auth, signedIn } = useApp();
  const canRegister = auth.registrationOpen;
  const [mode, setMode] = useState(auth.firstRun ? 'register' : 'login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const register = mode === 'register';

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post(register ? '/auth/register' : '/auth/login', { username, password });
      await signedIn();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <main className="auth">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">F</span>
          Folio
        </div>
        <h1>{register ? 'Create your account' : 'Welcome back'}</h1>
        <p className="muted">
          {register
            ? 'Your characters, chats and memories are kept in a folder of their own, separate from everyone else on this server.'
            : 'Sign in to open your folder.'}
        </p>
        <Field label="Username" htmlFor="a-user" hint={register ? '3–32 characters: letters, numbers, - and _.' : undefined}>
          <input id="a-user" className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={32} required data-autofocus autoFocus />
        </Field>
        <Field label="Password" htmlFor="a-pass" hint={register ? 'At least 8 characters. A short sentence works well.' : undefined}>
          <input id="a-pass" className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={register ? 'new-password' : 'current-password'} required />
        </Field>
        {error && <ErrorNotice error={error} />}
        {register && !canRegister && (
          <Notice kind="warn" title="Sign-ups are closed for this connection">
            This server allows {auth.limitPerIp === 1 ? 'one account' : `${auth.limitPerIp} accounts`} per network address, and this one already has {auth.limitPerIp === 1 ? 'it' : 'them'}. Sign in instead.
          </Notice>
        )}
        <button className="btn primary" type="submit" disabled={busy || !username || !password || (register && !canRegister)}>
          {busy ? 'One moment…' : register ? 'Create account' : 'Sign in'}
        </button>
        {!auth.firstRun && (
          <button type="button" className="btn ghost" onClick={() => { setMode(register ? 'login' : 'register'); setError(null); }}>
            {register ? 'I already have an account' : 'Create a new account'}
          </button>
        )}
      </form>
    </main>
  );
}
