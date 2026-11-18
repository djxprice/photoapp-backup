'use strict';
// Old photos (roadmap Step 26b): photos in the backup that the phone can't
// review in its daily review because they aren't on it: imported folders,
// old cameras, Google Takeout exports, phone photos freed before they were
// reviewed. The receiver offers them to the phone in batches for its "Your
// Old Photos" review. Pure helpers: pc/receiver.js does the reading.

const { extName } = require('./plan');

// Camera RAW files: the phone can't show them, so it gets the JPEG preview
// inside (lib/rawpreview.js).
const RAW_EXTS = new Set(['.dng', '.cr2', '.cr3', '.nef', '.nrw', '.arw', '.orf', '.rw2', '.raf', '.pef', '.srw']);
const MAX_BATCH = 50;

const isRaw = (p) => RAW_EXTS.has(extName(p).toLowerCase());

// The year a photo was filed under ("2009/07/IMG_1.jpg" -> 2009), or null
// for "undated/…".
function yearOf(p) {
  const m = /^(\d{4})\//.exec(String(p || ''));
  return m ? Number(m[1]) : null;
}

// What the phone is shown, by kind: the file as it is, or the JPEG inside a
// RAW file.
function kindOf(p) {
  const ext = extName(p).toLowerCase();
  if (isRaw(p)) return 'raw';
  if (ext === '.heic' || ext === '.heif') return 'heic';
  if (ext === '.png') return 'png';
  if (ext === '.webp') return 'webp';
  return 'jpeg';
}

// Which backed-up photos are old photos to review: in the index (`photos`:
// { [md5]: { path, size, from } }), still on the PC (`exists(path)`), with no
// PicJot tag file (`tagged(path)`), not reviewed before (`done`:
// { [md5]: … }), and not on a phone as of its last backup (`onPhone`: a Set
// of "<phone path>|<size>"; the phone reviews those itself). Newest first,
// as [{ hash, path, size }].
function oldPhotos(photos, { done = {}, onPhone = new Set(), tagged = () => false, exists = () => true } = {}) {
  const out = [];
  for (const [hash, e] of Object.entries(photos || {})) {
    if (!e || typeof e.path !== 'string' || !/^[0-9a-f]{32}$/.test(hash)) continue;
    if (done[hash]) continue;
    if (e.from && onPhone.has(`${e.from}|${e.size}`)) continue;
    if (!exists(e.path) || tagged(e.path)) continue;
    out.push({ hash, path: e.path, size: Number(e.size) || 0 });
  }
  return out.sort(newestFirst);
}

// "2010/01/b.jpg" before "2009/12/a.jpg"; undated ones last.
function newestFirst(a, b) {
  const ya = yearOf(a.path);
  const yb = yearOf(b.path);
  if ((ya === null) !== (yb === null)) return ya === null ? 1 : -1;
  return a.path < b.path ? 1 : a.path > b.path ? -1 : 0;
}

// How many old photos are left, and per year (newest first, undated last as
// year null), for the phone's "Your Old Photos" screen.
function summary(list) {
  const years = new Map();
  for (const p of list) {
    const y = yearOf(p.path);
    years.set(y, (years.get(y) || 0) + 1);
  }
  return {
    total: list.length,
    years: [...years]
      .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : b - a))
      .map(([year, count]) => ({ year, count })),
  };
}

// The next batch: `count` (at most MAX_BATCH) photos, in `order` ('newest',
// 'oldest' or 'random'), from one `year` if given (null: the undated ones),
// leaving out `exclude` (hashes the phone already holds). `random` () -> [0,1).
function pickBatch(list, { count = 20, order = 'newest', year, exclude = [], random = Math.random } = {}) {
  const n = Math.max(1, Math.min(MAX_BATCH, Math.floor(Number(count)) || 20));
  const skip = new Set(exclude);
  let pool = list.filter((p) => !skip.has(p.hash) && (year === undefined || yearOf(p.path) === year));
  if (order === 'oldest') {
    // Undated ones still last.
    pool = [...pool.filter((p) => yearOf(p.path) !== null).reverse(), ...pool.filter((p) => yearOf(p.path) === null)];
  } else if (order === 'random') {
    pool = [...pool];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
  }
  return pool.slice(0, n);
}

module.exports = { RAW_EXTS, MAX_BATCH, isRaw, yearOf, kindOf, oldPhotos, summary, pickBatch };
