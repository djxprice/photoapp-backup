#!/usr/bin/env node
'use strict';
/*
  PicJot PC backup (v1). (The app was called PhotoApp; internal names keep it.)

    node pc/backup.js --to "E:\Photos"              # pull from the USB-connected phone
    node pc/backup.js --to "E:\Photos" --dry-run    # list what would be backed up
    node pc/backup.js --to "E:\Photos" --from <dir> # organise an already-copied folder
    node pc/backup.js --to "E:\Photos" --tags-only  # sync PhotoApp's tags only (fast)

  - Backs up ALL photos (not videos) from the phone's DCIM, Pictures and
    Download folders; PhotoApp's JSON sidecars ride along for tagged photos.
  - Layout: <to>/YYYY/MM/<photo>, and for tagged ones a tag file in
    <to>/PicJot Tags/YYYY/MM/<photo>.json (e.g. IMG_1.jpg.json, so a RAW+JPEG
    pair keeps both; beside the photo until 2026-10-22, moved once).
  - Photos are identified by MD5 content hash: re-runs skip what's already
    backed up (even if renamed), name clashes get a short hash suffix, and
    every placed file is re-hashed before it counts.
  - Never deletes or changes anything on the phone; only adds a receipt file
    to the phone's sidecar folder listing what is now safely on the PC, and a
    small "tags synced" marker the app uses to show unsynced tag changes.
  - Moments (timeline entries without a photo, Step 26) come as tag files
    too ("kind": "moment") and are filed under their date:
    PicJot Tags/YYYY/MM/Moment - <title> (<id>).json (index.moments says
    where each is, so a changed date or title moves it).
  - Tags flow phone -> PC: an edited tag file replaces the PC copy; a
    "cleared" tag file (written by the app when all of a photo's tags are
    removed) deletes the PC copy. A tag file that is simply missing never
    deletes anything (the photo may have been deleted from the phone).
  - --tags-only reads just the phone's tag folder (seconds): no photos are
    copied and no receipt is written.
  - Bookkeeping lives in <to>/.photoapp/ (index, pull log, receipts).
*/
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { readExifDate } = require('./lib/exif');
const { takeoutJsonFor, readTakeout } = require('./lib/takeout');
const { isMomentRecord, momentPathFor } = require('./lib/timeline');
const { md5File, readHead, walk, readJson, writeJson, placeVerified, freeBytes: driveFree, sizeText } = require('./lib/files');

// Room always left on the backup drive when copying a folder in.
const SPACE_MARGIN = 200 * 1024 * 1024;
const {
  isImage,
  isSidecarName,
  resolveMonth,
  destinationFor,
  TAG_FOLDER,
  sidecarPathFor,
  besideSidecarPathFor,
  legacySidecarPathFor,
  parseLeadingJson,
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

async function pullFromPhone({ staging, pulledFile, resultFile, listOnly, only }) {
  fs.mkdirSync(staging, { recursive: true });
  const args = ['-Staging', staging, '-Pulled', pulledFile, '-Result', resultFile];
  if (listOnly) args.push('-ListOnly');
  if (only) args.push('-Only', only);
  await runMtp(args);
  return readMtpResult(resultFile);
}

// Copy a file (a receipt or tags-synced marker) into `folder` on the phone: the
// folder holding PhotoApp's tag files, wherever the user put it.
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

// Google Takeout .json files (not PicJot's "<md5>.json"), by folder:
// Map "<folder>" -> Set of names. `rels` from walk().
function jsonsByFolder(rels) {
  const out = new Map();
  for (const rel of rels) {
    const name = path.posix.basename(rel);
    if (!/\.json$/i.test(name) || isSidecarName(name)) continue;
    const dir = path.posix.dirname(rel);
    if (!out.has(dir)) out.set(dir, new Set());
    out.get(dir).add(name);
  }
  return out;
}

// What Google Takeout's .json says about the photo at `rel` in folder `dir`
// ({ takenTime, description }), or null.
function takeoutFor(dir, rel, jsons) {
  const folderRel = path.posix.dirname(rel);
  const name = takeoutJsonFor(path.posix.basename(rel), jsons.get(folderRel) || new Set());
  if (!name) return null;
  try {
    return readTakeout(fs.readFileSync(path.join(dir, fromPosix(folderRel), name), 'utf8'));
  } catch {
    return null;
  }
}

// ── The backup ────────────────────────────────────────────────────────────
async function runBackup({
  to,
  from = null,
  dryRun = false,
  tagsOnly = false,
  log = console.log,
  pull = pullFromPhone,
  push = pushToPhone,
  now = () => new Date(),
  over = 'USB', // how the phone is reached, for the log ('Wi-Fi' from pc/receiver.js)
  onProgress = () => {}, // ({ done, total }) while photos are handled
  freeBytes = driveFree, // free space on the backup drive (tests pass their own)
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
  // Tag edits made on the phone after this moment may not be in this run, so
  // the tags-synced marker carries the start time.
  const startedAt = now();

  // Tags only needs to know where the phone keeps PhotoApp's tag files, which
  // a full backup records.
  if (tagsOnly && !from && !state.sidecarFolder) {
    const msg =
      "Don't know where PicJot keeps its tag files on the phone yet. Run a full backup " +
      'once (it finds the folder), then Sync tags works.';
    log(msg);
    return { errors: [msg], tagsOnly: true };
  }

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
    log(
      `${missingOnPc.length} photo(s) are missing or changed on the PC; ` +
        (tagsOnly ? 'run a full backup to copy them again.' : 'they will be copied again.')
    );
    if (!dryRun) {
      writeJson(indexFile, index);
      if (!from) writeJson(pulledFile, pulled); // the phone pull reads this
    }
  }
  // 0b) Tag files are in "PicJot Tags/", mirroring the month folders, since
  //     2026-10-22 (the user's call); before, they were beside each photo:
  //     <photo file>.json since 2026-10-15, and <photo name>.json before (where
  //     a RAW+JPEG pair shared IMG_1.json and one overwrote the other). Old
  //     files that belong to their photo are moved in (or deleted, when the
  //     tag folder already has a newer one): every photo the first time
  //     (`index.tagFolder` records it), then tagged ones. A tagged photo whose
  //     tag file is missing has it copied from the phone again (un-marked as
  //     pulled).
  let movedTags = 0;
  let refetchTags = 0;
  if (!dryRun) {
    const firstTime = index.tagFolder !== TAG_FOLDER;
    for (const [hash, e] of Object.entries(index.photos)) {
      if (!e.tagged && !firstTime) continue;
      const target = path.join(to, fromPosix(sidecarPathFor(e.path)));
      let inPlace = fs.existsSync(target);
      for (const old of [besideSidecarPathFor(e.path), legacySidecarPathFor(e.path)]) {
        const file = path.join(to, fromPosix(old));
        if (!fs.existsSync(file) || (readJson(file, null) || {}).contentHash !== hash) continue;
        if (inPlace) {
          fs.unlinkSync(file); // older than the one in the tag folder
          continue;
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.renameSync(file, target);
        inPlace = true;
        e.tagged = true;
        movedTags += 1;
      }
      if (inPlace || !e.tagged) continue;
      delete e.tagged;
      for (const k of Object.keys(pulled)) if (k.endsWith(`/${hash}.json`)) delete pulled[k];
      refetchTags += 1;
    }
    if (firstTime) index.tagFolder = TAG_FOLDER;
    if (movedTags || refetchTags || firstTime) {
      writeJson(indexFile, index);
      if (!from) writeJson(pulledFile, pulled);
    }
    if (movedTags || refetchTags) {
      log(
        `Moved ${movedTags} tag file(s) into "${TAG_FOLDER}"` +
          (refetchTags ? `; ${refetchTags} will be copied from the phone again.` : '.')
      );
    }
  }
  const pathOwner = new Map(Object.entries(index.photos).map(([h, e]) => [e.path, h]));

  let sourceDir;
  let listing;
  let phoneName = null;
  const errors = [];

  // A folder of old photos (Step 26b): Google Takeout's .json files, by folder.
  let takeoutJsons = null;
  if (from) {
    sourceDir = from;
    listing = listLocal(from);
    takeoutJsons = jsonsByFolder(walk(from));
    log(`Source: ${from} (${listing.length} photos/sidecars)`);
  } else {
    // Plain ASCII: the Windows console mangles typographic characters.
    log(
      tagsOnly
        ? `Reading PicJot's tag folder (${state.sidecarFolder}) on the phone over ${over}...`
        : over === 'USB'
          ? 'Reading the phone over USB... (the first run copies everything and can take a while)'
          : `Filing what the phone sent over ${over}...`
    );
    const r = await pull({
      staging,
      pulledFile,
      resultFile,
      listOnly: dryRun,
      only: tagsOnly ? state.sidecarFolder : null,
    });
    phoneName = r.phone;
    listing = r.files;
    errors.push(...r.errors);
    sourceDir = staging;
    log(
      tagsOnly
        ? `Phone: ${phoneName} (${listing.length} tag files in ${state.sidecarFolder})`
        : `Phone: ${phoneName} (${listing.length} photos/sidecars found)`
    );
  }

  if (tagsOnly) listing = listing.filter((f) => f.kind === 'sidecar');
  const images = listing.filter((f) => f.kind === 'image');
  const toProcess = listing.filter((f) => !f.already);

  if (dryRun && tagsOnly) {
    const changed = toProcess.length;
    log(`Dry run: ${changed} new/changed tag file(s) on the phone. Nothing changed.`);
    return { dryRun: true, tagsOnly: true, changedTags: changed, errors };
  }

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
    tagsRemoved: 0,
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
  const moments = new Map(); // id -> { record, rel }: Moments (Step 26)
  for (const f of toProcess.filter((x) => x.kind === 'sidecar' && pending(x))) {
    // Tolerates leftover bytes after the record (see parseLeadingJson).
    let parsed = null;
    try {
      parsed = parseLeadingJson(fs.readFileSync(path.join(sourceDir, fromPosix(f.rel)), 'utf8'));
    } catch {
      parsed = null;
    }
    const rec = parsed && parsed.value;
    processed.add(f.rel);
    if (isMomentRecord(rec)) {
      moments.set(rec.id, { record: rec, rel: f.rel });
    } else if (!rec || rec.hashAlgorithm !== 'md5' || !/^[0-9a-f]{32}$/.test(rec.contentHash || '')) {
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
  // Remember it as soon as the phone's tag files are seen there, not only
  // when a receipt is delivered: Sync tags reads only that folder, and the
  // app can move its tag files to a new folder (e.g. PicJot Tags, 2026-10-20).
  if (!from && !dryRun && !tagsOnly && sidecars.size && sidecarFolder !== state.sidecarFolder) {
    state.sidecarFolder = sidecarFolder;
    writeJson(stateFile, state);
  }

  // 2) Photos (none in tags-only mode: the listing has tag files only).
  //    Progress goes to onProgress({ done, total }). Copying a folder in
  //    (`from`) stops when the backup drive would fall below SPACE_MARGIN:
  //    what's left is reported (adding the folder again carries on).
  const photosToDo = toProcess.filter((x) => x.kind === 'image');
  let photosDone = 0;
  let noRoom = null;
  // The index is saved as photos are placed (every 25, or 20 seconds), not
  // only at the end: a long run cut short (the PC turned off) keeps what it
  // placed. And a photo already in place from such a run is taken over
  // rather than copied again under another name.
  let unsaved = 0;
  let savedAt = Date.now();
  const saveAsWeGo = () => {
    if (++unsaved < 25 && Date.now() - savedAt < 20000) return;
    writeJson(indexFile, index);
    unsaved = 0;
    savedAt = Date.now();
  };
  let recovered = 0;
  for (const f of photosToDo) {
    onProgress({ done: photosDone++, total: photosToDo.length });
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
        if (from && freeBytes(to) < size + SPACE_MARGIN) {
          noRoom = { left: photosToDo.length - photosDone + 1, free: freeBytes(to) };
          break;
        }
        const sc = sidecars.get(hash);
        const takeout = takeoutJsons ? takeoutFor(from, f.rel, takeoutJsons) : null;
        const month = resolveMonth({
          sidecarCreationTime: sc && sc.record.creationTime,
          exifDate: readExifDate(readHead(src)), // JPEG, and RAW / HEIC from imports
          takeoutTime: takeout && takeout.takenTime,
          fileName: path.basename(src),
          phoneModified: f.modified,
        });
        // Already in place from a run cut short (not in the index, same bytes)?
        let destRel = null;
        for (const rel of [destinationFor(month, path.basename(src), hash), destinationFor(month, path.basename(src), hash, () => true)]) {
          const file = path.join(to, fromPosix(rel));
          if (!pathOwner.get(rel) && fs.existsSync(file) && fs.statSync(file).size === size && (await md5File(file)) === hash) {
            destRel = rel;
            break;
          }
        }
        if (destRel) {
          recovered += 1;
          if (!from) fs.unlinkSync(src); // staged copy no longer needed
        } else {
          destRel = toPosix(
            destinationFor(month, path.basename(src), hash, (rel) => {
              const owner = pathOwner.get(toPosix(rel));
              return (owner && owner !== hash) || (!owner && fs.existsSync(path.join(to, rel)));
            })
          );
          const ok = await placeVerified(src, path.join(to, fromPosix(destRel)), hash, { move: !from });
          if (!ok) throw new Error('verification failed after copy');
        }
        index.photos[hash] = {
          path: destRel,
          size,
          dateSource: month.source,
          from: f.rel,
          addedAt: now().toISOString(),
          // The user's Google Photos description, offered as the caption
          // when the photo is reviewed as an old photo, and Google's time
          // taken (UTC), its date when it has no EXIF one.
          ...(takeout && takeout.description ? { description: takeout.description.slice(0, 2000) } : {}),
          ...(takeout && takeout.takenTime ? { takeoutTime: takeout.takenTime } : {}),
        };
        pathOwner.set(destRel, hash);
        stats.copied += 1;
        saveAsWeGo();
      }
      processed.add(f.rel);
    } catch (e) {
      stats.failed += 1;
      errors.push(`photo ${f.rel}: ${e.message}`);
    }
  }

  onProgress({ done: photosToDo.length, total: photosToDo.length });
  if (recovered) log(`${recovered} photo(s) placed by an earlier run that was cut short were found in place and kept.`);
  if (noRoom) {
    stats.notCopied = noRoom.left;
    errors.push(
      `The backup drive is nearly full (${sizeText(noRoom.free)} free), so ${noRoom.left} photo(s) weren't added. ` +
        'Make room on it, then add the folder again: the photos already added are skipped.'
    );
  }

  // 3) Place sidecars in the tag folder; unmatched ones wait in orphan-sidecars/
  //    (their photo may be in a folder not yet backed up) and are retried each run.
  //    A waiting copy is deleted once a newer one for the same photo arrives from
  //    the phone (otherwise it could later overwrite the newer caption), or if
  //    it can never match (redacted hash). A "cleared" tag file deletes the PC
  //    copy of that photo's tags; it never waits for a photo.
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
      if (sc.record.cleared === true) {
        if (photo) {
          const target = path.join(to, fromPosix(sidecarPathFor(photo.path)));
          const ours = [besideSidecarPathFor(photo.path), legacySidecarPathFor(photo.path)]
            .map((rel) => path.join(to, fromPosix(rel)))
            .filter((file) => fs.existsSync(file) && (readJson(file, null) || {}).contentHash === hash);
          if (fs.existsSync(target) || ours.length) stats.tagsRemoved += 1;
          if (fs.existsSync(target)) fs.unlinkSync(target);
          for (const file of ours) fs.unlinkSync(file);
          delete photo.tagged;
        }
        if (sc.orphanFile) fs.unlinkSync(path.join(orphanDir, sc.orphanFile));
      } else if (photo) {
        const target = path.join(to, fromPosix(sidecarPathFor(photo.path)));
        const body = JSON.stringify({ ...sc.record, photoFile: path.basename(photo.path) }, null, 2);
        const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
        if (current !== body) {
          fs.mkdirSync(path.dirname(target), { recursive: true });
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
  // 3b) Moments (Step 26): each under its date in the tag folder; a cleared
  //     one (deleted on the phone) is removed. index.moments: id -> where its
  //     file is, so a new date or title moves it rather than leaving a copy.
  index.moments = index.moments || {};
  for (const [id, m] of moments) {
    try {
      const old = index.moments[id];
      const oldFile = old ? path.join(to, fromPosix(old)) : null;
      if (m.record.cleared === true) {
        if (oldFile && fs.existsSync(oldFile)) {
          fs.unlinkSync(oldFile);
          stats.tagsRemoved += 1;
        }
        delete index.moments[id];
        continue;
      }
      const rel = momentPathFor(m.record);
      const target = path.join(to, fromPosix(rel));
      const body = JSON.stringify(m.record, null, 2);
      const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
      if (current !== body) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, body);
        stats.sidecarsWritten += 1;
      }
      if (old && old !== rel && oldFile && fs.existsSync(oldFile)) fs.unlinkSync(oldFile);
      index.moments[id] = rel;
    } catch (e) {
      errors.push(`moment ${id}: ${e.message}`);
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
  if (
    !tagsOnly &&
    inventory.length &&
    (inventory.length !== state.photoCount || stats.copied > 0)
  ) {
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
        'No PicJot tag folder found on the phone yet, so the receipt was not copied to it ' +
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

  // 5b) Tags-synced marker: tells the app every tag change made before
  //     `startedAt` is now on the PC (Settings shows changes since then). Only
  //     sent when every tag file on the phone was read this run.
  let tagsMarkerPushed = false;
  const tagFolder = sidecarFolder || state.sidecarFolder;
  const unreadTags = listing.filter(
    (f) => f.kind === 'sidecar' && !f.already && !processed.has(f.rel)
  ).length;
  if (!from && tagFolder && !unreadTags) {
    const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
    const markerFile = path.join(meta, 'tag-sync', `tags-synced-${stamp}.json`);
    writeJson(markerFile, {
      type: 'photoapp-tag-sync',
      version: 1,
      syncedAt: startedAt.toISOString(),
      destination: to,
      taggedOnPc: stats.tagged,
    });
    try {
      const r = await push({ file: markerFile, folder: tagFolder, staging, pulledFile, resultFile });
      tagsMarkerPushed = Boolean(r.pushed);
      errors.push(...r.errors);
      if (tagsMarkerPushed) fs.unlinkSync(markerFile);
    } catch (e) {
      errors.push(`tags-synced marker not copied to the phone: ${e.message}`);
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

  const tagSummary =
    `${stats.sidecarsWritten} tag file(s) updated` +
    `${stats.tagsRemoved ? `, ${stats.tagsRemoved} removed (tags cleared on the phone)` : ''}` +
    `${stats.orphans ? `, ${stats.orphans} waiting for their photo` : ''}`;
  if (tagsOnly) {
    log(`Tags synced: ${tagSummary}. ${stats.tagged} tagged photo(s) on the PC.`);
  } else log(
    `Done: ${stats.copied} new photo(s) backed up, ${stats.present} already present` +
      `${images.length - toProcess.filter((x) => x.kind === 'image').length ? `, ${images.length - toProcess.filter((x) => x.kind === 'image').length} unchanged since last backup` : ''}` +
      `. ${stats.tagged} tagged photo(s) on the PC; ${tagSummary}.`
  );
  if (stats.redacted) {
    log(
      `${stats.redacted} tag file(s) on the phone were saved before PicJot had photo-location ` +
        'access, so they cannot be matched to their photos yet. Open PicJot on the phone ' +
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
    tagsMarkerPushed,
    tagsOnly,
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
    else if (a === '--tags-only') out.tagsOnly = true;
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
    console.log('Usage: node pc/backup.js --to <folder> [--tags-only] [--dry-run] [--from <copied folder>]');
    process.exit(args.help ? 0 : 2);
  }
  runBackup({
    to: path.resolve(args.to),
    from: args.from && path.resolve(args.from),
    dryRun: args.dryRun,
    tagsOnly: Boolean(args.tagsOnly),
  })
    .then((r) => process.exit(r.errors && r.errors.length ? 1 : 0))
    .catch((e) => {
      console.error(`${args.tagsOnly ? 'Tag sync' : 'Backup'} failed: ${e.message}`);
      process.exit(1);
    });
}

// Before a folder of old photos is added: how many photos it has, about how
// many bytes they'd add (less those that look already backed up: the same
// name and size as one in the index), and the room on the backup drive.
function importEstimate(from, to, freeBytes = driveFree) {
  const index = readJson(path.join(to, '.photoapp', 'index.json'), { photos: {} });
  const known = new Set(Object.values(index.photos || {}).map((e) => `${path.posix.basename(e.path).toLowerCase()}|${e.size}`));
  let photos = 0;
  let bytes = 0;
  for (const f of listLocal(from)) {
    if (f.kind !== 'image') continue;
    photos += 1;
    if (!known.has(`${path.posix.basename(f.rel).toLowerCase()}|${f.size}`)) bytes += f.size;
  }
  return { photos, bytes, free: freeBytes(to), needed: bytes + SPACE_MARGIN };
}

module.exports = { runBackup, parseArgs, listLocal, importEstimate };
