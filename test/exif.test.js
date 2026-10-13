'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { readExifDate } = require('../lib/exif');

// Build a minimal JPEG: SOI + APP1(Exif) with IFD0 -> ExifIFD -> tag.
function jpegWithDate({ le = true, original = '2026:07:20 15:46:54', ifd0Date = null } = {}) {
  const tiff = [];
  const u16 = (v) => (le ? [v & 0xff, v >> 8] : [v >> 8, v & 0xff]);
  const u32 = (v) =>
    le
      ? [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, v >>> 24]
      : [v >>> 24, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
  const ascii = (s) => [...Buffer.from(`${s}\0`, 'latin1')];

  const ifd0Entries = ifd0Date ? 2 : 1;
  const ifd0Size = 2 + ifd0Entries * 12 + 4;
  const exifIfdOffset = 8 + ifd0Size;
  const exifIfdSize = 2 + 12 + 4;
  const dataOffset = exifIfdOffset + exifIfdSize;
  const ifd0DateOffset = dataOffset + 20;

  tiff.push(...(le ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(8));
  tiff.push(...u16(ifd0Entries));
  if (ifd0Date) tiff.push(...u16(0x0132), ...u16(2), ...u32(20), ...u32(ifd0DateOffset));
  tiff.push(...u16(0x8769), ...u16(4), ...u32(1), ...u32(exifIfdOffset));
  tiff.push(...u32(0));
  tiff.push(...u16(1), ...u16(0x9003), ...u16(2), ...u32(20), ...u32(dataOffset), ...u32(0));
  tiff.push(...ascii(original));
  if (ifd0Date) tiff.push(...ascii(ifd0Date));

  const app1 = [...Buffer.from('Exif\0\0', 'latin1'), ...tiff];
  const len = app1.length + 2;
  return Buffer.from([0xff, 0xd8, 0xff, 0xe1, len >> 8, len & 0xff, ...app1, 0xff, 0xda]);
}

test('reads DateTimeOriginal (little-endian)', () => {
  assert.strictEqual(readExifDate(jpegWithDate()), '2026:07:20 15:46:54');
});

test('reads DateTimeOriginal (big-endian)', () => {
  assert.strictEqual(readExifDate(jpegWithDate({ le: false })), '2026:07:20 15:46:54');
});

test('returns null for non-JPEG or missing EXIF', () => {
  assert.strictEqual(readExifDate(Buffer.from('not a jpeg')), null);
  assert.strictEqual(readExifDate(Buffer.from([0xff, 0xd8, 0xff, 0xda])), null);
  assert.strictEqual(readExifDate(null), null);
});

module.exports = { jpegWithDate };
