const TOKEN_KEY = 'mydoc_token';

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t) => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY));

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => (onUnauthorized = fn);

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/login') onUnauthorized();
  if (!res.ok) {
    if (data.error) throw new Error(data.error);
    // No JSON body: the API itself didn't answer (crashed, not running, or not deployed).
    if (res.status >= 500)
      throw new Error(`The server isn't responding (error ${res.status}). Check that the API is running and its settings are filled in.`);
    throw new Error(`Request failed (${res.status})`);
  }
  return data;
}

// Send a file straight to storage (Supabase signed link or Google Drive upload session), with progress.
// Returns the parsed JSON reply, if any.
function sendToStorage({ url, format, headers }, blob, name, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    for (const [k, v] of Object.entries(headers || {})) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let reply = null;
      try {
        reply = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300) return resolve(reply);
      reject(new Error(reply?.message || reply?.error?.message || reply?.error || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Network error during upload'));
    if (format === 'multipart') {
      const form = new FormData();
      form.append('cacheControl', '3600');
      form.append('', blob, name);
      xhr.send(form);
    } else {
      xhr.send(blob); // the original bytes, unchanged
    }
  });
}

// Upload the original file (no compression or conversion). Returns its path in the app.
export async function uploadFile(section, file, onProgress) {
  const { path, upload } = await api('/files/upload-url', {
    method: 'POST',
    body: { section, name: file.name, size: file.size, type: file.type },
  });
  const reply = await sendToStorage(upload, file, file.name, onProgress);
  return path || `${section}/${reply?.id}`;
}

// Store (or replace) the small cover image shown on a file's card.
export async function uploadThumb(path, jpeg) {
  const res = await fetch(`/api/files/thumb?path=${encodeURIComponent(path)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/jpeg', Authorization: `Bearer ${getToken()}` },
    body: jpeg,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Cover upload failed (${res.status})`);
}

const fileInfo = (path, preview) =>
  api(`/files/download-url?${preview ? 'preview=1&' : ''}path=${encodeURIComponent(path)}`);

// Bytes start..end (inclusive) of a stored file, fetched through the server in pieces it allows.
async function readRange(path, start, end, chunkSize) {
  const parts = [];
  for (let s = start; s <= end; s += chunkSize) {
    const e = Math.min(end, s + chunkSize - 1);
    const res = await fetch(`/api/files/content?path=${encodeURIComponent(path)}&start=${s}&end=${e}`, {
      headers: { Authorization: `Bearer ${getToken()}` },
    });
    if (res.status === 401) onUnauthorized();
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Download failed (${res.status})`);
    parts.push(new Uint8Array(await res.arrayBuffer()));
  }
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// The whole file as a Blob, reading up to 3 pieces at a time.
async function readWhole(path, info, onProgress) {
  const { size, chunkSize, type } = info;
  const starts = [];
  for (let s = 0; s < size; s += chunkSize) starts.push(s);
  const parts = new Array(starts.length);
  let done = 0;
  let next = 0;
  const worker = async () => {
    while (next < starts.length) {
      const i = next++;
      parts[i] = await readRange(path, starts[i], Math.min(size, starts[i] + chunkSize) - 1, chunkSize);
      done += parts[i].length;
      onProgress?.(size ? done / size : 1);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return new Blob(parts, { type });
}

// What the cover maker reads a stored file from: a link, or a reader that fetches byte ranges.
export async function fileSource(path) {
  const info = await fileInfo(path, true);
  if (info.url) return info.url;
  return { size: info.size, read: (start, end) => readRange(path, start, end, info.chunkSize) };
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function downloadFile(path, onProgress) {
  const info = await fileInfo(path, false);
  if (info.url) {
    const a = document.createElement('a');
    a.href = info.url;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    return;
  }
  saveBlob(await readWhole(path, info, onProgress), info.name);
}

export async function previewFile(path, onProgress) {
  const win = window.open('', '_blank'); // opened right away so pop-up blockers allow it
  try {
    const info = await fileInfo(path, true);
    let url = info.url;
    if (!url) {
      win?.document.write('<p style="font:16px system-ui;padding:24px;color:#475569">Opening…</p>');
      url = URL.createObjectURL(await readWhole(path, info, onProgress));
      setTimeout(() => URL.revokeObjectURL(url), 10 * 60_000);
    }
    if (win) win.location.href = url;
    else window.location.href = url;
  } catch (e) {
    win?.close();
    throw e;
  }
}
