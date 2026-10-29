import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from './api.js';

const Ctx = createContext(null);
export const useApp = () => useContext(Ctx);

function resolveTheme(pref) {
  if (pref === 'light' || pref === 'dark') return pref;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function AppProvider({ children }) {
  const [boot, setBoot] = useState(null); // { settings, providers, providerTypes, categories, version, data }
  const [characters, setCharacters] = useState(null);
  const [fatal, setFatal] = useState(null);
  const [auth, setAuth] = useState(null); // null = checking; { user, registrationOpen, firstRun, limitPerIp }

  const reload = useCallback(async () => {
    try {
      const [b, c] = await Promise.all([api.get('/bootstrap'), api.get('/characters')]);
      setBoot(b);
      setCharacters(c);
      setFatal(null);
    } catch (e) {
      setFatal(e);
    }
  }, []);


  const checkSession = useCallback(async () => {
    try {
      const a = await api.get('/auth/session');
      setAuth(a);
      setFatal(null);
      return a;
    } catch (e) {
      setFatal(e);
      return null;
    }
  }, []);

  const signedIn = useCallback(async () => {
    const a = await checkSession();
    if (a?.user) await reload();
  }, [checkSession, reload]);

  const signOut = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } catch {
      /* ignore */
    }
    setBoot(null);
    setCharacters(null);
    await checkSession();
  }, [checkSession]);

  const refreshCharacters = useCallback(async () => setCharacters(await api.get('/characters')), []);
  const refreshProviders = useCallback(async () => {
    const [providers, settings] = await Promise.all([api.get('/providers'), api.get('/settings')]);
    setBoot((b) => ({ ...b, providers, settings }));
  }, []);
  const refreshData = useCallback(async () => {
    const data = await api.get('/data/info');
    setBoot((b) => ({ ...b, data }));
  }, []);

  const saveSettings = useCallback(async (patch) => {
    const settings = await api.put('/settings', patch);
    setBoot((b) => ({ ...b, settings }));
    return settings;
  }, []);

  useEffect(() => {
    signedIn();
  }, [signedIn]);

  useEffect(() => {
    const out = () => {
      setBoot(null);
      setCharacters(null);
      checkSession();
    };
    window.addEventListener('folio:signed-out', out);
    return () => window.removeEventListener('folio:signed-out', out);
  }, [checkSession]);

  // Theme: the server setting is the source of truth; localStorage only prevents a flash on load.
  const pref = boot?.settings?.theme;
  useEffect(() => {
    if (!pref) return;
    const apply = () => {
      document.documentElement.dataset.theme = resolveTheme(pref);
    };
    apply();
    try {
      localStorage.setItem('folio.theme', pref);
    } catch {
      /* storage unavailable */
    }
    if (pref !== 'system') return;
    const mq = matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [pref]);

  const size = boot?.settings?.chat?.textSize;
  useEffect(() => {
    document.documentElement.style.setProperty('--text-scale', size === 'small' ? '0.93' : size === 'large' ? '1.1' : '1');
  }, [size]);

  const value = useMemo(
    () => ({
      auth,
      signedIn,
      signOut,
      checkSession,
      ready: !!boot && !!characters,
      fatal,
      reload,
      settings: boot?.settings,
      providers: boot?.providers || [],
      providerTypes: boot?.providerTypes || [],
      categories: boot?.categories || [],
      version: boot?.version,
      dataInfo: boot?.data,
      characters: characters || [],
      refreshCharacters,
      refreshProviders,
      refreshData,
      saveSettings,
    }),
    [auth, signedIn, signOut, checkSession, boot, characters, fatal, reload, refreshCharacters, refreshProviders, refreshData, saveSettings]
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
