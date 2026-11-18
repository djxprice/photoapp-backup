'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { isRaw, yearOf, kindOf, oldPhotos, summary, pickBatch, MAX_BATCH } = require('../lib/old');
const { rawPreview, jpegEnd, MIN_PREVIEW } = require('../lib/rawpreview');
const { jpeg } = require('./jpegs');

const H = (n) => String(n).padStart(32, '0').replace(/[^0-9a-f]/g, 'a');

test('photo kinds and years', () => {
  assert.equal(isRaw('2009/07/IMG_1.CR2'), true);
  assert.equal(isRaw('2009/07/IMG_1.jpg'), false);
  assert.equal(kindOf('a/IMG_1.NEF'), 'raw');
  assert.equal(kindOf('a/IMG_1.HEIC'), 'heic');
  assert.equal(kindOf('a/IMG_1.jpeg'), 'jpeg');
  assert.equal(kindOf('a/x.png'), 'png');
  assert.equal(yearOf('2009/07/IMG_1.jpg'), 2009);
  assert.equal(yearOf('undated/IMG_1.jpg'), null);
});

test('which photos are old photos', () => {
  const photos = {
    [H(1)]: { path: '2009/07/a.jpg', size: 10, from: '2009 camera/a.jpg' },
    [H(2)]: { path: '2026/10/b.jpg', size: 20, from: 'DCIM/Camera/b.jpg' }, // still on the phone
    [H(3)]: { path: '2015/01/c.jpg', size: 30, from: 'DCIM/Camera/c.jpg' }, // freed from the phone
    [H(4)]: { path: '2012/05/d.jpg', size: 40 }, // tagged on the PC
    [H(5)]: { path: '2011/03/e.jpg', size: 50 }, // skipped earlier
    [H(6)]: { path: '2010/02/f.jpg', size: 60 }, // gone from the PC
    [H(7)]: { path: 'undated/g.jpg', size: 70 },
    nothex: { path: '2010/01/x.jpg', size: 1 },
  };
  const list = oldPhotos(photos, {
    done: { [H(5)]: { skipped: true } },
    onPhone: new Set(['DCIM/Camera/b.jpg|20', 'DCIM/Camera/c.jpg|999']), // c is a different file now
    tagged: (p) => p === '2012/05/d.jpg',
    exists: (p) => p !== '2010/02/f.jpg',
  });
  assert.deepEqual(
    list.map((p) => p.path),
    ['2015/01/c.jpg', '2009/07/a.jpg', 'undated/g.jpg']
  );
  assert.deepEqual(list[0], { hash: H(3), path: '2015/01/c.jpg', size: 30 });
  assert.deepEqual(oldPhotos(null), []);
});

test('the summary by year', () => {
  const list = [
    { path: '2015/01/c.jpg' },
    { path: '2009/07/a.jpg' },
    { path: '2009/08/b.jpg' },
    { path: 'undated/g.jpg' },
  ];
  assert.deepEqual(summary(list), {
    total: 4,
    years: [
      { year: 2015, count: 1 },
      { year: 2009, count: 2 },
      { year: null, count: 1 },
    ],
  });
  assert.deepEqual(summary([]), { total: 0, years: [] });
});

test('a batch: count, order, year, leaving out what the phone holds', () => {
  const list = [
    { hash: 'c', path: '2015/01/c.jpg' },
    { hash: 'b', path: '2009/08/b.jpg' },
    { hash: 'a', path: '2009/07/a.jpg' },
    { hash: 'g', path: 'undated/g.jpg' },
  ];
  const ids = (b) => b.map((p) => p.hash).join('');
  assert.equal(ids(pickBatch(list, { count: 2 })), 'cb');
  assert.equal(ids(pickBatch(list, { order: 'oldest' })), 'abcg');
  assert.equal(ids(pickBatch(list, { year: 2009 })), 'ba');
  assert.equal(ids(pickBatch(list, { year: null })), 'g');
  assert.equal(ids(pickBatch(list, { exclude: ['c'], count: 1 })), 'b');
  assert.equal(ids(pickBatch(list, { order: 'random', random: () => 0 })).length, 4);
  assert.equal(pickBatch(list, { count: 0 }).length, 4); // 0 -> the default (20)
  const many = Array.from({ length: 80 }, (_, i) => ({ hash: String(i), path: `2010/01/${i}.jpg` }));
  assert.equal(pickBatch(many, { count: 500 }).length, MAX_BATCH);
});

// ── RAW previews ──
test('finds the end of a JPEG, past a thumbnail inside it', () => {
  const thumb = jpeg({ size: 50 });
  const j = jpeg({ size: 300, inner: thumb });
  const buf = Buffer.concat([Buffer.alloc(7, 0x42), j, Buffer.alloc(5, 0x42)]);
  assert.deepEqual(jpegEnd(buf, 7), { end: 7 + j.length, sof: 0xc0 });
  assert.equal(jpegEnd(Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(20, 0x33)]), 0), null);
});

test('the RAW preview: the largest showable JPEG, never the lossless sensor data', () => {
  const thumb = jpeg({ size: 2000 });
  const preview = jpeg({ size: MIN_PREVIEW + 5000, inner: jpeg({ size: 100 }) });
  const sensor = jpeg({ sof: 0xc3, size: MIN_PREVIEW * 4 }); // lossless: bigger, not showable
  const raw = Buffer.concat([Buffer.from('II*\0junk'), thumb, Buffer.alloc(64, 0), preview, Buffer.alloc(9), sensor]);
  const got = rawPreview(raw);
  assert.ok(got);
  assert.ok(got.equals(preview));
  // Only a thumbnail: no preview.
  assert.equal(rawPreview(Buffer.concat([Buffer.from('MM\0*'), thumb])), null);
  // Nothing at all.
  assert.equal(rawPreview(Buffer.alloc(1000, 7)), null);
});
