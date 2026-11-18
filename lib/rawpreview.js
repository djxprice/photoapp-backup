'use strict';
// The JPEG preview inside a camera RAW file (CR2, CR3, NEF, ARW, DNG, ORF,
// RW2, RAF…), for showing old RAW photos on the phone (roadmap Step 26b).
// Almost every RAW format carries one, often full size. Found without any
// library: look for JPEG start markers, walk each JPEG's segments to its end
// (so a thumbnail inside its EXIF doesn't end it early), keep the largest
// that a phone can show. Lossless JPEG (SOF3 and friends) is how CR2 and DNG
// store the sensor data itself: never displayable, so never picked.

const SOI = Buffer.from([0xff, 0xd8, 0xff]);
const SHOWABLE_SOF = new Set([0xc0, 0xc1, 0xc2]); // baseline, extended, progressive
const MIN_PREVIEW = 20 * 1024; // smaller ones are thumbnails

// The end (exclusive) of the JPEG starting at `start`, and its frame type:
// { end, sof }, or null when it isn't a complete JPEG.
function jpegEnd(buf, start) {
  let pos = start + 2;
  let sof = null;
  while (pos + 2 <= buf.length) {
    if (buf[pos] !== 0xff) return null;
    const marker = buf[pos + 1];
    if (marker === 0xff) {
      pos += 1; // fill byte
      continue;
    }
    if (marker === 0xd9) return sof === null ? null : { end: pos + 2, sof };
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      pos += 2; // markers without a length
      continue;
    }
    if (pos + 4 > buf.length) return null;
    const len = buf.readUInt16BE(pos + 2);
    if (len < 2) return null;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (sof === null) sof = marker;
    }
    pos += 2 + len;
    if (marker === 0xda) {
      // Compressed data runs to the next marker that isn't a stuffed FF00, a
      // restart marker or fill.
      while (pos + 1 < buf.length) {
        if (buf[pos] === 0xff) {
          const m = buf[pos + 1];
          if (m === 0x00 || (m >= 0xd0 && m <= 0xd7)) {
            pos += 2;
            continue;
          }
          if (m === 0xff) {
            pos += 1;
            continue;
          }
          break;
        }
        pos += 1;
      }
    }
  }
  return null;
}

// The largest showable JPEG in `buf` (a Buffer slice), or null.
function rawPreview(buf) {
  let best = null;
  let i = 0;
  while ((i = buf.indexOf(SOI, i)) !== -1) {
    const j = jpegEnd(buf, i);
    if (j) {
      if (SHOWABLE_SOF.has(j.sof) && (!best || j.end - i > best.end - best.start)) best = { start: i, end: j.end };
      i = j.end; // past it, and past any thumbnail inside it
    } else {
      i += 2;
    }
  }
  return best && best.end - best.start >= MIN_PREVIEW ? buf.subarray(best.start, best.end) : null;
}

module.exports = { rawPreview, jpegEnd, MIN_PREVIEW };
