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

// Book details from file metadata. Titles like "Microsoft Word - draft.docx" or "untitled" are dropped.
function cleanText(value, max = 300) {
  const v = Array.isArray(value) ? value.join(', ') : value;
  return String(v || '').replace(/\s+/g, ' ').trim().slice(0, max);
}
function cleanTitle(value, fileName) {
  const t = cleanText(value).replace(/^Microsoft (Word|PowerPoint|Excel) - /i, '');
  const bare = fileName.toLowerCase().replace(/\.[^.]+$/, '');
  if (!t || t.toLowerCase() === bare) return '';
  if (/\.(docx?|indd|pdf|qxd|pptx?|xlsx?|tex|dvi|rtf|odt|epub)$/i.test(t)) return '';
  if (/^(untitled|title|document\d*|unknown|none|book)$/i.test(t)) return '';
  return t;
}
const details = (title, author, keywords, fileName) => ({
  title: cleanTitle(title, fileName),
  author: cleanText(author),
  keywords: cleanText(keywords, 1000),
});

async function pdfAnalyze(source, wantCover, fileName) {
  const pdfjs = await loadPdfjs();
  // From a link or a range reader, pdf.js fetches only the parts it needs instead of the whole book.
  if (source.reader) {
    const { size, read } = source.reader;
    const initial = await read(0, Math.min(size, 65536) - 1);
    const transport = new pdfjs.PDFDataRangeTransport(size, initial);
    transport.requestDataRange = (begin, end) =>
      read(begin, end - 1).then((bytes) => transport.onDataRange(begin, bytes));
    source = { range: transport };
  }
  const doc = await pdfjs.getDocument({ ...source, disableAutoFetch: true, isEvalSupported: false }).promise;
  try {
    const { info = {}, metadata } = await doc.getMetadata().catch(() => ({}));
    const xmp = (k) => {
      try {
        return metadata?.get(k);
      } catch {
        return '';
      }
    };
    const subject = cleanText(info.Subject || xmp('dc:description'));
    const meta = details(
      info.Title || xmp('dc:title'),
      info.Author || xmp('dc:creator'),
      [info.Keywords || xmp('pdf:keywords'), subject.length <= 120 ? subject : ''].filter(Boolean).join(', '),
      fileName
    );
    let cover = null;
    if (wantCover) {
      const page = await doc.getPage(1);
      const base = page.getViewport({ scale: 1 });
      // Render straight at thumbnail size (pdf.js draws text and vectors crisply at any scale).
      const viewport = page.getViewport({ scale: Math.min(MAX_W / base.width, MAX_H / base.height, 2) });
      const { canvas, ctx } = canvasFor(viewport.width, viewport.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      cover = await toJpeg(canvas);
    }
    return { cover, details: meta };
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

async function epubAnalyze(bytes, wantCover, fileName) {
  const { unzipSync, strFromU8 } = await import('fflate');
  const readOne = (name) => unzipSync(bytes, { filter: (f) => f.name === name })[name];
  const parse = (u8) => new DOMParser().parseFromString(strFromU8(u8), 'application/xml');

  const container = readOne('META-INF/container.xml');
  if (!container) return { cover: null, details: details('', '', '', fileName) };
  const opfPath = parse(container).getElementsByTagNameNS('*', 'rootfile')[0]?.getAttribute('full-path');
  const opfBytes = opfPath && readOne(opfPath);
  if (!opfBytes) return { cover: null, details: details('', '', '', fileName) };
  const opf = parse(opfBytes);

  const dc = (tag) => [...opf.getElementsByTagNameNS('*', tag)].map((e) => e.textContent.trim()).filter(Boolean);
  const meta = details(dc('title')[0], dc('creator').join(', '), dc('subject').join(', '), fileName);
  if (!wantCover) return { cover: null, details: meta };

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
  if (!item) return { cover: null, details: meta };

  const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const imgBytes = readOne(joinPath(base, decodeURIComponent(attr(item, 'href'))));
  const cover = imgBytes ? await imageThumb(new Blob([imgBytes], { type: attr(item, 'media-type') })) : null;
  return { cover, details: meta };
}

/**
 * Reads a file once to make its cover and pick up its title/author/keywords.
 * @param source a File/Blob being uploaded, a link to a stored file,
 *               or { size, read(start, endInclusive) → Uint8Array } for a stored file
 * @returns { cover: JPEG Blob | null, details: {title, author, keywords} | null } (never throws)
 */
export async function analyzeFile(source, name, type = '', { cover: wantCover = true } = {}) {
  const kind = thumbKind(name, type);
  if (!kind) return { cover: null, details: null };
  const isUrl = typeof source === 'string';
  const isReader = !isUrl && typeof source?.read === 'function';
  try {
    if (kind === 'pdf') {
      if (isUrl) return await pdfAnalyze({ url: source }, wantCover, name);
      if (isReader) return await pdfAnalyze({ reader: source }, wantCover, name);
      return await pdfAnalyze({ data: new Uint8Array(await source.arrayBuffer()) }, wantCover, name);
    }
    if (kind === 'image' && !wantCover) return { cover: null, details: details('', '', '', name) };
    let blob = source;
    if (isUrl) blob = await (await fetch(source)).blob();
    else if (isReader) blob = new Blob([await source.read(0, source.size - 1)]);
    if (kind === 'epub') return await epubAnalyze(new Uint8Array(await blob.arrayBuffer()), wantCover, name);
    return { cover: await imageThumb(blob), details: details('', '', '', name) };
  } catch (err) {
    console.warn(`Could not read ${name}:`, err);
    return { cover: null, details: null };
  }
}

export async function makeThumb(source, name, type = '') {
  return (await analyzeFile(source, name, type)).cover;
}
