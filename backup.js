#!/usr/bin/env node
'use strict';
/*
  PhotoApp PC backup (v1).

    node pc/backup.js --to "E:\Photos"              # pull from the USB-connected phone
    node pc/backup.js --to "E:\Photos" --dry-run    # list what would be backed up
    node pc/backup.js --to "E:\Photos" --from <dir> # organise an already-copied folder

  - Backs up ALL photos (not videos) from the phone's DCIM, Pictures and
    Download folders; PhotoApp's JSON sidecars ride along for tagged photos.
  - Layout: <to>/YYYY/MM/<photo> with <photo>.json beside tagged ones.
  - Photos are identified by MD5 content hash: re-runs skip what's already
    backed up (even if renamed), name clashes get a short hash suffix, and
    every placed file is re-hashed before it counts.
  - Never deletes or changes anything on the phone; only adds a receipt file
    to the phone's sidecar folder listing what is now safely on the PC.
  - Bookkeeping lives in <to>/.photoapp/ (index, pull log, receipts).
*/
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { readExifDate } = require('./lib/exif');
const { md5File, readHead, walk, readJson, writeJson, placeVerified } = require('./lib/files');
const {
  isImage,
  isSidecarName,
  resolveMonth,
  destinationFor,
  sidecarPathFor,
  mostCommonDir,
} = require('./lib/plan');

const toPosix = (p) => p.split(path.sep).join('/');
const fromPosix = (p) => p.split('/').join(path.sep);

// ── Phone access (Windows MTP via pc/mtp.ps1) ─────────────────────────────
function runMtp(args) {
  return new Promise((resolve, reject) => {
    const ps = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'mtp.ps1'), ...args],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    );
    let err = '';
    ps.stderr.on('data', (d) => (err += d));
    ps.on('error', reject);
    // Keep only the message line: PowerShell appends a stack trace
    // ("At ...\mtp.ps1:53 char:30 ...") that means nothing to users.
    const firstLine = () => err.trim().split(/\r?\n/)[0];
    ps.on('close', (code) => (code === 0 ? resolve() : reject(new Error(firstLine() || `mtp.ps1 exited ${code}`))));
  });
}

async function pullFromPhone({ staging, pulledFile, resultFile, listOnly }) {
  fs.mkdirSync(staging, { recursive: true });
  const args = ['-Staging', staging, '-Pulled', pulledFile, '-Result', resultFile];
  if (listOnly) args.push('-ListOnly');
  await runMtp(args);
  return readMtpResult(resultFile);
}

// Copy a file (the receipt) into `folder` on the phone: the folder holding
// PhotoApp's tag files, wherever the user put it.
async function pushToPhone({ file, folder, staging, pulledFile, resultFile }) {
  await runMtp([
    '-Staging', staging, '-Pulled', pulledFile, '-Result', resultFile,
    '-PushFile', file, '-PushFolder', folder,
  ]);
  return readMtpResult(resultFile);
}

function readMtpResult(file) {
  // PowerShell may emit a BOM; strip it before parsing.
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const r = JSON.parse(raw);
  const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
  return { ...r, files: asArray(r.files), errors: asArray(r.errors) };
}

// ── Local source (--from): treat a copied folder like a phone listing ──────
function listLocal(dir) {
  return walk(dir)
    .filter((rel) => isImage(rel) || isSidecarName(path.basename(rel)))
    .map((rel) => {
      const st = fs.statSync(path.join(dir, fromPosix(rel)));
      const modified = st.mtime.toISOString();
      return {
        rel,
        size: st.size,
        modified,
        sig: `${st.size}|${modified}`,
        kind: isImage(rel) ? 'image' : 'sidecar',
        already: false,
        staged: true,
      };
    });
}

// ── The backup ────────────────────────────────────────────────────────────
async function runBackup({
  to,
  from = null,
  dryRun = false,
  log = console.log,
  pull = pullFromPhone,
  push = pushToPhone,
  now = () => new Date(),
}) {
  const meta = path.join(to, '.photoapp');
  const staging = path.join(meta, 'staging');
  const indexFile = path.join(meta, 'index.json');
  const pulledFile = path.join(meta, 'pulled.json');
  const resultFile = path.join(meta, 'mtp-result.json');
  const orphanDir = path.join(meta, 'orphan-sidecars');
  fs.mkdirSync(meta, { recursive: true });

  const index = readJson(indexFile, { version: 1, photos: {} }); // hash -> entry
  const pulled = readJson(pulledFile, {}); // phone rel -> "size|modified"
  const stateFile = path.join(meta, 'receipt-state.json');
  const state = readJson(stateFile, { photoCount: -1, sidecarFolder: null });

  // 0) Re-check the PC side first. An index entry whose file is missing or has
  //    changed size is dropped, and its phone photo (and tag file) un-marked
  //    as pulled, so it is re-copied this run and never claimed in a receipt
  //    as "safely on the PC" (Free up space trusts receipts).
  const missingOnPc = [];
  for (const [hash, e] of Object.entries(index.photos)) {
    let ok = false;
    try {
      ok = fs.statSync(path.join(to, fromPosix(e.path))).size === e.size;
    } catch {
      ok = false;
    }
    if (ok) continue;
    missingOnPc.push(e.path);
    delete index.photos[hash];
    if (e.from) delete pulled[e.from];
    for (const k of Object.keys(pulled)) if (k.endsWith(`/${hash}.json`)) delete pulled[k];
  }
  if (missingOnPc.length) {
    log(`${missingOnPc.length} photo(s) are missing or changed on the PC; they will be copied again.`);
    if (!dryRun) {
      writeJson(indexFile, index);
      if (!from) writeJson(pulledFile, pulled); // the phone pull reads this
    }
  }
  const pathOwner = new Map(Object.entries(index.photos).map(([h, e]) => [e.path, h]));

  let sourceDir;
  let listing;
  let phoneName = null;
  const errors = [];

  if (from) {
    sourceDir = from;
    listing = listLocal(from);
    log(`Source: ${from} (${listing.length} photos/sidecars)`);
  } else {
    // Plain ASCII: the Windows console mangles typographic characters.
    log('Reading the phone over USB... (the first run copies everything and can take a while)');
    const r = await pull({ staging, pulledFile, resultFile, listOnly: dryRun });
    phoneName = r.phone;
    listing = r.files;
    errors.push(...r.errors);
    sourceDir = staging;
    log(`Phone: ${phoneName} (${listing.length} photos/sidecars found)`);
  }

  const images = listing.filter((f) => f.kind === 'image');
  const toProcess = listing.filter((f) => !f.already);

  if (dryRun) {
    const newImages = toProcess.filter((f) => f.kind === 'image');
    const bytes = newImages.reduce((s, f) => s + Number(f.size || 0), 0);
    log(`Dry run: ${newImages.length} new/changed photos (${(bytes / 1e9).toFixed(2)} GB), ` +
      `${images.length - newImages.length} already backed up` +
      `${missingOnPc.length ? `, plus ${missingOnPc.length} missing on the PC that a real run copies again` : ''}` +
      '. Nothing copied.');
    return { dryRun: true, newPhotos: newImages.length, missingOnPc: missingOnPc.length, errors };
  }

  const stats = {
    copied: 0,
    present: 0,
    tagged: 0,
    sidecarsWritten: 0,
    orphans: 0,
    redacted: 0,
    ignoredJson: 0,
    failed: 0,
  };
  const processed = new Set(); // listing rels handled successfully
  const pending = (f) => fs.existsSync(path.join(sourceDir, fromPosix(f.rel)));

  // 1) Sidecars: hash -> record (staged copies are cleaned up at the end).
  //    Any <md5>.json is a candidate; ones that aren't PhotoApp tag files are
  //    ignored. Tag files hashed while Android was blanking GPS bytes
  //    (hashSource "redacted") can never match the real photo: they're counted
  //    and reported instead of waiting forever; the app re-hashes and replaces
  //    them once it has photo-location access.
  const sidecars = new Map();
  for (const f of toProcess.filter((x) => x.kind === 'sidecar' && pending(x))) {
    const rec = readJson(path.join(sourceDir, fromPosix(f.rel)), null);
    processed.add(f.rel);
    if (!rec || rec.hashAlgorithm !== 'md5' || !/^[0-9a-f]{32}$/.test(rec.contentHash || '')) {
      stats.ignoredJson += 1;
    } else if (rec.hashSource === 'redacted') {
      stats.redacted += 1;
    } else {
      sidecars.set(rec.contentHash, { record: rec, rel: f.rel });
    }
  }
  // The folder the user keeps PhotoApp's tag files in (receipts go there too).
  const sidecarFolder =
    mostCommonDir([...sidecars.values()].map((s) => s.rel)) ||
    state.sidecarFolder ||
    mostCommonDir(listing.filter((f) => f.kind === 'sidecar').map((f) => f.rel));

  // 2) Photos.
  for (const f of toProcess.filter((x) => x.kind === 'image')) {
    const src = path.join(sourceDir, fromPosix(f.rel));
    if (!fs.existsSync(src)) continue; // not staged (copy failed) — retried next run
    try {
      const hash = await md5File(src);
      const size = fs.statSync(src).size;
      const existing = index.photos[hash];
      if (existing && fs.existsSync(path.join(to, fromPosix(existing.path)))) {
        stats.present += 1;
        if (!from) fs.unlinkSync(src); // staged duplicate no longer needed
      } else {
        const sc = sidecars.get(hash);
        const head = /\.jpe?g$/i.test(src) ? readHead(src) : null;
        const month = resolveMonth({
          sidecarCreationTime: sc && sc.record.creationTime,
          exifDate: head ? readExifDate(head) : null,
          fileName: path.basename(src),
          phoneModified: f.modified,
        });
        const destRel = toPosix(
          destinationFor(month, path.basename(src), hash, (rel) => {
            const owner = pathOwner.get(toPosix(rel));
            return (owner && owner !== hash) || (!owner && fs.existsSync(path.join(to, rel)));
          })
        );
        const ok = await placeVerified(src, path.join(to, fromPosix(destRel)), hash, { move: !from });
        if (!ok) throw new Error('verification failed after copy');
        index.photos[hash] = {
          path: destRel,
          size,
          dateSource: month.source,
          from: f.rel,
          addedAt: now().toISOString(),
        };
        pathOwner.set(destRel, hash);
        stats.copied += 1;
      }
      processed.add(f.rel);
    } catch (e) {
      stats.failed += 1;
      errors.push(`photo ${f.rel}: ${e.message}`);
    }
  }

  // 3) Place sidecars beside their photos; unmatched ones wait in orphan-sidecars/
  //    (their photo may be in a folder not yet backed up) and are retried each run.
  //    A waiting copy is deleted once a newer one for the same photo arrives from
  //    the phone (otherwise it could later overwrite the newer caption), or if
  //    it can never match (redacted hash).
  for (const file of fs.existsSync(orphanDir) ? fs.readdirSync(orphanDir) : []) {
    const orphanPath = path.join(orphanDir, file);
    const rec = readJson(orphanPath, null);
    if (!rec || !rec.contentHash) continue;
    if (sidecars.has(rec.contentHash) || rec.hashSource === 'redacted') {
      fs.unlinkSync(orphanPath);
      continue;
    }
    sidecars.set(rec.contentHash, { record: rec, rel: null, orphanFile: file });
  }
  for (const [hash, sc] of sidecars) {
    const photo = index.photos[hash];
    try {
      if (photo) {
        const target = path.join(to, fromPosix(sidecarPathFor(photo.path)));
        const body = JSON.stringify({ ...sc.record, photoFile: path.basename(photo.path) }, null, 2);
        const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
        if (current !== body) {
          fs.writeFileSync(target, body);
          stats.sidecarsWritten += 1;
        }
        photo.tagged = true;
        if (sc.orphanFile) fs.unlinkSync(path.join(orphanDir, sc.orphanFile));
      } else if (!sc.orphanFile) {
        fs.mkdirSync(orphanDir, { recursive: true });
        fs.writeFileSync(path.join(orphanDir, `${hash}.json`), JSON.stringify(sc.record, null, 2));
        stats.orphans += 1;
      }
      if (sc.rel) processed.add(sc.rel);
    } catch (e) {
      errors.push(`sidecar ${hash}: ${e.message}`);
    }
  }
  stats.tagged = Object.values(index.photos).filter((p) => p.tagged).length;

  // 4) Bookkeeping: only successfully handled phone files are marked pulled,
  //    so anything that failed is retried next time.
  if (!from) {
    for (const f of listing) if (processed.has(f.rel)) pulled[f.rel] = f.sig;
    writeJson(pulledFile, pulled);
  }
  writeJson(indexFile, index);

  // 5) Receipt: the complete inventory of what is safely on the PC (every
  //    verified photo: hash, phone path, size). The phone app uses the newest
  //    receipt to offer "Free up space" and re-hashes each photo before
  //    deleting it. A new receipt is written only when the inventory changed.
  let receiptFile = null;
  let receiptPushed = false;
  let receiptNote = null;
  const inventory = Object.entries(index.photos)
    .map(([hash, e]) => ({ hash, from: e.from, size: e.size }))
    .sort((a, b) => a.hash.localeCompare(b.hash));
  if (inventory.length && (inventory.length !== state.photoCount || stats.copied > 0)) {
    const stamp = now().toISOString().replace(/[:.]/g, '-');
    receiptFile = path.join(meta, 'receipts', `backup-receipt-${stamp}.json`);
    writeJson(receiptFile, {
      type: 'photoapp-backup-receipt',
      version: 2,
      createdAt: now().toISOString(),
      destination: to,
      phone: phoneName,
      hashAlgorithm: 'md5',
      photos: inventory,
    });
    if (from) {
      writeJson(stateFile, { ...state, photoCount: inventory.length });
    } else if (!sidecarFolder) {
      // No tag files on the phone yet, so there's no PhotoApp folder to put the
      // receipt in. Not an error; retried next run.
      receiptNote =
        'No PhotoApp tag folder found on the phone yet, so the receipt was not copied to it ' +
        '(Free up space needs it). In the app, choose a backup folder under Settings > Tag backup ' +
        'and tag a photo, then run the backup again.';
    } else {
      try {
        const r = await push({ file: receiptFile, folder: sidecarFolder, staging, pulledFile, resultFile });
        receiptPushed = Boolean(r.pushed);
        errors.push(...r.errors);
        // Only remember the inventory as delivered once it reached the phone,
        // so a failed push is retried next run.
        if (receiptPushed) {
          writeJson(stateFile, { photoCount: inventory.length, sidecarFolder });
        }
      } catch (e) {
        errors.push(`receipt not pushed to phone: ${e.message}`);
      }
    }
  }

  // 6) Clean staging: remove handled sidecar copies and empty folders.
  if (!from) {
    for (const f of listing) {
      if (f.kind === 'sidecar' && processed.has(f.rel)) {
        const p = path.join(staging, fromPosix(f.rel));
        if (fs.existsSync(p)) fs.unlinkSync(p);
      }
    }
    pruneEmptyDirs(staging);
  }

  log(
    `Done: ${stats.copied} new photo(s) backed up, ${stats.present} already present` +
      `${images.length - toProcess.filter((x) => x.kind === 'image').length ? `, ${images.length - toProcess.filter((x) => x.kind === 'image').length} unchanged since last backup` : ''}` +
      `. ${stats.tagged} tagged photo(s) on the PC; ${stats.sidecarsWritten} metadata file(s) written` +
      `${stats.orphans ? `, ${stats.orphans} waiting for their photo` : ''}.`
  );
  if (stats.redacted) {
    log(
      `${stats.redacted} tag file(s) on the phone were saved before PhotoApp had photo-location ` +
        'access, so they cannot be matched to their photos yet. Open PhotoApp on the phone ' +
        '(it refreshes them automatically), then run the backup again.'
    );
  }
  if (receiptFile) {
    log(
      `Receipt: ${receiptFile}` +
        (from ? '' : receiptPushed ? ` (copied to the phone's ${sidecarFolder})` : ' (NOT copied to the phone)')
    );
  }
  if (receiptNote) log(receiptNote);
  if (errors.length) {
    log(`${errors.length} problem(s):`);
    for (const e of errors) log(`  - ${e}`);
  }
  return {
    ...stats,
    errors,
    receiptFile,
    receiptPushed,
    sidecarFolder,
    missingOnPc: missingOnPc.length,
  };
}

function pruneEmptyDirs(dir) {
  if (!fs.existsSync(dir)) return;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) pruneEmptyDirs(path.join(dir, ent.name));
  }
  if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
}

// ── CLI ───────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--to') out.to = argv[++i];
    else if (a === '--from') out.from = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return out;
}

if (require.main === module) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  if (args.help || !args.to) {
    console.log('Usage: node pc/backup.js --to <folder> [--dry-run] [--from <copied folder>]');
    process.exit(args.help ? 0 : 2);
  }
  runBackup({ to: path.resolve(args.to), from: args.from && path.resolve(args.from), dryRun: args.dryRun })
    .then((r) => process.exit(r.errors && r.errors.length ? 1 : 0))
    .catch((e) => {
      console.error(`Backup failed: ${e.message}`);
      process.exit(1);
    });
}

module.exports = { runBackup, parseArgs, listLocal };
