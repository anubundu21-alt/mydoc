import path from 'node:path';

// Sections of the site. `folder` is the folder name used in Google Drive.
export const SECTIONS = {
  ebooks: { label: 'Ebooks', group: 'Ebooks', folder: 'Ebooks' },
  rakesh: { label: 'Rakesh', group: 'Personal Documents', folder: 'Rakesh' },
  priyanka: { label: 'Priyanka', group: 'Personal Documents', folder: 'Priyanka' },
  ananya: { label: 'Ananya', group: 'Personal Documents', folder: 'Ananya' },
};

// Largest piece of a file the server sends in one response (Vercel caps responses at 4.5 MB).
export const CHUNK_SIZE = 4 * 1024 * 1024;

export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Keep a file name readable but safe as a storage key.
export function sanitizeName(name) {
  const base = path.basename(String(name || '')).normalize('NFKD');
  const cleaned = base
    .replace(/[^\w.\- ()[\],+&@=]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/_+/g, '_')
    .trim();
  return cleaned.slice(-180) || 'file';
}

// Book details kept as plain lines ("Title: …", "Author: …", "Keywords: a, b") in a file's
// description, so they're readable (and editable) in Google Drive as well.
const DETAIL_FIELDS = [
  ['title', 'Title', 300],
  ['author', 'Author', 300],
  ['keywords', 'Keywords', 1000],
];

export function parseDetails(description = '') {
  const out = {};
  for (const [key, label] of DETAIL_FIELDS) {
    const m = String(description || '').match(new RegExp(`^${label}:[ \\t]*(.*)$`, 'mi'));
    out[key] = m ? m[1].trim() : '';
  }
  return out;
}

export function formatDetails(details = {}) {
  return DETAIL_FIELDS.map(([key, label, max]) => {
    let value = String(details[key] ?? '').replace(/\s+/g, ' ').trim();
    if (key === 'keywords') {
      value = [...new Set(value.split(/[,;]/).map((k) => k.trim()).filter(Boolean))].join(', ');
    }
    return value ? `${label}: ${value.slice(0, max)}` : '';
  })
    .filter(Boolean)
    .join('\n');
}

// Search text → words (quotes and extra spaces dropped), at most 8.
export function searchWords(q) {
  return String(q || '')
    .toLowerCase()
    .replace(/["'\\]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .slice(0, 8);
}
