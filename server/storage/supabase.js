// Files in a private Supabase Storage bucket: <section>/<id>__<name>
// Covers: _thumbs/<section>/<id>.jpg
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { sanitizeName } from './util.js';

const THUMBS = '_thumbs';

// Stored as "<id>__<name>" so identical names never clash.
function displayName(objectName) {
  const i = objectName.indexOf('__');
  return i > 0 ? objectName.slice(i + 2) : objectName;
}

function thumbKey(section, file) {
  const id = file.includes('__') ? file.slice(0, file.indexOf('__')) : file;
  return `${THUMBS}/${section}/${id}.jpg`;
}

export function createSupabaseStorage({ url, secretKey, publishableKey, bucketName }) {
  const configErrors = [];
  const missing = [!url && 'SUPABASE_URL', !secretKey && 'SUPABASE_SECRET_KEY'].filter(Boolean);
  if (missing.length) configErrors.push(`missing ${missing.join(', ')}`);
  if (url && !/^https?:\/\/[^\s/]+$/.test(url)) {
    configErrors.push('SUPABASE_URL must look like https://<project-id>.supabase.co');
  }

  let client = null;
  if (!configErrors.length) {
    try {
      client = createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
    } catch (err) {
      configErrors.push(`could not set up Supabase (${err.message})`);
    }
  }
  const bucket = () => client.storage.from(bucketName);

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

  return {
    kind: 'supabase',
    configErrors,

    async init() {
      const { data, error } = await client.storage.getBucket(bucketName);
      if (data) return;
      if (error && !/not found/i.test(error.message)) throw error;
      const { error: createError } = await client.storage.createBucket(bucketName, { public: false });
      if (createError && !/already exists/i.test(createError.message)) throw createError;
      console.log(`Created private storage bucket "${bucketName}".`);
    },

    async list(section, { thumbs = true } = {}) {
      const files = (await listFolder(section)).map((item) => ({
        path: `${section}/${item.name}`,
        name: displayName(item.name),
        size: item.metadata?.size ?? 0,
        type: item.metadata?.mimetype ?? '',
        createdAt: item.created_at,
        updatedAt: item.updated_at,
      }));
      if (!thumbs) return files;
      // Attach a short-lived link to each file's cover, when one exists.
      const existing = new Set((await listFolder(`${THUMBS}/${section}`)).map((t) => `${THUMBS}/${section}/${t.name}`));
      const withThumb = files.filter((f) => existing.has(thumbKey(section, f.path.split('/')[1])));
      if (withThumb.length) {
        const keys = withThumb.map((f) => thumbKey(section, f.path.split('/')[1]));
        const { data, error } = await bucket().createSignedUrls(keys, 60 * 60);
        if (error) throw error;
        const urlByKey = new Map(data.filter((d) => d.signedUrl).map((d) => [d.path, d.signedUrl]));
        for (const f of withThumb) f.thumbUrl = urlByKey.get(thumbKey(section, f.path.split('/')[1])) || null;
      }
      return files;
    },

    // The browser uploads the original bytes straight to Supabase with this one-time link.
    async createUpload({ section, name }) {
      const id = `${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
      const objectPath = `${section}/${id}__${sanitizeName(name)}`;
      const { data, error } = await bucket().createSignedUploadUrl(objectPath);
      if (error) throw error;
      return {
        path: objectPath,
        upload: {
          url: data.signedUrl,
          format: 'multipart',
          headers: { 'x-upsert': 'false', ...(publishableKey ? { apikey: publishableKey } : {}) },
        },
      };
    },

    async download({ path, file }, { preview }) {
      const { data, error } = await bucket().createSignedUrl(path, 60 * 5, {
        download: preview ? false : displayName(file),
      });
      if (error) throw error;
      return { url: data.signedUrl };
    },

    async saveThumb({ section, file }, jpeg) {
      const { error } = await bucket().upload(thumbKey(section, file), jpeg, { upsert: true, contentType: 'image/jpeg' });
      if (error) throw error;
    },

    async rename({ section, file, path: from }, name) {
      const idPart = file.includes('__') ? file.slice(0, file.indexOf('__')) : Date.now().toString(36);
      const to = `${section}/${idPart}__${sanitizeName(name)}`;
      if (to !== from) {
        const { error } = await bucket().move(from, to);
        if (error) throw error;
        // Files without an id get one now, so their cover key changes too (best effort).
        const [oldThumb, newThumb] = [thumbKey(section, file), thumbKey(section, to.split('/')[1])];
        if (oldThumb !== newThumb) await bucket().move(oldThumb, newThumb).catch(() => {});
      }
      return { path: to, name: displayName(to.split('/')[1]) };
    },

    async remove(items) {
      const keys = items.flatMap(({ path, section, file }) => [path, thumbKey(section, file)]);
      const { error } = await bucket().remove(keys); // missing covers are ignored
      if (error) throw error;
    },
  };
}
