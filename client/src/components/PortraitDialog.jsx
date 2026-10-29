import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Sparkles, WandSparkles } from 'lucide-react';
import { api, stream } from '../api.js';
import { Dialog, ErrorNotice } from '../ui.jsx';
import { imageToAvatar } from '../lib.js';

const STYLE_LABEL = { illustration: 'Illustration', painterly: 'Painterly', anime: 'Anime', realistic: 'Realistic photo', fantasy: 'Fantasy art', pixel: 'Pixel art', ink: 'Ink and watercolour' };

/** Draw a portrait for a character with a free image service. Nothing is applied until you press Use. */
export default function PortraitDialog({ character, onUse, onClose }) {
  const [cfg, setCfg] = useState(null);
  const [prompt, setPrompt] = useState((character.description || '').trim());
  const [style, setStyle] = useState('illustration');
  const [count, setCount] = useState(2);
  const [writing, setWriting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [images, setImages] = useState([]);
  const [picked, setPicked] = useState(null);
  const [error, setError] = useState(null);
  const ctl = useRef(null);
  const close = useCallback(() => { ctl.current?.abort(); onClose(); }, [onClose]);

  useEffect(() => {
    api.get('/images/config').then(setCfg).catch(() => {});
    return () => ctl.current?.abort();
  }, []);

  const hasCard = !!(character.name || character.description || character.personality || character.background);

  async function writePrompt() {
    setWriting(true);
    setError(null);
    ctl.current = new AbortController();
    try {
      const { name, description, personality, background, speakingStyle } = character;
      const r = await api.post('/images/prompt', { character: { name, description, personality, background, speakingStyle } }, { signal: ctl.current.signal });
      setPrompt(r.prompt);
    } catch (e) {
      if (e.code !== 'aborted') setError(e);
    }
    setWriting(false);
  }

  async function generate() {
    setBusy(true);
    setError(null);
    setImages([]);
    setPicked(null);
    setProgress({ message: 'Sending to the image service…' });
    ctl.current = new AbortController();
    let got = 0;
    try {
      await stream('/images/portraits', { prompt, style, count }, {
        signal: ctl.current.signal,
        onEvent: (ev, d) => {
          if (ev === 'progress') setProgress(d);
          if (ev === 'image') { got += 1; setImages((x) => [...x, d.dataUrl]); setPicked((p) => (p == null ? 0 : p)); }
          if (ev === 'error') setError(d);
        },
      });
    } catch (e) {
      if (e.code !== 'aborted') setError(e);
    }
    setBusy(false);
    setProgress(null);
  }

  async function use() {
    try {
      const blob = await (await fetch(images[picked])).blob();
      onUse(await imageToAvatar(new File([blob], 'portrait', { type: blob.type })));
    } catch (e) {
      setError(e);
    }
  }

  const provider = cfg?.providers?.find((p) => p.type === cfg.provider);
  return (
    <Dialog
      title="Generate a portrait"
      wide
      onClose={close}
      footer={
        <>
          <button className="btn" onClick={close}>Cancel</button>
          <button className="btn primary" onClick={use} disabled={picked == null || busy}>Use this portrait</button>
        </>
      }
    >
      <div className="stack" style={{ gap: 14 }}>
        <div className="field">
          <div className="label-row">
            <label htmlFor="pg-prompt">What do they look like?</label>
            <button type="button" className="btn sm ghost ai-btn" onClick={writePrompt} disabled={writing || busy || !hasCard} title={hasCard ? 'Uses your text model to turn the card into a visual description' : 'Fill in the card first'}>
              {writing ? <span className="spin" aria-hidden="true" /> : <Sparkles size={13} aria-hidden="true" />} {writing ? 'Writing…' : 'Write from the card'}
            </button>
          </div>
          <textarea id="pg-prompt" className="textarea" rows={4} maxLength={1200} value={prompt} disabled={busy} onChange={(e) => setPrompt(e.target.value)} placeholder="Weathered woman in her fifties, silver braid, wool coat, tired kind eyes, lighthouse behind her" data-autofocus />
          <div className="hint">Describe only what can be seen. Edit it freely.</div>
        </div>
        <div className="fields two">
          <div className="field">
            <label htmlFor="pg-style">Style</label>
            <select id="pg-style" className="select" value={style} disabled={busy} onChange={(e) => setStyle(e.target.value)}>
              {(cfg?.styles || Object.keys(STYLE_LABEL)).map((s) => <option key={s} value={s}>{STYLE_LABEL[s] || s}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="pg-count">Variations</label>
            <select id="pg-count" className="select" value={count} disabled={busy} onChange={(e) => setCount(Number(e.target.value))}>
              {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
        </div>
        <div className="cluster wrap">
          <button className="btn primary" onClick={generate} disabled={busy || !prompt.trim()}>
            {busy ? <span className="spin" aria-hidden="true" /> : <WandSparkles size={15} aria-hidden="true" />} {busy ? 'Drawing…' : images.length ? 'Draw again' : 'Generate'}
          </button>
          {busy && <button className="btn ghost" onClick={() => ctl.current?.abort()}>Cancel</button>}
          {provider && <span className="hint">Using {provider.label}. <Link to="/settings/portraits" onClick={close}>Change</Link></span>}
        </div>
        {busy && progress && (
          <p className="muted" role="status">
            {progress.message}{progress.waitSeconds ? ` · about ${Math.max(1, Math.round(progress.waitSeconds))}s` : ''}
          </p>
        )}
        <ErrorNotice error={error} action={error?.code === 'auth' ? <Link className="btn sm" to="/settings/portraits" onClick={close}>Open portrait settings</Link> : undefined} />
        {images.length > 0 && (
          <div className="pg-grid" role="radiogroup" aria-label="Generated portraits">
            {images.map((src, i) => (
              <button key={i} role="radio" aria-checked={picked === i} className={`pg-img ${picked === i ? 'on' : ''}`} onClick={() => setPicked(i)} aria-label={`Portrait ${i + 1}`}>
                <img src={src} alt="" />
              </button>
            ))}
          </div>
        )}
        {provider && <p className="hint">{provider.note}</p>}
      </div>
    </Dialog>
  );
}
