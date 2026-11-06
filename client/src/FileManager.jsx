import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, uploadFile, downloadFile, previewFile } from './api.js';

const formatSize = (b) => {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(b) / Math.log(1024)), u.length - 1);
  return `${(b / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
};

const formatDate = (d) => (d ? new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');

function iconFor(name, type) {
  const ext = name.split('.').pop().toLowerCase();
  if (['pdf'].includes(ext)) return '📕';
  if (['epub', 'mobi', 'azw', 'azw3', 'fb2', 'djvu'].includes(ext)) return '📘';
  if (type.startsWith('image/')) return '🖼️';
  if (type.startsWith('video/')) return '🎬';
  if (type.startsWith('audio/')) return '🎵';
  if (['doc', 'docx', 'odt', 'rtf', 'txt', 'md'].includes(ext)) return '📝';
  if (['xls', 'xlsx', 'csv', 'ods'].includes(ext)) return '📊';
  if (['ppt', 'pptx', 'odp'].includes(ext)) return '📽️';
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return '🗜️';
  return '📄';
}

export default function FileManager({ section }) {
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('date-desc');
  const [uploads, setUploads] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [dragging, setDragging] = useState(false);
  const [busyPath, setBusyPath] = useState(null);
  const inputRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setFiles(await api(`/files?section=${section}`));
      setSelected(new Set());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [section]);

  useEffect(() => {
    load();
  }, [load]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? files.filter((f) => f.name.toLowerCase().includes(q)) : [...files];
    const [key, dir] = sort.split('-');
    const m = dir === 'asc' ? 1 : -1;
    list.sort((a, b) => {
      if (key === 'name') return m * a.name.localeCompare(b.name);
      if (key === 'size') return m * (a.size - b.size);
      return m * (new Date(a.createdAt) - new Date(b.createdAt));
    });
    return list;
  }, [files, query, sort]);

  async function handleFiles(fileList) {
    const items = Array.from(fileList).map((file) => ({
      id: crypto.randomUUID(),
      file,
      progress: 0,
      status: 'uploading',
      error: '',
    }));
    if (!items.length) return;
    setUploads((u) => [...items, ...u]);
    const update = (id, patch) => setUploads((u) => u.map((x) => (x.id === id ? { ...x, ...patch } : x)));

    // Upload up to 3 files at a time
    const queue = [...items];
    const worker = async () => {
      while (queue.length) {
        const it = queue.shift();
        try {
          await uploadFile(section, it.file, (p) => update(it.id, { progress: p }));
          update(it.id, { progress: 1, status: 'done' });
        } catch (e) {
          update(it.id, { status: 'error', error: e.message });
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    load();
    setTimeout(() => setUploads((u) => u.filter((x) => x.status !== 'done')), 4000);
  }

  async function run(path, fn) {
    setBusyPath(path);
    try {
      await fn();
    } catch (e) {
      alert(e.message);
    } finally {
      setBusyPath(null);
    }
  }

  const onDelete = (f) =>
    confirm(`Delete "${f.name}"? This cannot be undone.`) &&
    run(f.path, async () => {
      await api('/files', { method: 'DELETE', body: { path: f.path } });
      setFiles((fs) => fs.filter((x) => x.path !== f.path));
    });

  const onRename = (f) => {
    const name = prompt('New name', f.name);
    if (!name || name === f.name) return;
    run(f.path, async () => {
      await api('/files', { method: 'PATCH', body: { path: f.path, name } });
      await load();
    });
  };

  const deleteSelected = async () => {
    if (!selected.size || !confirm(`Delete ${selected.size} selected file(s)? This cannot be undone.`)) return;
    try {
      await api('/files', { method: 'DELETE', body: { paths: [...selected] } });
      await load();
    } catch (e) {
      alert(e.message);
    }
  };

  const downloadSelected = async () => {
    for (const p of selected) {
      await downloadFile(p).catch((e) => alert(e.message));
      await new Promise((r) => setTimeout(r, 400));
    }
  };

  const toggle = (p) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(p) ? n.delete(p) : n.add(p);
      return n;
    });
  const allChecked = visible.length > 0 && visible.every((f) => selected.has(f.path));
  const toggleAll = () => setSelected(allChecked ? new Set() : new Set(visible.map((f) => f.path)));

  const totalSize = files.reduce((n, f) => n + f.size, 0);

  return (
    <section
      className={`files ${dragging ? 'dragging' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        handleFiles(e.dataTransfer.files);
      }}
    >
      <div className="toolbar">
        <input className="search" placeholder="Search files…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <select value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="date-desc">Newest first</option>
          <option value="date-asc">Oldest first</option>
          <option value="name-asc">Name A–Z</option>
          <option value="name-desc">Name Z–A</option>
          <option value="size-desc">Largest first</option>
          <option value="size-asc">Smallest first</option>
        </select>
        <button className="btn" onClick={load} title="Refresh">
          ⟳
        </button>
        <button className="btn primary" onClick={() => inputRef.current.click()}>
          ⬆ Upload
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            handleFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </div>

      <div className="dropzone" onClick={() => inputRef.current.click()}>
        Drag &amp; drop files here, or click to choose. Files are stored exactly as uploaded (original quality).
      </div>

      {uploads.length > 0 && (
        <ul className="uploads">
          {uploads.map((u) => (
            <li key={u.id} className={u.status}>
              <span className="up-name">{u.file.name}</span>
              <span className="up-size muted">{formatSize(u.file.size)}</span>
              {u.status === 'error' ? (
                <span className="error-text" title={u.error}>
                  ✕ {u.error}
                </span>
              ) : (
                <div className="bar">
                  <div style={{ width: `${Math.round(u.progress * 100)}%` }} />
                </div>
              )}
              {u.status === 'done' && <span className="ok">✓</span>}
              {u.status === 'error' && (
                <button className="btn ghost small" onClick={() => setUploads((x) => x.filter((y) => y.id !== u.id))}>
                  Dismiss
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="summary muted">
        {files.length} file{files.length === 1 ? '' : 's'} · {formatSize(totalSize)}
        {selected.size > 0 && (
          <span className="bulk">
            {selected.size} selected
            <button className="btn small" onClick={downloadSelected}>
              Download
            </button>
            <button className="btn small danger" onClick={deleteSelected}>
              Delete
            </button>
          </span>
        )}
      </div>

      {error && <div className="error">{error}</div>}

      {loading ? (
        <div className="empty muted">Loading…</div>
      ) : visible.length === 0 ? (
        <div className="empty muted">{query ? 'No files match your search.' : 'No files yet. Upload something!'}</div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th className="chk">
                <input type="checkbox" checked={allChecked} onChange={toggleAll} aria-label="Select all" />
              </th>
              <th>Name</th>
              <th className="hide-sm">Size</th>
              <th className="hide-sm">Uploaded</th>
              <th className="actions-col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((f) => (
              <tr key={f.path} className={busyPath === f.path ? 'busy' : ''}>
                <td className="chk">
                  <input type="checkbox" checked={selected.has(f.path)} onChange={() => toggle(f.path)} />
                </td>
                <td>
                  <button className="name-btn" onClick={() => run(f.path, () => previewFile(f.path))} title="Open">
                    <span className="ficon">{iconFor(f.name, f.type)}</span>
                    <span className="fname">{f.name}</span>
                  </button>
                  <div className="show-sm muted small-text">
                    {formatSize(f.size)} · {formatDate(f.createdAt)}
                  </div>
                </td>
                <td className="hide-sm nowrap">{formatSize(f.size)}</td>
                <td className="hide-sm nowrap">{formatDate(f.createdAt)}</td>
                <td className="actions">
                  <button className="btn small" onClick={() => run(f.path, () => downloadFile(f.path))} title="Download">
                    ⬇<span className="hide-sm"> Download</span>
                  </button>
                  <button className="btn small ghost" onClick={() => onRename(f)} title="Rename">
                    ✎
                  </button>
                  <button className="btn small ghost danger" onClick={() => onDelete(f)} title="Delete">
                    🗑
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
