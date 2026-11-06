import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// On Vercel this file runs as a serverless function: no app.listen(), no static files,
// and several short-lived instances can serve requests side by side.
const IS_VERCEL = !!process.env.VERCEL;

// Values pasted into hosting dashboards often carry stray spaces or newlines.
const env = (name, fallback = '') => (process.env[name] ?? '').trim() || fallback;

const APP_USERNAME = env('APP_USERNAME');
const APP_PASSWORD = env('APP_PASSWORD');
const SUPABASE_URL = env('SUPABASE_URL').replace(/\/+$/, '');
const SUPABASE_PUBLISHABLE_KEY = env('SUPABASE_PUBLISHABLE_KEY');
const SUPABASE_SECRET_KEY = env('SUPABASE_SECRET_KEY');
const SUPABASE_BUCKET = env('SUPABASE_BUCKET', 'mydoc');
const SESSION_TTL = env('SESSION_TTL', '12h');
const PORT = env('PORT', '4000');
let JWT_SECRET = env('JWT_SECRET');

// Problems are collected instead of thrown, so the server still starts and every API call
// answers with a message naming what to fix (a crash shows up only as a bare "500").
const configErrors = [];
const missing = Object.entries({ APP_USERNAME, APP_PASSWORD, SUPABASE_URL, SUPABASE_SECRET_KEY })
  .filter(([, value]) => !value)
  .map(([name]) => name);
// Each serverless instance would invent its own secret and reject the others' logins.
if (!JWT_SECRET && IS_VERCEL) missing.push('JWT_SECRET');
if (missing.length) configErrors.push(`missing ${missing.join(', ')}`);
if (SUPABASE_URL && !/^https?:\/\/[^\s/]+$/.test(SUPABASE_URL)) {
  configErrors.push('SUPABASE_URL must look like https://<project-id>.supabase.co');
}
const CONFIG_HELP = IS_VERCEL
  ? 'Fix this in Vercel → Project → Settings → Environment Variables, then redeploy.'
  : 'Fix this in server/.env (see server/.env.example) and restart the server.';
if (configErrors.length) console.error(`Server setup incomplete: ${configErrors.join('; ')}. ${CONFIG_HELP}`);

if (!JWT_SECRET) {
  JWT_SECRET = crypto.randomBytes(48).toString('hex');
  if (!IS_VERCEL) console.warn('JWT_SECRET not set: using a random one. Everyone is logged out when the server restarts.');
}

// Sections map to top-level folders in the bucket.
export const SECTIONS = {
  ebooks: { label: 'Ebooks', group: 'Ebooks' },
  rakesh: { label: 'Rakesh', group: 'Personal Documents' },
  priyanka: { label: 'Priyanka', group: 'Personal Documents' },
  ananya: { label: 'Ananya', group: 'Personal Documents' },
};

let supabase = null;
if (!configErrors.length) {
  try {
    supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  } catch (err) {
    configErrors.push(`could not set up Supabase (${err.message})`);
  }
}
const bucket = () => supabase.storage.from(SUPABASE_BUCKET);

async function ensureBucket() {
  const { data, error } = await supabase.storage.getBucket(SUPABASE_BUCKET);
  if (data) return;
  if (error && !/not found/i.test(error.message)) throw error;
  const { error: createError } = await supabase.storage.createBucket(SUPABASE_BUCKET, { public: false });
  if (createError && !/already exists/i.test(createError.message)) throw createError;
  console.log(`Created private storage bucket "${SUPABASE_BUCKET}".`);
}

// ---------- helpers ----------

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Supabase object keys allow a limited character set; keep the name readable.
function sanitizeName(name) {
  const base = path.basename(String(name || '')).normalize('NFKD');
  const cleaned = base
    .replace(/[^\w.\- ()[\],+&@=]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/_+/g, '_')
    .trim();
  return cleaned.slice(-180) || 'file';
}

// Stored as "<section>/<id>__<name>" so identical names never clash.
function displayName(objectName) {
  const i = objectName.indexOf('__');
  return i > 0 ? objectName.slice(i + 2) : objectName;
}

function assertSection(section) {
  if (!Object.hasOwn(SECTIONS, section)) {
    const err = new Error('Unknown section');
    err.status = 400;
    throw err;
  }
}

function assertPath(p) {
  const [section, ...rest] = String(p || '').split('/');
  const file = rest.join('/');
  if (!Object.hasOwn(SECTIONS, section) || !file || file.includes('/') || file.includes('..')) {
    const err = new Error('Invalid file path');
    err.status = 400;
    throw err;
  }
  return { section, file };
}

// Cover thumbnails (small JPEGs made in the browser) live outside the section folders,
// keyed by the file's id so they survive renames: _thumbs/<section>/<id>.jpg
const THUMBS = '_thumbs';
function thumbKey(section, file) {
  const id = file.includes('__') ? file.slice(0, file.indexOf('__')) : file;
  return `${THUMBS}/${section}/${id}.jpg`;
}

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- app ----------

const app = express();
app.disable('x-powered-by');
if (IS_VERCEL) app.set('trust proxy', 1); // real client IP for the login rate limiter

// All routes live under /api, which is also the public path Vercel rewrites to this service.
// If the platform hands the request over without that prefix, put it back.
if (IS_VERCEL) {
  app.use((req, res, next) => {
    if (req.url !== '/api' && !req.url.startsWith('/api/')) req.url = `/api${req.url === '/' ? '' : req.url}`;
    next();
  });
}
app.use(express.json({ limit: '100kb' }));

// No login needed: says whether the server is set up (names of problems only, never values).
app.get('/api/health', (req, res) => {
  res.status(configErrors.length ? 500 : 200).json({ ok: !configErrors.length, problems: configErrors });
});

app.use('/api', (req, res, next) => {
  if (!configErrors.length) return next();
  res.status(500).json({ error: `Server setup incomplete: ${configErrors.join('; ')}. ${CONFIG_HELP}` });
});

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });

app.post('/api/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  const ok = safeEqual(username ?? '', APP_USERNAME) & safeEqual(password ?? '', APP_PASSWORD);
  if (!ok) return res.status(401).json({ error: 'Invalid username or password' });
  const token = jwt.sign({ sub: APP_USERNAME }, JWT_SECRET, { expiresIn: SESSION_TTL });
  res.json({ token, username: APP_USERNAME });
});

function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Please log in again' });
  }
}

app.use('/api', requireAuth);

app.get('/api/me', (req, res) => res.json({ username: req.user.sub }));

app.get('/api/sections', (req, res) => res.json(SECTIONS));

// All objects directly inside a folder (skips sub-folders and placeholders).
async function listFolder(folder) {
  const items = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await bucket().list(folder, {
      limit: pageSize,
      offset,
      sortBy: { column: 'created_at', order: 'desc' },
    });
    if (error) throw error;
    items.push(...data.filter((item) => item.id && item.name !== '.emptyFolderPlaceholder'));
    if (data.length < pageSize) break;
  }
  return items;
}

async function listSection(section) {
  return (await listFolder(section)).map((item) => ({
    path: `${section}/${item.name}`,
    name: displayName(item.name),
    size: item.metadata?.size ?? 0,
    type: item.metadata?.mimetype ?? '',
    createdAt: item.created_at,
    updatedAt: item.updated_at,
  }));
}

// List files in a section
app.get(
  '/api/files',
  asyncRoute(async (req, res) => {
    const section = String(req.query.section || '');
    assertSection(section);
    const [files, thumbs] = await Promise.all([listSection(section), listFolder(`${THUMBS}/${section}`)]);
    // Attach a short-lived link to each file's cover thumbnail, when one exists.
    const existing = new Set(thumbs.map((t) => `${THUMBS}/${section}/${t.name}`));
    const withThumb = files.filter((f) => existing.has(thumbKey(section, f.path.split('/')[1])));
    if (withThumb.length) {
      const keys = withThumb.map((f) => thumbKey(section, f.path.split('/')[1]));
      const { data, error } = await bucket().createSignedUrls(keys, 60 * 60);
      if (error) throw error;
      const urlByKey = new Map(data.filter((d) => d.signedUrl).map((d) => [d.path, d.signedUrl]));
      for (const f of withThumb) f.thumbUrl = urlByKey.get(thumbKey(section, f.path.split('/')[1])) || null;
    }
    res.json(files);
  })
);

// File count, total size and latest upload for every section
app.get(
  '/api/stats',
  asyncRoute(async (req, res) => {
    const entries = await Promise.all(
      Object.keys(SECTIONS).map(async (s) => {
        const files = await listSection(s);
        return [
          s,
          {
            count: files.length,
            size: files.reduce((n, f) => n + f.size, 0),
            lastUpload: files.reduce((d, f) => (!d || f.createdAt > d ? f.createdAt : d), null),
          },
        ];
      })
    );
    res.json(Object.fromEntries(entries));
  })
);

// Get a one-time signed URL the browser uploads the original file to (no re-encoding, no size cap from this server).
app.post(
  '/api/files/upload-url',
  asyncRoute(async (req, res) => {
    const { section, name } = req.body || {};
    assertSection(section);
    const id = `${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
    const objectPath = `${section}/${id}__${sanitizeName(name)}`;
    const { data, error } = await bucket().createSignedUploadUrl(objectPath);
    if (error) throw error;
    res.json({ path: objectPath, signedUrl: data.signedUrl, apiKey: SUPABASE_PUBLISHABLE_KEY || null });
  })
);

// Signed URL for the browser to upload (or replace) a file's cover thumbnail
app.post(
  '/api/files/thumb-upload-url',
  asyncRoute(async (req, res) => {
    const { section, file } = assertPath(req.body?.path);
    const { data, error } = await bucket().createSignedUploadUrl(thumbKey(section, file), { upsert: true });
    if (error) throw error;
    res.json({ signedUrl: data.signedUrl, apiKey: SUPABASE_PUBLISHABLE_KEY || null });
  })
);

// Signed URL to download (or preview) the original file
app.get(
  '/api/files/download-url',
  asyncRoute(async (req, res) => {
    const { file } = assertPath(req.query.path);
    const preview = req.query.preview === '1';
    const { data, error } = await bucket().createSignedUrl(req.query.path, 60 * 5, {
      download: preview ? false : displayName(file),
    });
    if (error) throw error;
    res.json({ url: data.signedUrl });
  })
);

// Rename a file (keeps it in the same section)
app.patch(
  '/api/files',
  asyncRoute(async (req, res) => {
    const { path: from, name } = req.body || {};
    const { section, file } = assertPath(from);
    const idPart = file.includes('__') ? file.slice(0, file.indexOf('__')) : Date.now().toString(36);
    const to = `${section}/${idPart}__${sanitizeName(name)}`;
    if (to !== from) {
      const { error } = await bucket().move(from, to);
      if (error) throw error;
      // Files without an id get one now, so their thumbnail key changes too (best effort).
      const [oldThumb, newThumb] = [thumbKey(section, file), thumbKey(section, to.split('/')[1])];
      if (oldThumb !== newThumb) await bucket().move(oldThumb, newThumb).catch(() => {});
    }
    res.json({ path: to, name: displayName(to.split('/')[1]) });
  })
);

// Delete one or more files
app.delete(
  '/api/files',
  asyncRoute(async (req, res) => {
    const paths = Array.isArray(req.body?.paths) ? req.body.paths : [req.body?.path];
    const thumbs = paths.map((p) => {
      const { section, file } = assertPath(p);
      return thumbKey(section, file);
    });
    const { error } = await bucket().remove([...paths, ...thumbs]); // missing thumbnails are ignored
    if (error) throw error;
    res.json({ deleted: paths.length });
  })
);

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Single-server mode (npm start): also serve the built React app.
// On Vercel the "client" service serves it instead.
const clientDist = path.resolve(__dirname, '../client/dist');
if (!IS_VERCEL && fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'Server error' });
});

if (!IS_VERCEL) {
  app.listen(PORT, () => console.log(`MyDoc server listening on http://localhost:${PORT}`));
}

if (supabase) ensureBucket().catch((err) => console.error('Could not verify/create the storage bucket:', err.message));

export default app;
