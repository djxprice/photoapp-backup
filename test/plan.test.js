'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const {
  isImage,
  isSidecarName,
  fromFileName,
  resolveMonth,
  destinationFor,
  sidecarPathFor,
} = require('../lib/plan');

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

test('resolveMonth trust order: sidecar > exif > filename > modified', () => {
  const all = {
    sidecarCreationTime: new Date(2021, 0, 15).toISOString(),
    exifDate: '2022:02:02 10:00:00',
    fileName: '20230303_101010.jpg',
    phoneModified: new Date(2024, 3, 4).toISOString(),
  };
  assert.strictEqual(resolveMonth(all).source, 'sidecar');
  assert.strictEqual(resolveMonth({ ...all, sidecarCreationTime: null }).source, 'exif');
  assert.deepStrictEqual(
    resolveMonth({ ...all, sidecarCreationTime: null, exifDate: null }),
    { year: 2023, month: 3, source: 'filename' }
  );
  assert.strictEqual(resolveMonth({ phoneModified: all.phoneModified }).source, 'modified');
  assert.strictEqual(resolveMonth({}).source, 'unknown');
});

test('destination paths and clash suffix', () => {
  const m = { year: 2026, month: 7 };
  assert.strictEqual(destinationFor(m, 'IMG_1.jpg', 'abcdef0123'), path.join('2026', '07', 'IMG_1.jpg'));
  assert.strictEqual(
    destinationFor(m, 'IMG_1.jpg', 'abcdef0123', () => true),
    path.join('2026', '07', 'IMG_1_abcdef01.jpg')
  );
  assert.strictEqual(destinationFor({ year: null }, 'x.jpg', 'h'), path.join('undated', 'x.jpg'));
  assert.strictEqual(sidecarPathFor('2026/07/IMG_1.jpg'), '2026/07/IMG_1.json');
});
