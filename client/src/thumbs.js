// Makes small JPEG cover images in the browser:
//   PDF   → first page        EPUB → the book's cover image        photos → scaled down
// Libraries are loaded on first use, so they don't slow down opening the site.

const MAX_W = 360; // 2× the card width, so covers stay sharp on phones/retina screens
const MAX_H = 540;

// Limits for making covers of files already in storage (they must be downloaded first).
// PDFs are read in small chunks, so they need no limit.
const MAX_FETCH = { epub: 60 * 1024 * 1024, image: 25 * 1024 * 1024 };

export function thumbKind(name, type = '') {
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  if (ext === 'pdf' || type === 'application/pdf') return 'pdf';
  if (ext === 'epub' || type === 'application/epub+zip') return 'epub';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif'].includes(ext)) return 'image';
  return null;
}

export function canMakeThumb(file) {
  const kind = thumbKind(file.name, file.type);
  if (!kind) return false;
  return !MAX_FETCH[kind] || !file.size || file.size <= MAX_FETCH[kind];
}

const toJpeg = (canvas) => new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.82));

function canvasFor(w, h) {
  const scale = Math.min(1, MAX_W / w, MAX_H / h);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // JPEG has no transparency
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return { canvas, ctx, scale };
}

async function loadImage(blob) {
  try {
    return await createImageBitmap(blob);
  } catch {
    // e.g. SVG covers: fall back to an <img>
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

async function imageThumb(blob) {
  const img = await loadImage(blob);
  const { canvas, ctx } = canvasFor(img.width, img.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  img.close?.();
  return toJpeg(canvas);
}

let pdfjsPromise;
function loadPdfjs() {
  pdfjsPromise ??= Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]).then(
    ([pdfjs, worker]) => {
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      return pdfjs;
    }
  );
  return pdfjsPromise;
}

async function pdfThumb(source) {
  const pdfjs = await loadPdfjs();
  // From a URL, pdf.js fetches only the parts it needs (range requests) instead of the whole book.
  const doc = await pdfjs.getDocument({ ...source, disableAutoFetch: true, isEvalSupported: false }).promise;
  try {
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    // Render straight at thumbnail size (pdf.js draws text and vectors crisply at any scale).
    const viewport = page.getViewport({ scale: Math.min(MAX_W / base.width, MAX_H / base.height, 2) });
    const { canvas, ctx } = canvasFor(viewport.width, viewport.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    return toJpeg(canvas);
  } finally {
    doc.destroy();
  }
}

// Resolve "a/b/../c.jpg" style paths inside the EPUB zip.
function joinPath(base, href) {
  const out = [];
  for (const part of (base + href).split('/')) {
    if (part === '..') out.pop();
    else if (part && part !== '.') out.push(part);
  }
  return out.join('/');
}

async function epubThumb(bytes) {
  const { unzipSync, strFromU8 } = await import('fflate');
  const readOne = (name) => unzipSync(bytes, { filter: (f) => f.name === name })[name];
  const parse = (u8) => new DOMParser().parseFromString(strFromU8(u8), 'application/xml');

  const container = readOne('META-INF/container.xml');
  if (!container) return null;
  const opfPath = parse(container).getElementsByTagNameNS('*', 'rootfile')[0]?.getAttribute('full-path');
  const opfBytes = opfPath && readOne(opfPath);
  if (!opfBytes) return null;
  const opf = parse(opfBytes);

  const items = [...opf.getElementsByTagNameNS('*', 'item')];
  const attr = (el, n) => el.getAttribute(n) || '';
  const isImage = (i) => attr(i, 'media-type').startsWith('image/');
  const coverId = [...opf.getElementsByTagNameNS('*', 'meta')]
    .find((m) => attr(m, 'name') === 'cover')
    ?.getAttribute('content');
  const item =
    items.find((i) => attr(i, 'properties').split(/\s+/).includes('cover-image')) || // EPUB 3
    items.find((i) => coverId && attr(i, 'id') === coverId && isImage(i)) || // EPUB 2
    items.find((i) => isImage(i) && /cover/i.test(`${attr(i, 'id')} ${attr(i, 'href')}`)) ||
    items.find(isImage);
  if (!item) return null;

  const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const imgBytes = readOne(joinPath(base, decodeURIComponent(attr(item, 'href'))));
  if (!imgBytes) return null;
  return imageThumb(new Blob([imgBytes], { type: attr(item, 'media-type') }));
}

/**
 * @param source a File/Blob being uploaded, or a URL of a stored file
 * @returns a JPEG Blob, or null when no cover can be made (never throws)
 */
export async function makeThumb(source, name, type = '') {
  const kind = thumbKind(name, type);
  if (!kind) return null;
  const isUrl = typeof source === 'string';
  try {
    if (kind === 'pdf') {
      return await pdfThumb(isUrl ? { url: source } : { data: new Uint8Array(await source.arrayBuffer()) });
    }
    const blob = isUrl ? await (await fetch(source)).blob() : source;
    if (kind === 'epub') return await epubThumb(new Uint8Array(await blob.arrayBuffer()));
    return await imageThumb(blob);
  } catch (err) {
    console.warn(`Could not make a cover for ${name}:`, err);
    return null;
  }
}
