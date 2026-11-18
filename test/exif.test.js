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

test('reads the date from TIFF-based RAW files and from EXIF inside other containers', () => {
  const j = jpegWithDate({ original: '2011:03:05 08:09:10' });
  const tiff = j.subarray(j.indexOf('Exif\0\0') + 6, j.length - 2); // the TIFF block alone
  // CR2 / NEF / ARW / DNG: the file starts with the TIFF header.
  assert.strictEqual(readExifDate(Buffer.concat([tiff, Buffer.alloc(100)])), '2011:03:05 08:09:10');
  // HEIC / RAF: "Exif\0\0" and the TIFF somewhere inside.
  const heic = Buffer.concat([Buffer.from('\0\0\0\x18ftypheic'), Buffer.alloc(300, 9), Buffer.from('\0\0\0\x06Exif\0\0', 'latin1'), tiff]);
  assert.strictEqual(readExifDate(heic), '2011:03:05 08:09:10');
  // CR3: a "CMT1" box holding the TIFF.
  const cr3 = Buffer.concat([Buffer.from('\0\0\0\x18ftypcrx '), Buffer.alloc(50, 3), Buffer.from('\0\0\x01\0CMT1'), tiff]);
  assert.strictEqual(readExifDate(cr3), '2011:03:05 08:09:10');
  // Nothing to find.
  assert.strictEqual(readExifDate(Buffer.alloc(500, 0x41)), null);
  assert.strictEqual(readExifDate(Buffer.from('II*\0\xff\xff\xff\xff', 'latin1')), null);
});
