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
