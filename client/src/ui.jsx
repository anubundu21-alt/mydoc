import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import Icon from './Icon.jsx';

export const formatSize = (b) => {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(b) / Math.log(1024)), u.length - 1);
  return `${(b / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
};

export const formatDate = (d) =>
  d ? new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

export function timeAgo(d) {
  if (!d) return 'Never';
  const s = (Date.now() - new Date(d)) / 1000;
  if (s < 60) return 'Just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return formatDate(d);
}

// File type → short label + colour family for the badge.
const TYPES = [
  { exts: ['pdf'], kind: 'pdf' },
  { exts: ['epub', 'mobi', 'azw', 'azw3', 'fb2', 'djvu', 'cbz', 'cbr'], kind: 'ebook' },
  { exts: ['doc', 'docx', 'odt', 'rtf', 'txt', 'md', 'pages'], kind: 'doc' },
  { exts: ['xls', 'xlsx', 'csv', 'ods', 'numbers'], kind: 'sheet' },
  { exts: ['ppt', 'pptx', 'odp', 'key'], kind: 'slides' },
  { exts: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp', 'svg', 'tif', 'tiff'], kind: 'image' },
  { exts: ['mp4', 'mov', 'mkv', 'avi', 'webm'], kind: 'video' },
  { exts: ['mp3', 'wav', 'm4a', 'flac', 'aac', 'ogg'], kind: 'audio' },
  { exts: ['zip', 'rar', '7z', 'tar', 'gz'], kind: 'archive' },
];

export function fileKind(name) {
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  const t = TYPES.find((x) => x.exts.includes(ext));
  return { ext: (ext || 'file').slice(0, 4).toUpperCase(), kind: t?.kind || 'other' };
}

export function FileBadge({ name, large = false }) {
  const { ext, kind } = fileKind(name);
  return (
    <div className={`badge badge-${kind} ${large ? 'badge-lg' : ''}`}>
      <span className="badge-fold" />
      <span className="badge-ext">{ext}</span>
    </div>
  );
}

// ---------- Toasts ----------
const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const push = useCallback((message, type = 'success') => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, message, type }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.type}`}>
            <Icon name={t.type === 'error' ? 'alert' : 'check'} size={16} />
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ---------- Modal ----------
export function Modal({ title, children, onClose, footer }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function ConfirmModal({ title, message, confirmLabel = 'Delete', onConfirm, onClose }) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-danger"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await onConfirm();
              setBusy(false);
            }}
          >
            <Icon name="trash" size={16} /> {busy ? 'Deleting…' : confirmLabel}
          </button>
        </>
      }
    >
      <div className="confirm-row">
        <div className="confirm-icon">
          <Icon name="alert" size={22} />
        </div>
        <p>{message}</p>
      </div>
    </Modal>
  );
}

export function RenameModal({ name, onSave, onClose }) {
  const dot = name.lastIndexOf('.');
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.setSelectionRange(0, dot > 0 ? dot : name.length);
  }, [dot, name.length]);
  const submit = async (e) => {
    e.preventDefault();
    if (!value.trim() || value === name) return onClose();
    setBusy(true);
    await onSave(value.trim());
    setBusy(false);
  };
  return (
    <Modal title="Rename file" onClose={onClose}>
      <form onSubmit={submit} className="rename-form">
        <input ref={ref} className="input" value={value} onChange={(e) => setValue(e.target.value)} />
        <div className="modal-foot inline">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
