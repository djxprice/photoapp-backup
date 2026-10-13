'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runBackup } = require('../backup');

const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');
const quiet = () => {};

function tmp(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `photoapp-${name}-`));
}

function put(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

function sidecar(hash, extra = {}) {
  return JSON.stringify({
    version: 1,
    hashAlgorithm: 'md5',
    contentHash: hash,
    fileName: 'x.jpg',
    creationTime: new Date(2026, 6, 20, 12).toISOString(),
    caption: 'Sourdough starter',
    tags: ['baking'],
    note: '',
    significance: 'important',
    ...extra,
  });
}

test('organises by month, attaches sidecars, writes index + receipt, leaves source untouched', async () => {
  const src = tmp('src');
  const dest = tmp('dest');
  const tagged = Buffer.from('tagged-photo-bytes');
  const plain = Buffer.from('plain-photo-bytes');
  put(src, 'DCIM/Camera/20260720_154654.jpg', tagged);
  put(src, 'Pictures/Messages/20250105_080000.jpg', plain);
  put(src, `DCIM/photoAppMetadada/${md5(tagged)}.json`, sidecar(md5(tagged)));
  put(src, 'DCIM/Camera/clip.mp4', 'video'); // ignored

  const r = await runBackup({ to: dest, from: src, log: quiet });

  assert.strictEqual(r.copied, 2);
  assert.deepStrictEqual(r.errors, []);
  assert.ok(fs.existsSync(path.join(dest, '2026', '07', '20260720_154654.jpg')));
  assert.ok(fs.existsSync(path.join(dest, '2025', '01', '20250105_080000.jpg')));
  const meta = JSON.parse(fs.readFileSync(path.join(dest, '2026', '07', '20260720_154654.json'), 'utf8'));
  assert.strictEqual(meta.caption, 'Sourdough starter');
  assert.strictEqual(meta.photoFile, '20260720_154654.jpg');
  assert.ok(!fs.existsSync(path.join(dest, '2026', '07', 'clip.mp4')));

  const index = JSON.parse(fs.readFileSync(path.join(dest, '.photoapp', 'index.json'), 'utf8'));
  assert.strictEqual(Object.keys(index.photos).length, 2);
  assert.strictEqual(index.photos[md5(tagged)].tagged, true);

  const receipt = JSON.parse(fs.readFileSync(r.receiptFile, 'utf8'));
  assert.strictEqual(receipt.version, 2);
  assert.deepStrictEqual(
    receipt.photos.map((p) => p.hash),
    [md5(tagged), md5(plain)].sort()
  );
  const tagEntry = receipt.photos.find((p) => p.hash === md5(tagged));
  assert.strictEqual(tagEntry.from, 'DCIM/Camera/20260720_154654.jpg');
  assert.strictEqual(tagEntry.size, tagged.length);

  // Source untouched.
  assert.ok(fs.existsSync(path.join(src, 'DCIM', 'Camera', '20260720_154654.jpg')));
});

test('re-runs are idempotent and dedupe renamed copies by hash', async () => {
  const src = tmp('src');
  const dest = tmp('dest');
  const bytes = Buffer.from('same-photo');
  put(src, 'DCIM/Camera/20260101_000000.jpg', bytes);

  await runBackup({ to: dest, from: src, log: quiet });
  put(src, 'Download/copy-of-it.jpg', bytes); // same content, different name/place
  const r2 = await runBackup({ to: dest, from: src, log: quiet });

  assert.strictEqual(r2.copied, 0);
  assert.strictEqual(r2.present, 2);
  assert.strictEqual(r2.receiptFile, null, 'inventory unchanged: no new receipt');
  const files = fs.readdirSync(path.join(dest, '2026', '01'));
  assert.deepStrictEqual(files, ['20260101_000000.jpg']);
});

test('different photos with the same name get a hash suffix', async () => {
  const a = tmp('a');
  const b = tmp('b');
  const dest = tmp('dest');
  const one = Buffer.from('first');
  const two = Buffer.from('second');
  put(a, 'DCIM/Camera/20260101_000000.jpg', one);
  put(b, 'Pictures/20260101_000000.jpg', two);

  await runBackup({ to: dest, from: a, log: quiet });
  await runBackup({ to: dest, from: b, log: quiet });

  const files = fs.readdirSync(path.join(dest, '2026', '01')).sort();
  assert.deepStrictEqual(files, ['20260101_000000.jpg', `20260101_000000_${md5(two).slice(0, 8)}.jpg`]);
});

test('a sidecar whose photo arrives later is attached on a later run', async () => {
  const s1 = tmp('s1');
  const s2 = tmp('s2');
  const dest = tmp('dest');
  const bytes = Buffer.from('late-photo');
  put(s1, `DCIM/photoAppMetadada/${md5(bytes)}.json`, sidecar(md5(bytes)));

  const r1 = await runBackup({ to: dest, from: s1, log: quiet });
  assert.strictEqual(r1.orphans, 1);

  put(s2, 'Pictures/Messages/20260720_120000.jpg', bytes);
  const r2 = await runBackup({ to: dest, from: s2, log: quiet });
  assert.strictEqual(r2.copied, 1);
  assert.ok(fs.existsSync(path.join(dest, '2026', '07', '20260720_120000.json')));
  assert.deepStrictEqual(fs.readdirSync(path.join(dest, '.photoapp', 'orphan-sidecars')), []);
});

test('phone mode: only handled files are marked pulled; staged photos are moved', async () => {
  const dest = tmp('dest');
  const staging = path.join(dest, '.photoapp', 'staging');
  const bytes = Buffer.from('phone-photo');
  const pull = async () => {
    put(staging, 'DCIM/Camera/20260720_154654.jpg', bytes);
    return {
      phone: 'Test Phone',
      errors: [],
      files: [
        { rel: 'DCIM/Camera/20260720_154654.jpg', size: bytes.length, modified: '', sig: 'a', kind: 'image', already: false, staged: true },
        { rel: 'DCIM/Camera/failed.jpg', size: 9, modified: '', sig: 'b', kind: 'image', already: false, staged: false },
      ],
    };
  };
  let pushed = null;
  const push = async ({ file }) => {
    pushed = file;
    return { pushed: true, errors: [] };
  };

  const r = await runBackup({ to: dest, pull, push, log: quiet });

  assert.strictEqual(r.copied, 1);
  assert.ok(r.receiptPushed);
  assert.strictEqual(pushed, r.receiptFile);
  const pulled = JSON.parse(fs.readFileSync(path.join(dest, '.photoapp', 'pulled.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(pulled), ['DCIM/Camera/20260720_154654.jpg']);
  assert.ok(!fs.existsSync(staging), 'staging emptied and removed');
});

test('dry run copies nothing', async () => {
  const src = tmp('src');
  const dest = tmp('dest');
  put(src, 'DCIM/Camera/20260101_000000.jpg', 'x');
  const r = await runBackup({ to: dest, from: src, dryRun: true, log: quiet });
  assert.strictEqual(r.newPhotos, 1);
  assert.ok(!fs.existsSync(path.join(dest, '2026')));
});
