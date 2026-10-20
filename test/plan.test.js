'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const {
  baseName,
  extName,
  isImage,
  isSidecarName,
  fromFileName,
  resolveMonth,
  destinationFor,
  sidecarPathFor,
  legacySidecarPathFor,
  parseLeadingJson,
  mostCommonDir,
} = require('../lib/plan');

test('baseName and extName match Node, with either separator', () => {
  for (const p of ['IMG_1.jpg', 'a/b/IMG_1.JPG', '.hidden', 'noext', 'a.b.c', 'trail.', 'dir.x/file']) {
    assert.strictEqual(baseName(p), path.posix.basename(p), p);
    assert.strictEqual(extName(p), path.posix.extname(p), p);
  }
  assert.strictEqual(baseName(String.raw`C:\photos\IMG_2.heic`), 'IMG_2.heic');
  assert.strictEqual(extName(String.raw`C:\photos.old\IMG_2`), '');
});

test('mostCommonDir finds the folder holding most files', () => {
  assert.strictEqual(
    mostCommonDir(['DCIM/PhotoTags/a.json', 'DCIM/PhotoTags/b.json', 'Download/c.json']),
    'DCIM/PhotoTags'
  );
  assert.strictEqual(mostCommonDir(['top.json']), null);
  assert.strictEqual(mostCommonDir([]), null);
  assert.strictEqual(mostCommonDir(null), null);
});

test('image and sidecar detection', () => {
  assert.ok(isImage('a.JPG') && isImage('b.heic') && isImage('c.dng'));
  assert.ok(!isImage('clip.mp4') && !isImage('notes.json'));
  assert.ok(isSidecarName('8539b263bc598634d1a024db52d7ec08.json'));
  assert.ok(!isSidecarName('backup-receipt-2026.json'));
});

test('filename date stamps', () => {
  assert.deepStrictEqual(fromFileName('20260720_154654.jpg'), { year: 2026, month: 7 });
  assert.deepStrictEqual(fromFileName('Screenshot_20250102-101010_Chrome.jpg'), { year: 2025, month: 1 });
  assert.deepStrictEqual(fromFileName('PXL_20240315_120000000.jpg'), { year: 2024, month: 3 });
  assert.strictEqual(fromFileName('bcd97c24-921e-40ae-be92-9af6f0a360e1.jpg'), null);
  assert.strictEqual(fromFileName('20261399_000000.jpg'), null);
});

test('resolveMonth trust order: exif > sidecar > filename > modified', () => {
  const all = {
    sidecarCreationTime: new Date(2021, 0, 15).toISOString(),
    exifDate: '2022:02:02 10:00:00',
    fileName: '20230303_101010.jpg',
    phoneModified: new Date(2024, 3, 4).toISOString(),
  };
  assert.deepStrictEqual(resolveMonth(all), { year: 2022, month: 2, source: 'exif' });
  // A downloaded photo: its EXIF date (2025) beats the tag file's time, which
  // was the day it was saved (2026).
  assert.deepStrictEqual(
    resolveMonth({ sidecarCreationTime: '2026-10-12T15:34:30.000Z', exifDate: '2025:10:12 11:30:10' }),
    { year: 2025, month: 10, source: 'exif' }
  );
  assert.strictEqual(resolveMonth({ ...all, exifDate: null }).source, 'sidecar');
  assert.deepStrictEqual(
    resolveMonth({ ...all, sidecarCreationTime: null, exifDate: null }),
    { year: 2023, month: 3, source: 'filename' }
  );
  assert.strictEqual(resolveMonth({ phoneModified: all.phoneModified }).source, 'modified');
  assert.strictEqual(resolveMonth({}).source, 'unknown');
});

test('destination paths and clash suffix', () => {
  const m = { year: 2026, month: 7 };
  // "/"-separated on every system (the app uses these too).
  assert.strictEqual(destinationFor(m, 'IMG_1.jpg', 'abcdef0123'), '2026/07/IMG_1.jpg');
  assert.strictEqual(destinationFor(m, 'IMG_1.jpg', 'abcdef0123', () => true), '2026/07/IMG_1_abcdef01.jpg');
  assert.strictEqual(destinationFor(m, 'IMG.1.tar.jpg', 'abcdef0123', () => true), '2026/07/IMG.1.tar_abcdef01.jpg');
  assert.strictEqual(destinationFor({ year: null }, 'x.jpg', 'h'), 'undated/x.jpg');
  assert.strictEqual(sidecarPathFor('2026/07/IMG_1.jpg'), '2026/07/IMG_1.jpg.json');
  assert.strictEqual(sidecarPathFor('2026/07/IMG_1.dng'), '2026/07/IMG_1.dng.json');
  assert.strictEqual(legacySidecarPathFor('2026/07/IMG_1.jpg'), '2026/07/IMG_1.json');
});

test('parseLeadingJson reads the current record of a file overwritten without truncation', () => {
  const now = JSON.stringify({ contentHash: 'a', cleared: true, note: 'brace } and "quote" inside' });
  const old = JSON.stringify({ contentHash: 'a', caption: 'A much longer older caption', tags: ['x', 'y'], note: '' });
  const mixed = now + old.slice(now.length);
  assert.deepStrictEqual(parseLeadingJson(now), { value: JSON.parse(now), trailing: false });
  assert.deepStrictEqual(parseLeadingJson(mixed), { value: JSON.parse(now), trailing: true });
  assert.deepStrictEqual(parseLeadingJson(`﻿${now}`).value, JSON.parse(now));
  assert.strictEqual(parseLeadingJson('not json'), null);
  assert.strictEqual(parseLeadingJson('{"unterminated": '), null);
});
