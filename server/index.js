import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { SECTIONS, CHUNK_SIZE, httpError } from './storage/util.js';
import { createSupabaseStorage } from './storage/supabase.js';
import { createDriveStorage } from './storage/gdrive.js';

export { SECTIONS };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// On Vercel this file runs as a serverless function: no app.listen(), no static files,
// and several short-lived instances can serve requests side by side.
const IS_VERCEL = !!process.env.VERCEL;

// Values pasted into hosting dashboards often carry stray spaces or newlines.
const env = (name, fallback = '') => (process.env[name] ?? '').trim() || fallback;

const APP_USERNAME = env('APP_USERNAME');
const APP_PASSWORD = env('APP_PASSWORD');
const SESSION_TTL = env('SESSION_TTL', '12h');
const PORT = env('PORT', '4000');
let JWT_SECRET = env('JWT_SECRET');

// Problems are collected instead of thrown, so the server still starts and every API call
// answers with a message naming what to fix (a crash shows up only as a bare "500").
const configErrors = [];
const missing = Object.entries({ APP_USERNAME, APP_PASSWORD })
  .filter(([, value]) => !value)
  .map(([name]) => name);
// Each serverless instance would invent its own secret and reject the others' logins.
if (!JWT_SECRET && IS_VERCEL) missing.push('JWT_SECRET');
if (missing.length) configErrors.push(`missing ${missing.join(', ')}`);
if (!JWT_SECRET) {
  JWT_SECRET = crypto.randomBytes(48).toString('hex');
  if (!IS_VERCEL) console.warn('JWT_SECRET not set: using a random one. Everyone is logged out when the server restarts.');
}

// ---------- storage: Google Drive when its keys are set, otherwise Supabase ----------

// Cover images are shown with <img>, which can't send the login token, so their links carry
// a signature instead. Links change once an hour, which lets the browser cache covers meanwhile.
const thumbSig = (id, exp) => crypto.createHmac('sha256', JWT_SECRET).update(`cover|${id}|${exp}`).digest('base64url');
function signThumbUrl(id) {
  const exp = (Math.floor(Date.now() / 3_600_000) + 2) * 3600; // 1–2 hours from now, in seconds
  return `/api/thumb/${encodeURIComponent(id)}?exp=${exp}&sig=${thumbSig(id, exp)}`;
}

const USE_DRIVE = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'].some((n) => env(n));
const storage = USE_DRIVE
  ? createDriveStorage({
      clientId: env('GOOGLE_CLIENT_ID'),
      clientSecret: env('GOOGLE_CLIENT_SECRET'),
      refreshToken: env('GOOGLE_REFRESH_TOKEN'),
      rootFolderName: env('GOOGLE_DRIVE_FOLDER_NAME', 'MyDoc Vault'),
      rootFolderId: env('GOOGLE_DRIVE_FOLDER_ID'),
      apiBase: env('GOOGLE_API_BASE', 'https://www.googleapis.com'), // overridable for tests
      tokenUrl: env('GOOGLE_TOKEN_URL', 'https://oauth2.googleapis.com/token'),
      signThumbUrl,
    })
  : createSupabaseStorage({
      url: env('SUPABASE_URL').replace(/\/+$/, ''),
      secretKey: env('SUPABASE_SECRET_KEY'),
      publishableKey: env('SUPABASE_PUBLISHABLE_KEY'),
      bucketName: env('SUPABASE_BUCKET', 'mydoc'),
    });
configErrors.push(...storage.configErrors);

const CONFIG_HELP = IS_VERCEL
  ? 'Fix this in Vercel → Project → Settings → Environment Variables, then redeploy.'
  : 'Fix this in server/.env (see server/.env.example) and restart the server.';
if (configErrors.length) console.error(`Server setup incomplete: ${configErrors.join('; ')}. ${CONFIG_HELP}`);

// ---------- helpers ----------

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function assertSection(section) {
  if (!Object.hasOwn(SECTIONS, section)) throw httpError(400, 'Unknown section');
}

// "<section>/<file>" where <file> is a storage key (Supabase) or a file id (Google Drive).
function parsePath(p) {
  const [section, ...rest] = String(p || '').split('/');
  const file = rest.join('/');
  if (!Object.hasOwn(SECTIONS, section) || !file || file.includes('/') || file.includes('..')) {
    throw httpError(400, 'Invalid file path');
  }
  return { path: `${section}/${file}`, section, file };
}

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- app ----------

const app = express();
app.disable('x-powered-by');
if (IS_VERCEL) app.set('trust proxy', 1); // real client IP and https:// for the page's origin

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
  res.status(configErrors.length ? 500 : 200).json({ ok: !configErrors.length, storage: storage.kind, problems: configErrors });
});

app.use('/api', (req, res, next) => {
  if (!configErrors.length) return next();
  res.status(500).json({ error: `Server setup incomplete: ${configErrors.join('; ')}. ${CONFIG_HELP}` });
});

// Cover image (signed link, see signThumbUrl).
app.get(
  '/api/thumb/:id',
  asyncRoute(async (req, res) => {
    const { id } = req.params;
    const exp = Number(req.query.exp);
    const sig = String(req.query.sig || '');
    const expected = thumbSig(id, exp);
    const valid = sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    if (!valid || !(exp * 1000 > Date.now())) throw httpError(403, 'Cover link expired');
    if (!storage.readThumb) throw httpError(404, 'Not found');
    const { type, body } = await storage.readThumb(id);
    res.set({ 'Content-Type': type, 'Cache-Control': 'private, max-age=3600' }).send(body);
  })
);

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

app.get('/api/me', (req, res) => res.json({ username: req.user.sub, storage: storage.kind }));

app.get('/api/sections', (req, res) => res.json(SECTIONS));

// List files in a section
app.get(
  '/api/files',
  asyncRoute(async (req, res) => {
    const section = String(req.query.section || '');
    assertSection(section);
    res.json(await storage.list(section));
  })
);

// File count, total size and latest upload for every section
app.get(
  '/api/stats',
  asyncRoute(async (req, res) => {
    const entries = await Promise.all(
      Object.keys(SECTIONS).map(async (s) => {
        const files = await storage.list(s, { thumbs: false });
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

// Where the browser should send the original file (straight to storage, never through this server).
app.post(
  '/api/files/upload-url',
  asyncRoute(async (req, res) => {
    const { section, name, size, type } = req.body || {};
    assertSection(section);
    const origin = req.get('origin') || `${req.protocol}://${req.get('host')}`;
    const result = await storage.createUpload({ section, name, size: Number(size) || 0, type: String(type || ''), origin });
    res.json({ section, ...result });
  })
);

// Save a file's cover image (a small JPEG made in the browser)
app.post(
  '/api/files/thumb',
  express.raw({ type: 'image/jpeg', limit: '3mb' }),
  asyncRoute(async (req, res) => {
    const ref = parsePath(req.query.path);
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw httpError(400, 'Send the cover as image/jpeg');
    await storage.saveThumb(ref, req.body);
    res.json({ ok: true });
  })
);

// How to download (or preview) a file: a short-lived direct link, or "proxy" = read it in pieces
// from /api/files/content.
app.get(
  '/api/files/download-url',
  asyncRoute(async (req, res) => {
    const ref = parsePath(req.query.path);
    res.json({ ...(await storage.download(ref, { preview: req.query.preview === '1' })), chunkSize: CHUNK_SIZE });
  })
);

// One piece of a file's bytes: ?path=…&start=0&end=4194303 (inclusive, at most 4 MB)
app.get(
  '/api/files/content',
  asyncRoute(async (req, res) => {
    const ref = parsePath(req.query.path);
    const start = Number(req.query.start);
    const end = Number(req.query.end);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) throw httpError(400, 'Invalid range');
    if (!storage.readRange) throw httpError(404, 'Not found');
    const { type, body } = await storage.readRange(ref, start, end);
    res.set({ 'Content-Type': type, 'Cache-Control': 'private, no-store' }).send(body);
  })
);

// Rename a file (keeps it in the same section)
app.patch(
  '/api/files',
  asyncRoute(async (req, res) => {
    const { path: from, name } = req.body || {};
    res.json(await storage.rename(parsePath(from), name));
  })
);

// Delete one or more files
app.delete(
  '/api/files',
  asyncRoute(async (req, res) => {
    const paths = Array.isArray(req.body?.paths) ? req.body.paths : [req.body?.path];
    await storage.remove(paths.map(parsePath));
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
  app.listen(PORT, () => console.log(`MyDoc server listening on http://localhost:${PORT} (storage: ${storage.kind})`));
}

if (!configErrors.length) {
  storage.init().catch((err) => console.error(`Could not prepare ${storage.kind} storage:`, err.message));
}

export default app;
