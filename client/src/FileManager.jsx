import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, uploadFile, uploadThumb, fileUrl, downloadFile, previewFile } from './api.js';
import Icon from './Icon.jsx';
import { ConfirmModal, FileBadge, RenameModal, fileKind, formatDate, formatSize, timeAgo, useToast } from './ui.jsx';
import { canMakeThumb, makeThumb, thumbKind } from './thumbs.js';

// Files we already tried to make a cover for in this browser session (so failures aren't retried).
const thumbTried = new Set();

// The book cover / photo when there is one, otherwise the coloured file-type badge.
function Cover({ file, url, size }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  if (!url || failed) return <FileBadge name={file.name} large={size === 'lg'} />;
  const photo = thumbKind(file.name, file.type) === 'image';
  return (
    <img
      className={`cover cover-${size} ${photo ? 'cover-photo' : ''}`}
      src={url}
      alt=""
      loading="lazy"
      draggable="false"
      onError={() => setFailed(true)}
    />
  );
}

const SORTS = {
  'date-desc': 'Newest first',
  'date-asc': 'Oldest first',
  'name-asc': 'Name (A–Z)',
  'name-desc': 'Name (Z–A)',
  'size-desc': 'Largest first',
  'size-asc': 'Smallest first',
};

function readPref(key, fallback) {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

export default function FileManager({ section, stats, onChanged }) {
  const toast = useToast();
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState(() => readPref('mydoc_sort', 'date-desc'));
  const [view, setView] = useState(() => readPref('mydoc_view', 'grid'));
  const [uploads, setUploads] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [dragging, setDragging] = useState(false);
  const [busyPath, setBusyPath] = useState(null);
  const [confirm, setConfirm] = useState(null); // { title, message, onConfirm }
  const [renaming, setRenaming] = useState(null);
  const [localThumbs, setLocalThumbs] = useState({}); // path → object URL of a cover made in this tab
  const thumbOf = (f) => localThumbs[f.path] || f.thumbUrl;
  const inputRef = useRef(null);
  const dragDepth = useRef(0);

  useEffect(() => {
    try {
      localStorage.setItem('mydoc_sort', sort);
      localStorage.setItem('mydoc_view', view);
    } catch {}
  }, [sort, view]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setFiles(await api(`/files?section=${section.id}`));
      setSelected(new Set());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [section.id]);

  useEffect(() => {
    load();
  }, [load]);

  // Make covers for files uploaded before covers existed (one at a time, in the background).
  useEffect(() => {
    let cancelled = false;
    const todo = files.filter((f) => !f.thumbUrl && !thumbTried.has(f.path) && canMakeThumb(f));
    (async () => {
      for (const f of todo) {
        if (cancelled) return;
        thumbTried.add(f.path);
        try {
          const blob = await makeThumb(await fileUrl(f.path), f.name, f.type);
          if (!blob) continue;
          await uploadThumb(f.path, blob);
          setLocalThumbs((t) => ({ ...t, [f.path]: URL.createObjectURL(blob) }));
        } catch (e) {
          console.warn('Cover not saved for', f.name, e);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [files]);

  const refresh = async () => {
    await load();
    onChanged?.();
  };

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? files.filter((f) => f.name.toLowerCase().includes(q)) : [...files];
    const [key, dir] = sort.split('-');
    const m = dir === 'asc' ? 1 : -1;
    list.sort((a, b) => {
      if (key === 'name') return m * a.name.localeCompare(b.name, undefined, { numeric: true });
      if (key === 'size') return m * (a.size - b.size);
      return m * (new Date(a.createdAt) - new Date(b.createdAt));
    });
    return list;
  }, [files, query, sort]);

  async function handleFiles(fileList) {
    const items = Array.from(fileList).map((file) => ({
      id: Math.random().toString(36).slice(2),
      file,
      progress: 0,
      status: 'uploading',
      error: '',
    }));
    if (!items.length) return;
    setUploads((u) => [...items, ...u]);
    const update = (id, patch) => setUploads((u) => u.map((x) => (x.id === id ? { ...x, ...patch } : x)));

    const queue = [...items];
    let ok = 0;
    const worker = async () => {
      while (queue.length) {
        const it = queue.shift();
        try {
          const path = await uploadFile(section.id, it.file, (p) => update(it.id, { progress: p }));
          update(it.id, { progress: 1, status: 'done' });
          ok++;
          // Cover from the local copy: no need to download the file again.
          const blob = await makeThumb(it.file, it.file.name, it.file.type);
          if (blob) {
            thumbTried.add(path);
            await uploadThumb(path, blob).catch((e) => console.warn('Cover not saved for', it.file.name, e));
            setLocalThumbs((t) => ({ ...t, [path]: URL.createObjectURL(blob) }));
          }
        } catch (e) {
          update(it.id, { status: 'error', error: e.message });
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    if (ok) toast(`${ok} file${ok === 1 ? '' : 's'} uploaded to ${section.label}`);
    if (ok < items.length) toast(`${items.length - ok} upload${items.length - ok === 1 ? '' : 's'} failed`, 'error');
    refresh();
    setTimeout(() => setUploads((u) => u.filter((x) => x.status !== 'done')), 3000);
  }

  async function run(path, fn) {
    setBusyPath(path);
    try {
      await fn();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusyPath(null);
    }
  }

  const askDelete = (paths, label) =>
    setConfirm({
      title: paths.length > 1 ? `Delete ${paths.length} files?` : 'Delete file?',
      message: (
        <>
          <strong>{label}</strong> will be permanently removed from your vault. This cannot be undone.
        </>
      ),
      onConfirm: async () => {
        try {
          await api('/files', { method: 'DELETE', body: { paths } });
          toast(paths.length > 1 ? `${paths.length} files deleted` : 'File deleted');
          setConfirm(null);
          refresh();
        } catch (e) {
          toast(e.message, 'error');
        }
      },
    });

  const saveRename = async (name) => {
    try {
      await api('/files', { method: 'PATCH', body: { path: renaming.path, name } });
      toast('File renamed');
      setRenaming(null);
      load();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const downloadSelected = async () => {
    for (const p of selected) {
      await downloadFile(p).catch((e) => toast(e.message, 'error'));
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

  const count = stats?.count ?? files.length;
  const size = stats?.size ?? files.reduce((n, f) => n + f.size, 0);
  const last = stats?.lastUpload ?? files[0]?.createdAt;

  const actions = (f) => (
    <>
      <button className="icon-btn" title="Preview" onClick={() => run(f.path, () => previewFile(f.path))}>
        <Icon name="eye" size={17} />
      </button>
      <button className="icon-btn" title="Download" onClick={() => run(f.path, () => downloadFile(f.path))}>
        <Icon name="download" size={17} />
      </button>
      <button className="icon-btn" title="Rename" onClick={() => setRenaming(f)}>
        <Icon name="edit" size={17} />
      </button>
      <button className="icon-btn danger" title="Delete" onClick={() => askDelete([f.path], f.name)}>
        <Icon name="trash" size={17} />
      </button>
    </>
  );

  return (
    <div
      className="page"
      onDragEnter={(e) => {
        e.preventDefault();
        dragDepth.current++;
        setDragging(true);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={() => {
        dragDepth.current--;
        if (dragDepth.current <= 0) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        handleFiles(e.dataTransfer.files);
      }}
    >
      <header className={`page-head tone-${section.tone}`}>
        <div className="page-title">
          {section.icon ? (
            <span className={`head-icon tone-${section.tone}`}>
              <Icon name={section.icon} size={24} />
            </span>
          ) : (
            <span className={`avatar xl tone-${section.tone}`}>{section.initials}</span>
          )}
          <div>
            <div className="eyebrow">{section.group}</div>
            <h1>{section.title}</h1>
            <p className="muted">{section.subtitle}</p>
          </div>
        </div>
        <button className="btn btn-primary btn-lg" onClick={() => inputRef.current.click()}>
          <Icon name="upload" size={18} /> Upload files
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
      </header>

      <div className="stats">
        <div className="stat">
          <span className={`stat-icon tone-${section.tone}`}>
            <Icon name="file" size={18} />
          </span>
          <div>
            <div className="stat-value">{count}</div>
            <div className="stat-label">Files</div>
          </div>
        </div>
        <div className="stat">
          <span className="stat-icon tone-teal">
            <Icon name="database" size={18} />
          </span>
          <div>
            <div className="stat-value">{formatSize(size)}</div>
            <div className="stat-label">Storage used</div>
          </div>
        </div>
        <div className="stat">
          <span className="stat-icon tone-violet">
            <Icon name="clock" size={18} />
          </span>
          <div>
            <div className="stat-value">{timeAgo(last)}</div>
            <div className="stat-label">Last upload</div>
          </div>
        </div>
      </div>

      <div className="dropzone" onClick={() => inputRef.current.click()}>
        <span className="drop-icon">
          <Icon name="cloud" size={22} />
        </span>
        <div>
          <div className="drop-title">
            Drop files here or <span className="link">browse</span>
          </div>
          <div className="drop-sub">PDF, EPUB, images, documents and more. Stored in original quality.</div>
        </div>
      </div>

      {uploads.length > 0 && (
        <div className="panel uploads">
          {uploads.map((u) => (
            <div key={u.id} className={`upload-row ${u.status}`}>
              <FileBadge name={u.file.name} />
              <div className="upload-main">
                <div className="upload-top">
                  <span className="truncate">{u.file.name}</span>
                  <span className="muted small">
                    {u.status === 'error'
                      ? 'Failed'
                      : u.status === 'done'
                        ? 'Done'
                        : `${Math.round(u.progress * 100)}% · ${formatSize(u.file.size)}`}
                  </span>
                </div>
                {u.status === 'error' ? (
                  <div className="error-text small">{u.error}</div>
                ) : (
                  <div className="progress">
                    <div style={{ width: `${Math.round(u.progress * 100)}%` }} />
                  </div>
                )}
              </div>
              {u.status === 'done' && (
                <span className="done-check">
                  <Icon name="check" size={16} />
                </span>
              )}
              {u.status === 'error' && (
                <button className="icon-btn" onClick={() => setUploads((x) => x.filter((y) => y.id !== u.id))}>
                  <Icon name="x" size={16} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="toolbar">
        <div className="search">
          <Icon name="search" size={17} />
          <input
            className="input"
            placeholder={`Search in ${section.label}…`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button className="input-action" onClick={() => setQuery('')} aria-label="Clear search">
              <Icon name="x" size={15} />
            </button>
          )}
        </div>
        <select className="input select" value={sort} onChange={(e) => setSort(e.target.value)}>
          {Object.entries(SORTS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <div className="segmented" role="group" aria-label="View">
          <button className={view === 'grid' ? 'on' : ''} onClick={() => setView('grid')} title="Grid view">
            <Icon name="grid" size={16} />
          </button>
          <button className={view === 'list' ? 'on' : ''} onClick={() => setView('list')} title="List view">
            <Icon name="list" size={16} />
          </button>
        </div>
        <button className="icon-btn bordered" onClick={refresh} title="Refresh">
          <Icon name="refresh" size={16} className={loading ? 'spin' : ''} />
        </button>
      </div>

      {selected.size > 0 && (
        <div className="selection-bar">
          <label className="check">
            <input type="checkbox" checked={allChecked} onChange={toggleAll} />
            <span>{selected.size} selected</span>
          </label>
          <div className="spacer" />
          <button className="btn btn-sm" onClick={downloadSelected}>
            <Icon name="download" size={15} /> Download
          </button>
          <button
            className="btn btn-sm btn-danger-soft"
            onClick={() => askDelete([...selected], `${selected.size} file${selected.size === 1 ? '' : 's'}`)}
          >
            <Icon name="trash" size={15} /> Delete
          </button>
          <button className="icon-btn" onClick={() => setSelected(new Set())} title="Clear selection">
            <Icon name="x" size={16} />
          </button>
        </div>
      )}

      {error && (
        <div className="alert-box">
          <Icon name="alert" size={16} /> {error}
        </div>
      )}

      {loading && files.length === 0 ? (
        <div className={view === 'grid' ? 'grid' : 'panel list'}>
          {Array.from({ length: view === 'grid' ? 8 : 5 }).map((_, i) => (
            <div key={i} className={view === 'grid' ? 'card skeleton' : 'row skeleton'} />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <div className="empty">
          <div className={`empty-art tone-${section.tone}`}>
            <Icon name={query ? 'search' : section.icon || 'folder'} size={30} />
          </div>
          <h3>{query ? 'No matching files' : 'Nothing here yet'}</h3>
          <p className="muted">
            {query ? `Nothing in ${section.label} matches “${query}”.` : `Upload your first file to ${section.label}.`}
          </p>
          {!query && (
            <button className="btn btn-primary" onClick={() => inputRef.current.click()}>
              <Icon name="upload" size={16} /> Upload files
            </button>
          )}
        </div>
      ) : view === 'grid' ? (
        <div className="grid">
          {visible.map((f) => (
            <div
              key={f.path}
              className={`card ${selected.has(f.path) ? 'selected' : ''} ${busyPath === f.path ? 'busy' : ''}`}
            >
              <label className="card-check" title="Select">
                <input type="checkbox" checked={selected.has(f.path)} onChange={() => toggle(f.path)} />
              </label>
              <button className="card-preview" onClick={() => run(f.path, () => previewFile(f.path))} title="Open">
                <Cover file={f} url={thumbOf(f)} size="lg" />
                {thumbOf(f) && <span className={`type-pill pill-${fileKind(f.name).kind}`}>{fileKind(f.name).ext}</span>}
              </button>
              <div className="card-body">
                <div className="card-name" title={f.name}>
                  {f.name}
                </div>
                <div className="card-meta">
                  {formatSize(f.size)} · {formatDate(f.createdAt)}
                </div>
              </div>
              <div className="card-actions">{actions(f)}</div>
            </div>
          ))}
        </div>
      ) : (
        <div className="panel list">
          <div className="row head">
            <label className="check">
              <input type="checkbox" checked={allChecked} onChange={toggleAll} aria-label="Select all" />
            </label>
            <span>Name</span>
            <span className="col-size">Size</span>
            <span className="col-date">Uploaded</span>
            <span />
          </div>
          {visible.map((f) => (
            <div
              key={f.path}
              className={`row ${selected.has(f.path) ? 'selected' : ''} ${busyPath === f.path ? 'busy' : ''}`}
            >
              <label className="check">
                <input type="checkbox" checked={selected.has(f.path)} onChange={() => toggle(f.path)} />
              </label>
              <button className="row-name" onClick={() => run(f.path, () => previewFile(f.path))} title="Open">
                <Cover file={f} url={thumbOf(f)} size="sm" />
                <span className="truncate">{f.name}</span>
                <span className="row-meta-sm muted">
                  {formatSize(f.size)} · {formatDate(f.createdAt)}
                </span>
              </button>
              <span className="col-size muted">{formatSize(f.size)}</span>
              <span className="col-date muted">{formatDate(f.createdAt)}</span>
              <div className="row-actions">{actions(f)}</div>
            </div>
          ))}
        </div>
      )}

      {dragging && (
        <div className="drag-overlay">
          <div className="drag-card">
            <Icon name="cloud" size={40} />
            <div>Drop to upload to {section.label}</div>
          </div>
        </div>
      )}

      {confirm && <ConfirmModal {...confirm} onClose={() => setConfirm(null)} />}
      {renaming && <RenameModal name={renaming.name} onSave={saveRename} onClose={() => setRenaming(null)} />}
    </div>
  );
}
