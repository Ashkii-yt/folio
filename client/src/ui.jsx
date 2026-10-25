import { Fragment, createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import { hueFor } from './lib.js';

/* ------------------------------------------------------------------ avatar */
export function Avatar({ character, size = 40, className = '' }) {
  const name = character?.name || '?';
  const letter = [...name.trim()][0]?.toUpperCase() || '?';
  return (
    <span className={`avatar ${className}`} style={{ '--s': `${size}px`, '--h': hueFor(name) }} aria-hidden="true">
      {character?.hasAvatar ? (
        <img src={`/api/characters/${character.id}/avatar?v=${encodeURIComponent(character.avatarVersion || '')}`} alt="" loading="lazy" />
      ) : (
        letter
      )}
    </span>
  );
}

/* ------------------------------------------------------------------ toasts */
const ToastCtx = createContext(null);
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const push = useCallback((message, { kind = 'info', action, ms } = {}) => {
    const id = Math.random().toString(36).slice(2);
    setItems((x) => [...x, { id, message, kind, action }]);
    setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), ms ?? (kind === 'error' ? 8000 : 3500));
  }, []);
  const api = useRef({
    info: (m, o) => push(m, o),
    error: (m, o) => push(m, { ...o, kind: 'error' }),
  });
  api.current.info = (m, o) => push(m, o);
  api.current.error = (m, o) => push(m, { ...o, kind: 'error' });
  return (
    <ToastCtx.Provider value={api.current}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            <span className="grow">{t.message}</span>
            {t.action && <button onClick={() => { t.action.run(); setItems((x) => x.filter((i) => i.id !== t.id)); }}>{t.action.label}</button>}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/* ------------------------------------------------------------------ dialog */
export function Dialog({ title, onClose, children, footer, wide = false, labelledBy }) {
  const ref = useRef(null);
  const id = useId();
  useEffect(() => {
    const prev = document.activeElement;
    const el = ref.current;
    const focusable = () => [...el.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((n) => !n.disabled);
    (el.querySelector('[data-autofocus]') || focusable()[0] || el).focus();
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose?.();
      } else if (e.key === 'Tab') {
        const f = focusable();
        if (!f.length) return;
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      prev?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`dialog ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={labelledBy || id} ref={ref} tabIndex={-1}>
        <h2 id={id}>{title}</h2>
        <div className="body">{children}</div>
        {footer && <div className="foot">{footer}</div>}
      </div>
    </div>
  );
}

/** Promise-based confirmation so destructive actions read as one line of code at the call site. */
const ConfirmCtx = createContext(null);
export const useConfirm = () => useContext(ConfirmCtx);

export function ConfirmProvider({ children }) {
  const [state, setState] = useState(null);
  const [typed, setTyped] = useState('');
  const confirm = useCallback(
    (opts) => new Promise((resolve) => { setTyped(''); setState({ ...opts, resolve }); }),
    []
  );
  const close = (v) => { state.resolve(v); setState(null); };
  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      {state && (
        <Dialog
          title={state.title}
          onClose={() => close(false)}
          footer={
            <>
              <button className="btn" onClick={() => close(false)} data-autofocus={state.require ? undefined : true}>{state.cancelLabel || 'Cancel'}</button>
              <button className={`btn ${state.danger === false ? 'primary' : 'danger solid'}`} disabled={state.require && typed !== state.require} onClick={() => close(true)}>
                {state.confirmLabel || 'Delete'}
              </button>
            </>
          }
        >
          <div className="stack" style={{ gap: 12 }}>
            <div>{state.message}</div>
            {state.require && (
              <div className="field">
                <label htmlFor="confirm-typed">Type <b>{state.require}</b> to confirm</label>
                <input id="confirm-typed" className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" data-autofocus />
              </div>
            )}
          </div>
        </Dialog>
      )}
    </ConfirmCtx.Provider>
  );
}

/* ------------------------------------------------------------------ small pieces */
export function Field({ label, hint, error, children, htmlFor }) {
  return (
    <div className="field">
      {label && <label htmlFor={htmlFor}>{label}</label>}
      {children}
      {error ? <div className="field-error" role="alert">{error}</div> : hint ? <div className="hint">{hint}</div> : null}
    </div>
  );
}

export function Toggle({ checked, onChange, label, hint, disabled }) {
  const id = useId();
  return (
    <div className="switch">
      <div className="grow">
        <div id={`${id}-l`}>{label}</div>
        {hint && <div className="hint">{hint}</div>}
      </div>
      <span className="toggle">
        <input type="checkbox" role="switch" aria-labelledby={`${id}-l`} checked={!!checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        <span />
      </span>
    </div>
  );
}

export function Notice({ kind = 'info', title, children, action }) {
  const Icon = kind === 'warn' ? AlertTriangle : kind === 'danger' ? AlertTriangle : kind === 'ok' ? CheckCircle2 : Info;
  return (
    <div className={`notice ${kind}`} role={kind === 'danger' ? 'alert' : undefined}>
      <Icon size={18} />
      <div className="grow">
        {title && <div>{title}</div>}
        {children && <div style={{ fontWeight: 400 }}>{children}</div>}
      </div>
      {action}
    </div>
  );
}

export function ErrorNotice({ error, action }) {
  if (!error) return null;
  return (
    <Notice kind="danger" title={error.message} action={action}>
      {error.hint}
    </Notice>
  );
}

export function Empty({ title, children, actions }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      <div>{children}</div>
      {actions && <div className="cluster wrap">{actions}</div>}
    </div>
  );
}

export function Spinner({ label = 'Loading' }) {
  return <p className="muted" role="status" style={{ padding: 20 }}>{label}…</p>;
}

/** Closes a popover on outside click or Escape. */
export function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const down = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    const key = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key);
    };
  }, [open]);
  return { open, setOpen, ref };
}

export { X as CloseIcon };

/** *asterisk actions* render as italics; everything else is shown verbatim. */
export function Styled({ text }) {
  return String(text).split(/(\*[^*\n]+\*)/g).map((p, i) => (/^\*[^*\n]+\*$/.test(p) ? <em key={i}>{p.slice(1, -1)}</em> : <Fragment key={i}>{p}</Fragment>));
}
