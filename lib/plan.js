'use strict';
// Pure planning helpers for the PC backup: which files count, when a photo
// was taken, and where it goes. No filesystem access here.
const path = require('path');

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.heic', '.heif', '.png', '.webp', '.dng']);
const SIDECAR_NAME = /^[0-9a-f]{32}\.json$/i;

function isImage(name) {
  return IMAGE_EXTS.has(path.extname(name).toLowerCase());
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

// Best capture month for a photo. Order of trust: PhotoApp sidecar
// creationTime, EXIF, filename stamp, the phone's file-modified date.
function resolveMonth({ sidecarCreationTime, exifDate, fileName, phoneModified }) {
  const tries = [
    ['sidecar', () => fromTime(sidecarCreationTime)],
    ['exif', () => fromExif(exifDate)],
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
  const dir = year ? path.join(String(year), String(month).padStart(2, '0')) : 'undated';
  const rel = path.join(dir, fileName);
  if (!taken(rel)) return rel;
  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext);
  return path.join(dir, `${base}_${hash.slice(0, 8)}${ext}`);
}

// Sidecar path beside a photo: "2026/07/IMG_1.jpg" -> "2026/07/IMG_1.json"
function sidecarPathFor(photoRel) {
  const ext = path.extname(photoRel);
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

module.exports = {
  IMAGE_EXTS,
  isImage,
  isSidecarName,
  fromExif,
  fromFileName,
  fromTime,
  resolveMonth,
  destinationFor,
  sidecarPathFor,
  mostCommonDir,
};
