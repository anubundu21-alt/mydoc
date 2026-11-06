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

const {
  APP_USERNAME,
  APP_PASSWORD,
  SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY,
  SUPABASE_SECRET_KEY,
  SUPABASE_BUCKET = 'mydoc',
  SESSION_TTL = '12h',
  PORT = 4000,
} = process.env;

for (const [name, value] of Object.entries({ APP_USERNAME, APP_PASSWORD, SUPABASE_URL, SUPABASE_SECRET_KEY })) {
  if (!value) {
    console.error(`Missing required environment variable ${name}. See server/.env.example.`);
    process.exit(1);
  }
}

let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  JWT_SECRET = crypto.randomBytes(48).toString('hex');
  console.warn('JWT_SECRET not set: using a random one. Everyone is logged out when the server restarts.');
}

// Sections map to top-level folders in the bucket.
export const SECTIONS = {
  ebooks: { label: 'Ebooks', group: 'Ebooks' },
  rakesh: { label: 'Rakesh', group: 'Personal Documents' },
  priyanka: { label: 'Priyanka', group: 'Personal Documents' },
  ananya: { label: 'Ananya', group: 'Personal Documents' },
};

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
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

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- app ----------

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));

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

async function listSection(section) {
  const files = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await bucket().list(section, {
      limit: pageSize,
      offset,
      sortBy: { column: 'created_at', order: 'desc' },
    });
    if (error) throw error;
    for (const item of data) {
      if (!item.id || item.name === '.emptyFolderPlaceholder') continue; // skip folders/placeholders
      files.push({
        path: `${section}/${item.name}`,
        name: displayName(item.name),
        size: item.metadata?.size ?? 0,
        type: item.metadata?.mimetype ?? '',
        createdAt: item.created_at,
        updatedAt: item.updated_at,
      });
    }
    if (data.length < pageSize) break;
  }
  return files;
}

// List files in a section
app.get(
  '/api/files',
  asyncRoute(async (req, res) => {
    const section = String(req.query.section || '');
    assertSection(section);
    res.json(await listSection(section));
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
    }
    res.json({ path: to, name: displayName(to.split('/')[1]) });
  })
);

// Delete one or more files
app.delete(
  '/api/files',
  asyncRoute(async (req, res) => {
    const paths = Array.isArray(req.body?.paths) ? req.body.paths : [req.body?.path];
    paths.forEach(assertPath);
    const { error } = await bucket().remove(paths);
    if (error) throw error;
    res.json({ deleted: paths.length });
  })
);

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Serve the built React app in production
const clientDist = path.resolve(__dirname, '../client/dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'Server error' });
});

app.listen(PORT, () => console.log(`MyDoc server listening on http://localhost:${PORT}`));

ensureBucket().catch((err) => console.error('Could not verify/create the storage bucket:', err.message));
