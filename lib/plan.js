'use strict';
// Pure planning helpers for the PC backup: which files count, when a photo
// was taken, and where it goes. No filesystem access here, and no Node
// modules: the app's backup to a USB stick (src/lib/stickBackup.js) uses
// them too, so a stick gets the same layout as the PC. Paths are
// "/"-separated (Node on Windows accepts them).

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.heic', '.heif', '.png', '.webp', '.dng']);
const SIDECAR_NAME = /^[0-9a-f]{32}\.json$/i;

// As Node's path.extname / path.basename, for "/" or "\" separated paths.
function baseName(p) {
  return String(p).split(/[\\/]/).pop();
}

function extName(p) {
  const base = baseName(p);
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i) : '';
}

function isImage(name) {
  return IMAGE_EXTS.has(extName(name).toLowerCase());
}

// PhotoApp sidecars are named "<md5>.json"; receipts and other JSON are not.
function isSidecarName(name) {
  return SIDECAR_NAME.test(name);
}

function valid(y, m) {
  return y >= 1990 && y <= 2100 && m >= 1 && m <= 12;
}

// EXIF "YYYY:MM:DD HH:MM:SS" -> { year, month }
function fromExif(s) {
  const m = /^(\d{4})[:-](\d{2})[:-](\d{2})/.exec(s || '');
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  return valid(year, month) ? { year, month } : null;
}

// Common camera/app filename stamps: 20260720_154654, IMG_20260720_…,
// Screenshot_20260720-…, PXL_20260720…, 2026-07-20 …
function fromFileName(name) {
  const m = /(?:^|[^\d])(20\d{2})[-_]?(\d{2})[-_]?(\d{2})(?:[-_ T]?\d{2})?/.exec(name || '');
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  return valid(year, month) && day >= 1 && day <= 31 ? { year, month } : null;
}

function fromTime(value) {
  if (value == null || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  return valid(year, month) ? { year, month } : null;
}

// Best capture month for a photo. Order of trust: the camera's EXIF date,
// PicJot's tag file creationTime, a date in the file name, the phone's
// file-modified date. EXIF first since 2026-10-19: the tag file has the
// phone's "date taken", which Android leaves unset for some photos (e.g. a
// downloaded one whose EXIF date has no time zone) and the app then fills in
// with the date the file was saved; a photo from a 2025 hike, downloaded in
// 2026, was filed under 2026. When Android did set it, it came from the EXIF
// date anyway. The tag file still dates what EXIF can't (HEIC, RAW, PNG).
function resolveMonth({ sidecarCreationTime, exifDate, fileName, phoneModified }) {
  const tries = [
    ['exif', () => fromExif(exifDate)],
    ['sidecar', () => fromTime(sidecarCreationTime)],
    ['filename', () => fromFileName(fileName)],
    ['modified', () => fromTime(phoneModified)],
  ];
  for (const [source, get] of tries) {
    const r = get();
    if (r) return { ...r, source };
  }
  return { year: null, month: null, source: 'unknown' };
}

// Relative destination path: "YYYY/MM/<name>", or "undated/<name>".
// `taken(rel)` says whether a relative path is already used by a DIFFERENT
// photo; on a clash the name gets a short hash suffix.
function destinationFor({ year, month }, fileName, hash, taken = () => false) {
  const dir = year ? `${year}/${String(month).padStart(2, '0')}` : 'undated';
  const rel = `${dir}/${fileName}`;
  if (!taken(rel)) return rel;
  const ext = extName(fileName);
  const base = fileName.slice(0, fileName.length - ext.length);
  return `${dir}/${base}_${hash.slice(0, 8)}${ext}`;
}

// Tag file beside a photo, named after the full photo file name (the Google
// Takeout convention): "2026/07/IMG_1.jpg" -> "2026/07/IMG_1.jpg.json". A
// RAW+JPEG pair ("IMG_1.jpg" + "IMG_1.dng") therefore gets two files.
function sidecarPathFor(photoRel) {
  return `${photoRel}.json`;
}

// The name used before 2026-10-15 ("2026/07/IMG_1.json"), where a RAW+JPEG
// pair overwrote each other's tags. Only for migrating old backups.
function legacySidecarPathFor(photoRel) {
  const ext = extName(photoRel);
  return photoRel.slice(0, photoRel.length - ext.length) + '.json';
}

// The folder ("/"-separated) that holds the most of the given files, e.g. the
// phone folder the user keeps PhotoApp's tag files in. Null if none.
function mostCommonDir(rels) {
  const counts = new Map();
  for (const rel of rels || []) {
    const i = String(rel).lastIndexOf('/');
    if (i <= 0) continue;
    const dir = rel.slice(0, i);
    counts.set(dir, (counts.get(dir) || 0) + 1);
  }
  let best = null;
  let bestCount = 0;
  for (const [dir, n] of counts) {
    if (n > bestCount) {
      best = dir;
      bestCount = n;
    }
  }
  return best;
}

// Parse a tag file's text. Android's folder access (SAF) doesn't truncate a
// file it overwrites, so a phone tag file rewritten with shorter content keeps
// the old tail after the new record ("{...new...}ationTime": ..."). The new
// record always starts at the beginning, so the first complete JSON object is
// the current one. Returns { value, trailing } (trailing: leftover bytes were
// ignored), or null if there is no complete object.
function parseLeadingJson(text) {
  const s = String(text).replace(/^\uFEFF/, '');
  try {
    return { value: JSON.parse(s), trailing: false };
  } catch {
    // fall through: look for the first complete object
  }
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return { value: JSON.parse(s.slice(start, i + 1)), trailing: true };
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

module.exports = {
  IMAGE_EXTS,
  baseName,
  extName,
  isImage,
  isSidecarName,
  fromExif,
  fromFileName,
  fromTime,
  resolveMonth,
  destinationFor,
  sidecarPathFor,
  legacySidecarPathFor,
  parseLeadingJson,
  mostCommonDir,
};
