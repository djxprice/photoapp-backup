'use strict';
// Minimal, dependency-free EXIF date reader for JPEG files.
//
// Reads only the APP1/Exif segment and returns the capture date string
// ("YYYY:MM:DD HH:MM:SS") from DateTimeOriginal (0x9003) in the Exif sub-IFD,
// falling back to DateTime (0x0132) in IFD0. Returns null for non-JPEG input
// or when no date is present — callers fall back to other date sources.

const TAG_EXIF_IFD = 0x8769;
const TAG_DATETIME = 0x0132;
const TAG_DATETIME_ORIGINAL = 0x9003;

function readExifDate(buf) {
  if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;

  let pos = 2;
  while (pos + 4 <= buf.length) {
    if (buf[pos] !== 0xff) return null;
    const marker = buf[pos + 1];
    if (marker === 0xda || marker === 0xd9) return null; // start of scan / end
    const len = buf.readUInt16BE(pos + 2);
    if (marker === 0xe1 && buf.toString('latin1', pos + 4, pos + 10) === 'Exif\0\0') {
      return parseTiff(buf, pos + 10, Math.min(buf.length, pos + 2 + len));
    }
    pos += 2 + len;
  }
  return null;
}

function parseTiff(buf, start, end) {
  if (start + 8 > end) return null;
  const order = buf.toString('latin1', start, start + 2);
  const le = order === 'II';
  if (!le && order !== 'MM') return null;
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));

  const readAscii = (entry) => {
    const count = u32(entry + 4);
    const off = count <= 4 ? entry + 8 : start + u32(entry + 8);
    if (off < start || off + count > end) return null;
    return buf.toString('latin1', off, off + count).replace(/\0+$/, '').trim() || null;
  };

  const readIfd = (ifdOffset) => {
    const at = start + ifdOffset;
    if (at + 2 > end) return {};
    const n = u16(at);
    const out = {};
    for (let i = 0; i < n; i++) {
      const entry = at + 2 + i * 12;
      if (entry + 12 > end) break;
      const tag = u16(entry);
      if (tag === TAG_EXIF_IFD) out.exifIfd = u32(entry + 8);
      else if (tag === TAG_DATETIME || tag === TAG_DATETIME_ORIGINAL) out[tag] = readAscii(entry);
    }
    return out;
  };

  const ifd0 = readIfd(u32(start + 4));
  if (ifd0.exifIfd) {
    const exif = readIfd(ifd0.exifIfd);
    if (exif[TAG_DATETIME_ORIGINAL]) return exif[TAG_DATETIME_ORIGINAL];
  }
  return ifd0[TAG_DATETIME] || null;
}

module.exports = { readExifDate };
