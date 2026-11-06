import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, uploadFile, uploadThumb, fileSource, downloadFile, previewFile, saveDetails, searchFiles } from './api.js';
import Icon from './Icon.jsx';
import { ConfirmModal, DetailsModal, FileBadge, fileKind, formatDate, formatSize, useToast } from './ui.jsx';
import { analyzeFile, canMakeThumb, thumbKind } from './thumbs.js';

// Files already read for a cover/details in this browser session (so failures aren't retried).
const thumbTried = new Set();

const searchWords = (q) => q.toLowerCase().replace(/["'\\]/g, ' ').split(/\s+/).filter(Boolean);
const searchText = (f) => `${f.name} ${f.title || ''} ${f.author || ''} ${f.keywords || ''}`.toLowerCase();
const matchesDetails = (f, words) => words.length > 0 && words.every((w) => searchText(f).includes(w));
const sectionOfPath = (path) => path.split('/')[0];

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

// Small labels under a file: which folder it's in (for results from other folders) and whether
// it matched only by the text inside it.
function FileTags({ f, current, sections, onOpenSection }) {
  const sec = sectionOfPath(f.path);
  const other = sec !== current && sections?.find((s) => s.id === sec);
  if (!other && !f.foundInside) return null;
  return (
    <span className="tags">
      {other && (
        <span
          role="link"
          tabIndex={0}
          className={`tag tone-${other.tone}`}
          onClick={(e) => {
            e.stopPropagation();
            onOpenSection?.(other.id);
          }}
          onKeyDown={(e) => e.key === 'Enter' && onOpenSection?.(other.id)}
        >
          {other.label}
        </span>
      )}
      {f.foundInside && <span className="tag tag-inside">Found inside</span>}
    </span>
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

export default function FileManager({ section, sections, features = {}, onChanged, onOpenSection }) {
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
  const [editing, setEditing] = useState(null); // file whose name/details are being edited
  const [localThumbs, setLocalThumbs] = useState({}); // path → object URL of a cover made in this tab
  const thumbOf = (f) => localThumbs[f.path] || f.thumbUrl;
  const [localDetails, setLocalDetails] = useState({}); // path → details read/saved in this tab
  const withDetails = useCallback((f) => (localDetails[f.path] ? { ...f, ...localDetails[f.path] } : f), [localDetails]);
  // Search: "folder" = this section, "all" = every section
  const [scope, setScope] = useState('folder');
  const [found, setFound] = useState({ key: '', items: [], loading: false, error: '' });
  const [searchNonce, setSearchNonce] = useState(0);
  const [progress, setProgress] = useState({}); // path → 0..1 while a file is being fetched
  const track = (path) => (p) => setProgress((x) => ({ ...x, [path]: p }));
  // Download/preview with a progress bar on the file (Google Drive files come in pieces).
  const fetchWith = (fn, f) =>
    run(f.path, async () => {
      try {
        await fn(f.path, track(f.path));
      } finally {
        setProgress(({ [f.path]: _, ...rest }) => rest);
      }
    });
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

  // Save what was read from a file: its cover, and (with Google Drive) its title/author/keywords.
  const storeAnalysis = useCallback(
    async (path, name, { cover, details }) => {
      if (cover) {
        await uploadThumb(path, cover).catch((e) => console.warn('Cover not saved for', name, e));
        setLocalThumbs((t) => ({ ...t, [path]: URL.createObjectURL(cover) }));
      }
      if (details && features.details) {
        const saved = await saveDetails(path, details, true).catch((e) => console.warn('Details not saved for', name, e));
        if (saved) setLocalDetails((d) => ({ ...d, [path]: { ...saved, analyzed: true } }));
      }
    },
    [features.details]
  );

  // Covers and details for files that don't have them yet, e.g. uploaded earlier or added
  // straight to Google Drive (one at a time, in the background).
  useEffect(() => {
    let cancelled = false;
    const todo = files.filter(
      (f) => canMakeThumb(f) && !thumbTried.has(f.path) && (!f.thumbUrl || (features.details && !f.analyzed))
    );
    (async () => {
      for (const f of todo) {
        if (cancelled) return;
        thumbTried.add(f.path);
        try {
          const result = await analyzeFile(await fileSource(f.path), f.name, f.type, { cover: !f.thumbUrl });
          await storeAnalysis(f.path, f.name, result);
        } catch (e) {
          console.warn('Could not read', f.name, e);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [files, features.details, storeAnalysis]);

  const refresh = async () => {
    await load();
    onChanged?.();
    setSearchNonce((n) => n + 1);
  };

  // Server search (title/keywords everywhere, and text inside files with Google Drive), debounced.
  const words = useMemo(() => searchWords(query), [query]);
  const useServer = words.length > 0 && (scope === 'all' || features.contentSearch);
  const searchKey = useServer ? `${scope}|${words.join(' ')}|${searchNonce}` : '';
  useEffect(() => {
    if (!searchKey) return;
    let stale = false;
    setFound((f) => ({ ...f, loading: true, error: '' }));
    const timer = setTimeout(async () => {
      try {
        const items = await searchFiles(words.join(' '), scope === 'all' ? '' : section.id);
        if (!stale) setFound({ key: searchKey, items, loading: false, error: '' });
      } catch (e) {
        if (!stale) setFound({ key: searchKey, items: [], loading: false, error: e.message });
      }
    }, 350);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [searchKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const searching = words.length > 0;
  const visible = useMemo(() => {
    let list;
    if (!searching) list = files.map(withDetails);
    else {
      // Title/author/keyword/name matches in this folder show at once; server results are added
      // as they arrive (marked "found inside" when only the file's text matched).
      const byPath = new Map();
      for (const f of files.map(withDetails)) if (matchesDetails(f, words)) byPath.set(f.path, f);
      if (found.key === searchKey) {
        for (const r of found.items.map(withDetails)) {
          if (!byPath.has(r.path)) byPath.set(r.path, { ...r, foundInside: !matchesDetails(r, words) });
        }
      }
      list = [...byPath.values()];
    }
    const [key, dir] = sort.split('-');
    const m = dir === 'asc' ? 1 : -1;
    list.sort((a, b) => {
      if (key === 'name') return m * (a.title || a.name).localeCompare(b.title || b.name, undefined, { numeric: true });
      if (key === 'size') return m * (a.size - b.size);
      return m * (new Date(a.createdAt) - new Date(b.createdAt));
    });
    return list;
  }, [files, sort, searching, words, found, searchKey, withDetails]);
  const searchPending = useServer && (found.key !== searchKey || found.loading);

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
          // Cover and details from the local copy: no need to download the file again.
          thumbTried.add(path);
          await storeAnalysis(path, it.file.name, await analyzeFile(it.file, it.file.name, it.file.type));
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
      message: features.trash ? (
        <>
          <strong>{label}</strong> will be moved to your Google Drive trash. You can restore it from there for 30 days.
        </>
      ) : (
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

  const saveEdit = async ({ name, ...details }) => {
    const f = editing;
    try {
      if (name && name !== f.name) await api('/files', { method: 'PATCH', body: { path: f.path, name } });
      if (features.details && ['title', 'author', 'keywords'].some((k) => (details[k] || '') !== (f[k] || ''))) {
        const saved = await saveDetails(f.path, details);
        setLocalDetails((d) => ({ ...d, [f.path]: { ...saved, analyzed: true } }));
      }
      toast('Saved');
      setEditing(null);
      load();
      setSearchNonce((n) => n + 1);
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


  const actions = (f) => (
    <>
      <button className="icon-btn" title="Preview" onClick={() => fetchWith(previewFile, f)}>
        <Icon name="eye" size={17} />
      </button>
      <button className="icon-btn" title="Download" onClick={() => fetchWith(downloadFile, f)}>
        <Icon name="download" size={17} />
      </button>
      <button className="icon-btn" title={features.details ? 'Edit details' : 'Rename'} onClick={() => setEditing(f)}>
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
            type="search"
            enterKeyHint="search"
            placeholder={features.contentSearch ? 'Search title, author, keywords or text…' : 'Search title, author, keywords…'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search files"
          />
          {query && (
            <button className="input-action" onClick={() => setQuery('')} aria-label="Clear search">
              <Icon name="x" size={15} />
            </button>
          )}
        </div>
        <div className="segmented scope" role="group" aria-label="Search in">
          <button className={scope === 'folder' ? 'on' : ''} onClick={() => setScope('folder')}>
            This folder
          </button>
          <button className={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')}>
            All folders
          </button>
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

      {searching && (
        <div className="search-summary">
          {searchPending ? <span className="spinner xs" /> : <Icon name="search" size={15} />}
          <span>
            {visible.length} result{visible.length === 1 ? '' : 's'} for <strong>“{query.trim()}”</strong>{' '}
            {scope === 'all' ? 'in all folders' : `in ${section.label}`}
            {searchPending ? ' · searching…' : ''}
          </span>
          {scope === 'folder' && (
            <button className="link-btn" onClick={() => setScope('all')}>
              Search all folders
            </button>
          )}
        </div>
      )}
      {found.error && found.key === searchKey && (
        <div className="alert-box">
          <Icon name="alert" size={16} /> {found.error}
        </div>
      )}

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

      {loading && files.length === 0 && !searching ? (
        <div className={view === 'grid' ? 'grid' : 'panel list'}>
          {Array.from({ length: view === 'grid' ? 8 : 5 }).map((_, i) => (
            <div key={i} className={view === 'grid' ? 'card skeleton' : 'row skeleton'} />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <div className="empty">
          <div className={`empty-art tone-${section.tone}`}>
            <Icon name={searching ? 'search' : section.icon || 'folder'} size={30} />
          </div>
          <h3>{searching ? (searchPending ? 'Searching…' : 'No matching files') : 'Nothing here yet'}</h3>
          <p className="muted">
            {searching
              ? searchPending
                ? 'Looking through titles, keywords and file contents.'
                : `Nothing ${scope === 'all' ? 'in any folder' : `in ${section.label}`} matches “${query.trim()}”.`
              : `Upload your first file to ${section.label}.`}
          </p>
          {searching && !searchPending && scope === 'folder' && (
            <button className="btn" onClick={() => setScope('all')}>
              <Icon name="search" size={16} /> Search all folders
            </button>
          )}
          {!searching && (
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
              <button className="card-preview" onClick={() => fetchWith(previewFile, f)} title="Open">
                <Cover file={f} url={thumbOf(f)} size="lg" />
                {thumbOf(f) && <span className={`type-pill pill-${fileKind(f.name).kind}`}>{fileKind(f.name).ext}</span>}
              </button>
{progress[f.path] !== undefined && (
                <div className="fetch-bar" role="progressbar" aria-valuenow={Math.round(progress[f.path] * 100)}>
                  <div style={{ width: `${Math.max(4, Math.round(progress[f.path] * 100))}%` }} />
                </div>
              )}
              <div className="card-body">
                <div className="card-name" title={f.title || f.name}>
                  {f.title || f.name}
                </div>
                {(f.author || f.title) && (
                  <div className="card-sub" title={f.author || f.name}>
                    {f.author || f.name}
                  </div>
                )}
                <div className="card-meta">
                  {formatSize(f.size)} · {formatDate(f.createdAt)}
                </div>
                <FileTags f={f} current={section.id} sections={sections} onOpenSection={onOpenSection} />
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
              <button className="row-name" onClick={() => fetchWith(previewFile, f)} title="Open">
                <Cover file={f} url={thumbOf(f)} size="sm" />
                <span className="row-text">
                  <span className="row-title">{f.title || f.name}</span>
                  {(f.author || f.title) && <span className="row-sub muted">{f.author || f.name}</span>}
                  <span className="row-meta-sm muted">
                    {formatSize(f.size)} · {formatDate(f.createdAt)}
                  </span>
                  <FileTags f={f} current={section.id} sections={sections} onOpenSection={onOpenSection} />
                </span>
              </button>
              <span className="col-size muted">{formatSize(f.size)}</span>
              <span className="col-date muted">{formatDate(f.createdAt)}</span>
              <div className="row-actions">{actions(f)}</div>
              {progress[f.path] !== undefined && (
                <div className="fetch-bar" role="progressbar" aria-valuenow={Math.round(progress[f.path] * 100)}>
                  <div style={{ width: `${Math.max(4, Math.round(progress[f.path] * 100))}%` }} />
                </div>
              )}
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
      {editing && (
        <DetailsModal file={editing} withDetails={!!features.details} onSave={saveEdit} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}
