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
  const meta = JSON.parse(fs.readFileSync(path.join(dest, '2026', '07', '20260720_154654.jpg.json'), 'utf8'));
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
  assert.ok(fs.existsSync(path.join(dest, '2026', '07', '20260720_120000.jpg.json')));
  assert.deepStrictEqual(fs.readdirSync(path.join(dest, '.photoapp', 'orphan-sidecars')), []);
});

test('phone mode: only handled files are marked pulled; staged photos are moved', async () => {
  const dest = tmp('dest');
  const staging = path.join(dest, '.photoapp', 'staging');
  const bytes = Buffer.from('phone-photo');
  // The tag folder is deliberately NOT the author's folder name: the receipt
  // must go wherever the tag files actually are.
  const sidecarRel = `DCIM/PhotoTags/${md5(bytes)}.json`;
  const pull = async () => {
    put(staging, 'DCIM/Camera/20260720_154654.jpg', bytes);
    put(staging, sidecarRel, sidecar(md5(bytes)));
    return {
      phone: 'Test Phone',
      errors: [],
      files: [
        { rel: 'DCIM/Camera/20260720_154654.jpg', size: bytes.length, modified: '', sig: 'a', kind: 'image', already: false, staged: true },
        { rel: 'DCIM/Camera/failed.jpg', size: 9, modified: '', sig: 'b', kind: 'image', already: false, staged: false },
        { rel: sidecarRel, size: 10, modified: '', sig: 'c', kind: 'sidecar', already: false, staged: true },
      ],
    };
  };
  const pushes = [];
  const push = async ({ file, folder }) => {
    pushes.push({ name: path.basename(file), folder });
    return { pushed: true, errors: [] };
  };

  const r = await runBackup({ to: dest, pull, push, log: quiet });

  assert.strictEqual(r.copied, 1);
  assert.ok(r.receiptPushed);
  assert.ok(r.tagsMarkerPushed);
  assert.deepStrictEqual(pushes.map((x) => x.folder), ['DCIM/PhotoTags', 'DCIM/PhotoTags']);
  assert.strictEqual(pushes[0].name, path.basename(r.receiptFile));
  assert.match(pushes[1].name, /^tags-synced-.*\.json$/);
  const pulled = JSON.parse(fs.readFileSync(path.join(dest, '.photoapp', 'pulled.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(pulled).sort(), ['DCIM/Camera/20260720_154654.jpg', sidecarRel].sort());
  assert.ok(!fs.existsSync(staging), 'staging emptied and removed');
});

test('phone mode with no tag files: the receipt is not pushed, and that is not an error', async () => {
  const dest = tmp('dest');
  const staging = path.join(dest, '.photoapp', 'staging');
  const bytes = Buffer.from('untagged-photo');
  const pull = async () => {
    put(staging, 'DCIM/Camera/20260720_154654.jpg', bytes);
    return {
      phone: 'Test Phone',
      errors: [],
      files: [{ rel: 'DCIM/Camera/20260720_154654.jpg', size: bytes.length, modified: '', sig: 'a', kind: 'image', already: false, staged: true }],
    };
  };
  let pushCalls = 0;
  const push = async () => {
    pushCalls += 1;
    return { pushed: true, errors: [] };
  };
  const logs = [];

  const r = await runBackup({ to: dest, pull, push, log: (m) => logs.push(m) });

  assert.strictEqual(r.copied, 1);
  assert.strictEqual(pushCalls, 0);
  assert.strictEqual(r.receiptPushed, false);
  assert.deepStrictEqual(r.errors, []);
  assert.ok(logs.some((m) => /No PicJot tag folder/.test(m)));
});

test('a photo missing on the PC is copied again and never claimed in a receipt', async () => {
  const src = tmp('src');
  const dest = tmp('dest');
  const a = Buffer.from('photo-a');
  const b = Buffer.from('photo-b');
  put(src, 'DCIM/Camera/20260101_000001.jpg', a);
  put(src, 'DCIM/Camera/20260101_000002.jpg', b);
  await runBackup({ to: dest, from: src, log: quiet });

  // A's PC copy disappears, but the source still has it: it is copied again.
  fs.unlinkSync(path.join(dest, '2026', '01', '20260101_000001.jpg'));
  const r2 = await runBackup({ to: dest, from: src, log: quiet });
  assert.strictEqual(r2.missingOnPc, 1);
  assert.strictEqual(r2.copied, 1);
  assert.ok(fs.existsSync(path.join(dest, '2026', '01', '20260101_000001.jpg')));

  // A's PC copy disappears AND the source no longer has it: the receipt must
  // not list it as safely on the PC.
  fs.unlinkSync(path.join(dest, '2026', '01', '20260101_000001.jpg'));
  fs.unlinkSync(path.join(src, 'DCIM', 'Camera', '20260101_000001.jpg'));
  const r3 = await runBackup({ to: dest, from: src, log: quiet });
  assert.strictEqual(r3.missingOnPc, 1);
  const receipt = JSON.parse(fs.readFileSync(r3.receiptFile, 'utf8'));
  assert.deepStrictEqual(receipt.photos.map((p) => p.hash), [md5(b)]);
  const index = JSON.parse(fs.readFileSync(path.join(dest, '.photoapp', 'index.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(index.photos), [md5(b)]);
});

test('a newer tag file replaces an older one still waiting for its photo', async () => {
  const s1 = tmp('s1');
  const s2 = tmp('s2');
  const s3 = tmp('s3');
  const dest = tmp('dest');
  const bytes = Buffer.from('photo-with-edits');
  const h = md5(bytes);

  // Run 1: the tag file arrives before its photo (caption A) and waits.
  put(s1, `DCIM/PhotoTags/${h}.json`, sidecar(h, { caption: 'A' }));
  await runBackup({ to: dest, from: s1, log: quiet });

  // Run 2: the edited tag file (caption B) and the photo arrive together.
  put(s2, `DCIM/PhotoTags/${h}.json`, sidecar(h, { caption: 'B' }));
  put(s2, 'DCIM/Camera/20260720_120000.jpg', bytes);
  await runBackup({ to: dest, from: s2, log: quiet });
  const metaFile = path.join(dest, '2026', '07', '20260720_120000.jpg.json');
  assert.strictEqual(JSON.parse(fs.readFileSync(metaFile, 'utf8')).caption, 'B');
  assert.deepStrictEqual(fs.readdirSync(path.join(dest, '.photoapp', 'orphan-sidecars')), []);

  // Run 3 (nothing new): the stale waiting copy must not come back.
  await runBackup({ to: dest, from: s3, log: quiet });
  assert.strictEqual(JSON.parse(fs.readFileSync(metaFile, 'utf8')).caption, 'B');
});

test('redacted-hash tag files are reported, not left waiting; other .json files are ignored', async () => {
  const src = tmp('src');
  const dest = tmp('dest');
  const red = 'c'.repeat(32);
  put(src, `DCIM/PhotoTags/${red}.json`, sidecar(red, { hashSource: 'redacted' }));
  put(src, `Download/${'d'.repeat(32)}.json`, JSON.stringify({ something: 'else' }));

  const r = await runBackup({ to: dest, from: src, log: quiet });

  assert.strictEqual(r.redacted, 1);
  assert.strictEqual(r.ignoredJson, 1);
  assert.strictEqual(r.orphans, 0);
  assert.deepStrictEqual(r.errors, []);
});

test('dry run copies nothing', async () => {
  const src = tmp('src');
  const dest = tmp('dest');
  put(src, 'DCIM/Camera/20260101_000000.jpg', 'x');
  const r = await runBackup({ to: dest, from: src, dryRun: true, log: quiet });
  assert.strictEqual(r.newPhotos, 1);
  assert.ok(!fs.existsSync(path.join(dest, '2026')));
});

// A full phone-mode backup of one tagged photo (tag folder DCIM/PhotoTags), so
// later runs know the tag folder. Returns the paths involved.
async function backedUpTaggedPhoto(dest, caption = 'A') {
  const staging = path.join(dest, '.photoapp', 'staging');
  const bytes = Buffer.from(`tagged-photo-${caption}`);
  const hash = md5(bytes);
  const tagRel = `DCIM/PhotoTags/${hash}.json`;
  const pull = async () => {
    put(staging, 'DCIM/Camera/20260720_154654.jpg', bytes);
    put(staging, tagRel, sidecar(hash, { caption }));
    return {
      phone: 'Test Phone',
      errors: [],
      files: [
        { rel: 'DCIM/Camera/20260720_154654.jpg', size: bytes.length, modified: '', sig: 'a', kind: 'image', already: false, staged: true },
        { rel: tagRel, size: 10, modified: '', sig: 't1', kind: 'sidecar', already: false, staged: true },
      ],
    };
  };
  const push = async () => ({ pushed: true, errors: [] });
  await runBackup({ to: dest, pull, push, log: quiet });
  return { staging, hash, tagRel, metaFile: path.join(dest, '2026', '07', '20260720_154654.jpg.json') };
}

test('a "cleared" tag file deletes the PC copy of the tags; a missing one deletes nothing', async () => {
  const s1 = tmp('s1');
  const s2 = tmp('s2');
  const dest = tmp('dest');
  const a = Buffer.from('photo-a');
  const b = Buffer.from('photo-b');
  put(s1, 'DCIM/Camera/20260720_120000.jpg', a);
  put(s1, 'DCIM/Camera/20260721_120000.jpg', b);
  put(s1, `DCIM/PhotoTags/${md5(a)}.json`, sidecar(md5(a), { caption: 'A' }));
  put(s1, `DCIM/PhotoTags/${md5(b)}.json`, sidecar(md5(b), { caption: 'B' }));
  await runBackup({ to: dest, from: s1, log: quiet });
  const metaA = path.join(dest, '2026', '07', '20260720_120000.jpg.json');
  const metaB = path.join(dest, '2026', '07', '20260721_120000.jpg.json');
  assert.ok(fs.existsSync(metaA) && fs.existsSync(metaB));

  // A's tags were cleared on the phone (cleared tag file); B's tag file is
  // simply absent from this listing (e.g. the photo was deleted on the phone).
  put(s2, `DCIM/PhotoTags/${md5(a)}.json`, JSON.stringify({
    version: 2, hashAlgorithm: 'md5', hashSource: 'original', contentHash: md5(a),
    fileName: '20260720_120000.jpg', cleared: true, updatedAt: '2026-10-15T09:00:00.000Z',
  }));
  const r = await runBackup({ to: dest, from: s2, log: quiet });

  assert.strictEqual(r.tagsRemoved, 1);
  assert.ok(!fs.existsSync(metaA), "A's PC tag file is deleted");
  assert.ok(fs.existsSync(metaB), "B's PC tag file is kept");
  assert.strictEqual(r.tagged, 1);
  assert.ok(fs.existsSync(path.join(dest, '2026', '07', '20260720_120000.jpg')), 'the photo itself stays');
});

test('a "cleared" tag file for a photo not on the PC creates nothing and drops a waiting copy', async () => {
  const s1 = tmp('s1');
  const s2 = tmp('s2');
  const dest = tmp('dest');
  const h = md5(Buffer.from('not-backed-up-yet'));
  put(s1, `DCIM/PhotoTags/${h}.json`, sidecar(h, { caption: 'waiting' }));
  await runBackup({ to: dest, from: s1, log: quiet });
  const orphans = path.join(dest, '.photoapp', 'orphan-sidecars');
  assert.deepStrictEqual(fs.readdirSync(orphans), [`${h}.json`]);

  put(s2, `DCIM/PhotoTags/${h}.json`, JSON.stringify({
    version: 2, hashAlgorithm: 'md5', contentHash: h, cleared: true, updatedAt: '2026-10-15T09:00:00.000Z',
  }));
  const r = await runBackup({ to: dest, from: s2, log: quiet });
  assert.strictEqual(r.orphans, 0);
  assert.deepStrictEqual(fs.readdirSync(orphans), []);
});

test('tags only: reads just the tag folder, updates tags, copies no photos, writes no receipt, sends the marker', async () => {
  const dest = tmp('dest');
  const { staging, hash, tagRel, metaFile } = await backedUpTaggedPhoto(dest, 'A');
  const receiptsBefore = fs.readdirSync(path.join(dest, '.photoapp', 'receipts')).length;

  let pullArgs = null;
  const pull = async (args) => {
    pullArgs = args;
    put(staging, tagRel, sidecar(hash, { caption: 'B (edited on the phone)' }));
    return {
      phone: 'Test Phone',
      errors: [],
      files: [{ rel: tagRel, size: 12, modified: '', sig: 't2', kind: 'sidecar', already: false, staged: true }],
    };
  };
  const pushes = [];
  const push = async ({ file, folder }) => {
    pushes.push({ name: path.basename(file), folder, body: JSON.parse(fs.readFileSync(file, 'utf8')) });
    return { pushed: true, errors: [] };
  };
  const logs = [];
  const r = await runBackup({
    to: dest, tagsOnly: true, pull, push, log: (m) => logs.push(m),
    now: () => new Date('2026-10-15T09:30:00.000Z'),
  });

  assert.strictEqual(pullArgs.only, 'DCIM/PhotoTags');
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.copied, 0);
  assert.strictEqual(r.receiptFile, null);
  assert.strictEqual(fs.readdirSync(path.join(dest, '.photoapp', 'receipts')).length, receiptsBefore);
  assert.strictEqual(JSON.parse(fs.readFileSync(metaFile, 'utf8')).caption, 'B (edited on the phone)');
  assert.strictEqual(pushes.length, 1);
  assert.strictEqual(pushes[0].folder, 'DCIM/PhotoTags');
  assert.match(pushes[0].name, /^tags-synced-2026-10-15T09-30-00-000Z\.json$/);
  assert.strictEqual(pushes[0].body.type, 'photoapp-tag-sync');
  assert.strictEqual(pushes[0].body.syncedAt, '2026-10-15T09:30:00.000Z');
  assert.ok(logs.some((m) => /^Tags synced: 1 tag file\(s\) updated/.test(m)));
  assert.ok(!fs.existsSync(path.join(dest, '.photoapp', 'tag-sync', pushes[0].name)), 'local marker removed once delivered');
});

test('tags only before any full backup: explains, changes nothing', async () => {
  const dest = tmp('dest');
  let pulled = false;
  const pull = async () => {
    pulled = true;
    return { phone: 'Test Phone', errors: [], files: [] };
  };
  const r = await runBackup({ to: dest, tagsOnly: true, pull, push: async () => ({ pushed: true, errors: [] }), log: quiet });
  assert.strictEqual(pulled, false);
  assert.strictEqual(r.errors.length, 1);
  assert.match(r.errors[0], /Run a full backup once/);
});

test('no tags-synced marker when a tag file could not be read from the phone', async () => {
  const dest = tmp('dest');
  const { tagRel } = await backedUpTaggedPhoto(dest, 'A');
  const pull = async () => ({
    phone: 'Test Phone',
    errors: ['timed out copying a tag file (will retry next run)'],
    files: [{ rel: tagRel, size: 12, modified: '', sig: 't3', kind: 'sidecar', already: false, staged: false }],
  });
  const pushes = [];
  const push = async ({ file }) => {
    pushes.push(path.basename(file));
    return { pushed: true, errors: [] };
  };
  const r = await runBackup({ to: dest, tagsOnly: true, pull, push, log: quiet });
  assert.strictEqual(r.tagsMarkerPushed, false);
  assert.deepStrictEqual(pushes, []);
});

test('a RAW+JPEG pair with the same name keeps a tag file each', async () => {
  const src = tmp('src');
  const dest = tmp('dest');
  const jpg = Buffer.from('jpeg-bytes');
  const dng = Buffer.from('raw-bytes');
  put(src, 'DCIM/Camera/20260910_195825.jpg', jpg);
  put(src, 'DCIM/Camera/20260910_195825.dng', dng);
  put(src, `DCIM/PhotoTags/${md5(jpg)}.json`, sidecar(md5(jpg), { caption: 'jpeg', creationTime: new Date(2026, 8, 10, 19).toISOString() }));
  put(src, `DCIM/PhotoTags/${md5(dng)}.json`, sidecar(md5(dng), { caption: 'raw', creationTime: new Date(2026, 8, 10, 19).toISOString() }));

  const r = await runBackup({ to: dest, from: src, log: quiet });

  assert.strictEqual(r.tagged, 2);
  const dir = path.join(dest, '2026', '09');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, '20260910_195825.jpg.json'), 'utf8')).caption, 'jpeg');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, '20260910_195825.dng.json'), 'utf8')).caption, 'raw');
});

test('old <name>.json tag files are renamed; one lost to a RAW+JPEG clash is copied from the phone again', async () => {
  const dest = tmp('dest');
  const staging = path.join(dest, '.photoapp', 'staging');
  const jpg = Buffer.from('pair-jpeg');
  const dng = Buffer.from('pair-raw');
  const hj = md5(jpg);
  const hd = md5(dng);
  const tagJ = `DCIM/PhotoTags/${hj}.json`;
  const tagD = `DCIM/PhotoTags/${hd}.json`;
  // An older backup: both photos tagged, but only one old-style shared file
  // (the RAW's tags overwrote the JPEG's).
  put(dest, '2026/09/20260910_195825.jpg', jpg);
  put(dest, '2026/09/20260910_195825.dng', dng);
  put(dest, '2026/09/20260910_195825.json', sidecar(hd, { caption: 'raw' }));
  put(dest, '.photoapp/index.json', JSON.stringify({
    version: 1,
    photos: {
      [hj]: { path: '2026/09/20260910_195825.jpg', size: jpg.length, from: 'DCIM/Camera/20260910_195825.jpg', tagged: true },
      [hd]: { path: '2026/09/20260910_195825.dng', size: dng.length, from: 'DCIM/Camera/20260910_195825.dng', tagged: true },
    },
  }));
  put(dest, '.photoapp/pulled.json', JSON.stringify({ [tagJ]: 'old', [tagD]: 'old' }));
  put(dest, '.photoapp/receipt-state.json', JSON.stringify({ photoCount: 2, sidecarFolder: 'DCIM/PhotoTags' }));

  // Tags-only run: the phone still has both tag files; only the JPEG's is re-copied.
  let pulledSeen = null;
  const pull = async () => {
    pulledSeen = JSON.parse(fs.readFileSync(path.join(dest, '.photoapp', 'pulled.json'), 'utf8'));
    put(staging, tagJ, sidecar(hj, { caption: 'jpeg' }));
    return {
      phone: 'Test Phone',
      errors: [],
      files: [
        { rel: tagJ, size: 9, modified: '', sig: 'new', kind: 'sidecar', already: false, staged: true },
        { rel: tagD, size: 9, modified: '', sig: 'old', kind: 'sidecar', already: true, staged: false },
      ],
    };
  };
  const logs = [];
  const r = await runBackup({ to: dest, tagsOnly: true, pull, push: async () => ({ pushed: true, errors: [] }), log: (m) => logs.push(m) });

  assert.deepStrictEqual(r.errors, []);
  assert.ok(!(tagJ in pulledSeen), "the JPEG's tag file is re-copied");
  assert.ok(tagD in pulledSeen, "the RAW's tag file isn't needed again");
  const dir = path.join(dest, '2026', '09');
  assert.ok(!fs.existsSync(path.join(dir, '20260910_195825.json')), 'old shared file renamed away');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, '20260910_195825.dng.json'), 'utf8')).caption, 'raw');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, '20260910_195825.jpg.json'), 'utf8')).caption, 'jpeg');
  assert.strictEqual(r.tagged, 2);
  assert.ok(logs.some((m) => /Renamed 1 tag file\(s\).*1 will be copied from the phone again/.test(m)));
});

test('a phone tag file with leftover bytes after the record is read correctly', async () => {
  const s1 = tmp('s1');
  const s2 = tmp('s2');
  const dest = tmp('dest');
  const bytes = Buffer.from('photo-overwritten-tag');
  const h = md5(bytes);
  put(s1, 'DCIM/Camera/20260720_120000.jpg', bytes);
  const longer = sidecar(h, { caption: 'A long caption that was later cleared on the phone' });
  put(s1, `DCIM/PhotoTags/${h}.json`, longer);
  await runBackup({ to: dest, from: s1, log: quiet });
  const metaFile = path.join(dest, '2026', '07', '20260720_120000.jpg.json');
  assert.ok(fs.existsSync(metaFile));

  // The app cleared the tags; Android wrote the shorter cleared record over
  // the start of the old file without truncating it.
  const cleared = JSON.stringify({ version: 2, hashAlgorithm: 'md5', contentHash: h, cleared: true, updatedAt: '2026-10-15T14:01:23.670Z' });
  put(s2, `DCIM/PhotoTags/${h}.json`, cleared + longer.slice(cleared.length));
  const r = await runBackup({ to: dest, from: s2, log: quiet });

  assert.strictEqual(r.ignoredJson, 0);
  assert.strictEqual(r.tagsRemoved, 1);
  assert.ok(!fs.existsSync(metaFile));
});

test('a moved tag folder is remembered at the next backup, for Sync tags', async () => {
  const dest = tmp('dest');
  const staging = path.join(dest, '.photoapp', 'staging');
  const photo = Buffer.from('photo-whose-tags-moved');
  const h = md5(photo);
  put(dest, '2026/07/a.jpg', photo);
  put(dest, '.photoapp/index.json', JSON.stringify({
    version: 1,
    photos: { [h]: { path: '2026/07/a.jpg', size: photo.length, from: 'DCIM/Camera/a.jpg', tagged: true } },
  }));
  // Sync tags last read the old folder; the app has moved the files.
  put(dest, '.photoapp/receipt-state.json', JSON.stringify({ photoCount: 1, sidecarFolder: 'DCIM/photoAppMetadada' }));
  const tag = `DCIM/PicJot Tags/${h}.json`;
  const pull = async () => {
    put(staging, tag, sidecar(h, { caption: 'moved' }));
    return {
      phone: 'Test Phone',
      errors: [],
      files: [
        { rel: 'DCIM/Camera/a.jpg', size: photo.length, modified: '', sig: 's', kind: 'image', already: true, staged: false },
        { rel: tag, size: 9, modified: '', sig: 'new', kind: 'sidecar', already: false, staged: true },
      ],
    };
  };
  const r = await runBackup({ to: dest, pull, push: async () => ({ pushed: true, errors: [] }), log: quiet });
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.receiptFile, null, 'nothing new: no receipt');
  const state = JSON.parse(fs.readFileSync(path.join(dest, '.photoapp', 'receipt-state.json'), 'utf8'));
  assert.strictEqual(state.sidecarFolder, 'DCIM/PicJot Tags');
  assert.strictEqual(state.photoCount, 1, 'the rest of the state is kept');
});
