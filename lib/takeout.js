'use strict';
// Google Takeout (Google Photos export) support for importing old photos
// (roadmap Step 26b). Takeout puts a .json beside each photo with when it was
// taken and the description the user wrote; its file dates are the export's.
// Pure helpers: the backup reads the files.
//
// Takeout's names for that .json vary:
//   IMG_1.jpg.json                              (classic)
//   IMG_1.jpg.supplemental-metadata.json        (2024 on; often cut short:
//   IMG_1.jpg.supplemental-metad.json, …)       names are capped at 51 chars)
//   IMG_1.jpg(1).json  for  IMG_1(1).jpg        (a second photo of that name)
//   IMG_1.jpg.json     for  IMG_1-edited.jpg    (edited copies share it)
//   a long name cut short, e.g. "Screenshot_2019-07-14-15-22-10-123_com.e.json"

const MAX_NAME = 51;

// The Takeout .json for photo `name` among the .json names in its folder
// (a Set), or null.
function takeoutJsonFor(name, jsons) {
  const tries = [name];
  const edited = /^(.*)-edited(\.[^.]+)$/i.exec(name);
  if (edited) tries.push(edited[1] + edited[2]);
  for (const n of tries) {
    const hit = direct(n, jsons) || duplicate(n, jsons);
    if (hit) return hit;
  }
  // Cut short: a .json whose name, less ".json" (and any part of
  // ".supplemental-metadata"), starts this photo's name, when the full name
  // would have been too long.
  if (`${name}.json`.length > MAX_NAME) {
    let best = null;
    for (const j of jsons) {
      const stem = stemOf(j);
      if (stem.length >= 20 && name.startsWith(stem) && (!best || stem.length > stemOf(best).length)) best = j;
    }
    if (best) return best;
  }
  return null;
}

// "IMG_1.jpg.json", or a (possibly cut short) "IMG_1.jpg.supplemental-metadata.json".
function direct(n, jsons) {
  if (jsons.has(`${n}.json`)) return `${n}.json`;
  for (const j of jsons) {
    if (j.startsWith(`${n}.`) && j.endsWith('.json') && isSupplemental(j.slice(n.length + 1, -5))) return j;
  }
  return null;
}

// "IMG_1(1).jpg" -> "IMG_1.jpg(1).json" or "IMG_1.jpg.supplemental-metadata(1).json".
function duplicate(n, jsons) {
  const m = /^(.*)\((\d+)\)(\.[^.]+)$/.exec(n);
  if (!m) return null;
  const base = m[1] + m[3];
  if (jsons.has(`${base}(${m[2]}).json`)) return `${base}(${m[2]}).json`;
  for (const j of jsons) {
    const tail = j.startsWith(`${base}.`) && j.endsWith(`(${m[2]}).json`) ? j.slice(base.length + 1, -`(${m[2]}).json`.length) : null;
    if (tail !== null && isSupplemental(tail)) return j;
  }
  return null;
}

// "supplemental-metadata" or a cut-short start of it ("supplemental-metad", "supp").
const isSupplemental = (s) => s.length >= 1 && 'supplemental-metadata'.startsWith(s);

function stemOf(j) {
  const s = j.replace(/\.json$/i, '');
  const i = s.lastIndexOf('.');
  return i > 0 && isSupplemental(s.slice(i + 1)) ? s.slice(0, i) : s;
}

// What a Takeout .json says: { takenTime (ISO, UTC) or null, description or
// null }, or null when it isn't a Google Photos record.
function readTakeout(text) {
  let j;
  try {
    j = JSON.parse(String(text).replace(/^﻿/, ''));
  } catch {
    return null;
  }
  if (!j || typeof j !== 'object' || (!j.photoTakenTime && !j.title)) return null;
  const secs = Number(j.photoTakenTime && j.photoTakenTime.timestamp);
  const takenTime = Number.isFinite(secs) && secs > 0 ? new Date(secs * 1000).toISOString() : null;
  const description = typeof j.description === 'string' && j.description.trim() ? j.description.trim() : null;
  return { takenTime, description };
}

module.exports = { takeoutJsonFor, readTakeout };
