// Files in the owner's Google Drive:
//   <root folder, default "MyDoc Vault">/Ebooks, /Rakesh, /Priyanka, /Ananya
//   covers: <root>/_covers/<file id>.jpg
// Talks to the Drive REST API with plain fetch (the googleapis package is too big for a function).
import { SECTIONS, CHUNK_SIZE, httpError, parseDetails, formatDetails } from './util.js';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const COVERS_FOLDER = '_covers';
const FILE_FIELDS = 'id,name,size,mimeType,createdTime,modifiedTime,parents,trashed,description,appProperties';
const NOT_GOOGLE_DOC = "not mimeType contains 'application/vnd.google-apps.'";

// Drive query string literal: 'it\'s'
const lit = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const cleanName = (name) => String(name || '').replace(/[\r\n]/g, ' ').trim().slice(0, 250) || 'file';

export function createDriveStorage({
  clientId,
  clientSecret,
  refreshToken,
  rootFolderName = 'MyDoc Vault',
  rootFolderId = '',
  apiBase = 'https://www.googleapis.com',
  tokenUrl = 'https://oauth2.googleapis.com/token',
  signThumbUrl,
}) {
  const configErrors = [];
  const missing = [
    !clientId && 'GOOGLE_CLIENT_ID',
    !clientSecret && 'GOOGLE_CLIENT_SECRET',
    !refreshToken && 'GOOGLE_REFRESH_TOKEN',
  ].filter(Boolean);
  if (missing.length) configErrors.push(`missing ${missing.join(', ')}`);

  // ---------- Google sign-in (refresh token → short-lived access token) ----------
  let accessToken = null;
  let accessTokenExpires = 0;
  let tokenRequest = null;
  function getAccessToken() {
    if (accessToken && Date.now() < accessTokenExpires - 60_000) return Promise.resolve(accessToken);
    tokenRequest ??= (async () => {
      const res = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
          grant_type: 'refresh_token',
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.access_token) {
        throw httpError(
          502,
          `Google sign-in failed (${body.error_description || body.error || res.status}). ` +
            'Check GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN.'
        );
      }
      accessToken = body.access_token;
      accessTokenExpires = Date.now() + (body.expires_in || 3600) * 1000;
      return accessToken;
    })().finally(() => {
      tokenRequest = null;
    });
    return tokenRequest;
  }

  // ---------- Drive API ----------
  async function drive(path, { method = 'GET', query, json, headers = {}, body, raw = false } = {}) {
    const url = new URL(apiBase + path);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined) url.searchParams.set(k, v);
    const h = { authorization: `Bearer ${await getAccessToken()}`, ...headers };
    if (json) {
      h['content-type'] = 'application/json; charset=UTF-8';
      body = JSON.stringify(json);
    }
    const res = await fetch(url, { method, headers: h, body });
    if (raw) return res;
    if (!res.ok) throw await driveError(res);
    return res.status === 204 ? null : res.json();
  }

  async function driveError(res) {
    const body = await res.json().catch(() => ({}));
    const msg = body.error?.message || res.statusText || `error ${res.status}`;
    if (res.status === 404) return httpError(404, 'File not found');
    if (res.status === 403 && /storage quota/i.test(msg)) return httpError(507, 'Your Google Drive is full.');
    return httpError(502, `Google Drive: ${msg}`);
  }

  async function listAll(q, fields) {
    const out = [];
    let pageToken;
    do {
      const page = await drive('/drive/v3/files', {
        query: { q, fields: `nextPageToken, files(${fields})`, pageSize: 1000, pageToken, orderBy: 'createdTime desc', spaces: 'drive' },
      });
      out.push(...(page.files || []));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return out;
  }

  async function findOrCreateFolder(name, parentId) {
    const found = await listAll(
      `name = ${lit(name)} and mimeType = '${FOLDER_MIME}' and ${lit(parentId)} in parents and trashed = false`,
      'id'
    );
    if (found.length) return found[0].id;
    const created = await drive('/drive/v3/files', {
      method: 'POST',
      query: { fields: 'id' },
      json: { name, mimeType: FOLDER_MIME, parents: [parentId] },
    });
    return created.id;
  }

  // Folder ids, looked up (or created) once per server instance.
  let foldersRequest = null;
  function folders() {
    foldersRequest ??= (async () => {
      const root = rootFolderId || (await findOrCreateFolder(rootFolderName, 'root'));
      const wanted = [...Object.entries(SECTIONS).map(([key, s]) => [key, s.folder]), ['_covers', COVERS_FOLDER]];
      const ids = await Promise.all(wanted.map(async ([key, name]) => [key, await findOrCreateFolder(name, root)]));
      return Object.fromEntries(ids);
    })().catch((err) => {
      foldersRequest = null;
      throw err;
    });
    return foldersRequest;
  }

  // The file must be a live file directly inside that section's folder (the app has access to the
  // whole Drive, so never act on an id the browser sends without checking where it lives).
  async function ownedFile({ section, file: id }) {
    if (!/^[\w-]{10,}$/.test(id)) throw httpError(400, 'Invalid file path');
    const [f, meta] = await Promise.all([folders(), drive(`/drive/v3/files/${id}`, { query: { fields: FILE_FIELDS } })]);
    if (meta.trashed || !meta.parents?.includes(f[section]) || meta.mimeType === FOLDER_MIME) {
      throw httpError(404, 'File not found');
    }
    return meta;
  }

  async function coverFiles(fileId) {
    const f = await folders();
    return listAll(`name = ${lit(`${fileId}.jpg`)} and ${lit(f._covers)} in parents and trashed = false`, 'id');
  }

  // Title/author/keywords live in the Drive file's description (readable and editable in Drive too);
  // appProperties.mydocAnalyzed marks files whose details were already read automatically.
  const toItem = (section, coverByName) => (m) => {
    const item = {
      path: `${section}/${m.id}`,
      name: m.name,
      size: Number(m.size || 0),
      type: m.mimeType || '',
      createdAt: m.createdTime,
      updatedAt: m.modifiedTime,
      ...parseDetails(m.description),
      analyzed: m.appProperties?.mydocAnalyzed === '1',
    };
    const coverId = coverByName?.get(`${m.id}.jpg`);
    if (coverId) item.thumbUrl = signThumbUrl(coverId);
    return item;
  };

  async function coverMap() {
    const f = await folders();
    const covers = await listAll(`${lit(f._covers)} in parents and trashed = false`, 'id,name');
    return new Map(covers.map((c) => [c.name, c.id]));
  }

  return {
    kind: 'google-drive',
    configErrors,

    async init() {
      await folders();
    },

    features: { details: true, contentSearch: true, trash: true },

    async list(section, { thumbs = true } = {}) {
      const f = await folders();
      const [files, covers] = await Promise.all([
        // Google Docs/Sheets/shortcuts have no file bytes to download, so they're left out.
        listAll(`${lit(f[section])} in parents and trashed = false and ${NOT_GOOGLE_DOC}`, FILE_FIELDS),
        thumbs ? coverMap() : null,
      ]);
      return files.map(toItem(section, covers));
    },

    // Google Drive full-text search: file name, description (title/author/keywords) and the text
    // inside the files. Every word must match.
    async search(words, sections) {
      const f = await folders();
      const inFolders = sections.map((s) => `${lit(f[s])} in parents`).join(' or ');
      const text = words.map((w) => `fullText contains ${lit(w)}`).join(' and ');
      const [files, covers] = await Promise.all([
        listAll(`(${inFolders}) and trashed = false and ${NOT_GOOGLE_DOC} and ${text}`, FILE_FIELDS),
        coverMap(),
      ]);
      const sectionOf = new Map(sections.map((s) => [f[s], s]));
      return files
        .map((m) => {
          const section = sectionOf.get(m.parents?.find((p) => sectionOf.has(p)));
          return section && toItem(section, covers)(m);
        })
        .filter(Boolean);
    },

    // auto: details read from the file by the browser; skipped if the file was already done, so
    // they never overwrite details typed in by hand.
    async saveDetails(ref, details, { auto = false } = {}) {
      const meta = await ownedFile(ref);
      if (auto && meta.appProperties?.mydocAnalyzed === '1') return parseDetails(meta.description);
      const updated = await drive(`/drive/v3/files/${meta.id}`, {
        method: 'PATCH',
        query: { fields: 'id,description' },
        json: { description: formatDetails(details), appProperties: { mydocAnalyzed: '1' } },
      });
      return parseDetails(updated.description);
    },

    // Start a resumable upload; the browser then PUTs the original bytes straight to Google.
    // Google only lets the browser do that if the session was started with the page's Origin.
    async createUpload({ section, name, size, type, origin }) {
      const f = await folders();
      const res = await drive('/upload/drive/v3/files', {
        method: 'POST',
        raw: true,
        query: { uploadType: 'resumable', fields: 'id,name' },
        json: { name: cleanName(name), parents: [f[section]] },
        headers: {
          'X-Upload-Content-Type': type || 'application/octet-stream',
          ...(size ? { 'X-Upload-Content-Length': String(size) } : {}),
          ...(origin ? { origin } : {}),
        },
      });
      if (!res.ok) throw await driveError(res);
      const location = res.headers.get('location');
      if (!location) throw httpError(502, 'Google Drive did not return an upload address');
      return { upload: { url: location, format: 'raw', headers: {} } };
    },

    // The bytes come through this server in pieces (see readRange), so nothing is ever made public.
    async download(ref) {
      const meta = await ownedFile(ref);
      return { proxy: true, name: meta.name, size: Number(meta.size || 0), type: meta.mimeType || 'application/octet-stream' };
    },

    async readRange(ref, start, end) {
      if (end - start + 1 > CHUNK_SIZE) throw httpError(400, 'Range too large');
      const meta = await ownedFile(ref);
      const res = await drive(`/drive/v3/files/${meta.id}`, {
        raw: true,
        query: { alt: 'media' },
        headers: { range: `bytes=${start}-${end}` },
      });
      if (!res.ok) throw await driveError(res);
      return { type: meta.mimeType || 'application/octet-stream', body: Buffer.from(await res.arrayBuffer()) };
    },

    async saveThumb(ref, jpeg) {
      const meta = await ownedFile(ref);
      const [existing] = await coverFiles(meta.id);
      if (existing) {
        await drive(`/upload/drive/v3/files/${existing.id}`, {
          method: 'PATCH',
          query: { uploadType: 'media', fields: 'id' },
          headers: { 'content-type': 'image/jpeg' },
          body: jpeg,
        });
        return;
      }
      const f = await folders();
      const boundary = `mydoc${Date.now().toString(36)}`;
      const body = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
            JSON.stringify({ name: `${meta.id}.jpg`, parents: [f._covers], mimeType: 'image/jpeg' }) +
            `\r\n--${boundary}\r\nContent-Type: image/jpeg\r\n\r\n`
        ),
        jpeg,
        Buffer.from(`\r\n--${boundary}--`),
      ]);
      await drive('/upload/drive/v3/files', {
        method: 'POST',
        query: { uploadType: 'multipart', fields: 'id' },
        headers: { 'content-type': `multipart/related; boundary=${boundary}` },
        body,
      });
    },

    // Called with an id this server put into a signed cover link, so no ownership lookup is needed.
    async readThumb(coverId) {
      if (!/^[\w-]{10,}$/.test(coverId)) throw httpError(400, 'Invalid cover');
      const res = await drive(`/drive/v3/files/${coverId}`, { raw: true, query: { alt: 'media' } });
      if (!res.ok) throw await driveError(res);
      return { type: 'image/jpeg', body: Buffer.from(await res.arrayBuffer()) };
    },

    async rename(ref, name) {
      const meta = await ownedFile(ref);
      const updated = await drive(`/drive/v3/files/${meta.id}`, {
        method: 'PATCH',
        query: { fields: 'id,name' },
        json: { name: cleanName(name) },
      });
      return { path: `${ref.section}/${meta.id}`, name: updated.name };
    },

    // Moves files (and their covers) to the Drive trash, where they can be restored for 30 days.
    async remove(refs) {
      await Promise.all(
        refs.map(async (ref) => {
          const meta = await ownedFile(ref);
          await drive(`/drive/v3/files/${meta.id}`, { method: 'PATCH', query: { fields: 'id' }, json: { trashed: true } });
          for (const cover of await coverFiles(meta.id)) {
            await drive(`/drive/v3/files/${cover.id}`, { method: 'PATCH', query: { fields: 'id' }, json: { trashed: true } }).catch(() => {});
          }
        })
      );
    },
  };
}
