'use strict';
// Filesystem helpers for the PC backup.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Standard MD5 (lowercase hex) of a file, streamed — same digest as the
// phone's native hash and Windows `CertUtil -hashfile … MD5`.
function md5File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('md5');
    fs.createReadStream(file)
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

// First chunk of a file (enough for the JPEG EXIF segment).
function readHead(file, bytes = 256 * 1024) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

// Recursively list files under a directory (relative paths, "/" separators).
function walk(root) {
  const out = [];
  const visit = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) visit(full);
      else if (ent.isFile()) out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  if (fs.existsSync(root)) visit(root);
  return out;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// Write JSON atomically: temp file then rename, so a crash never leaves a
// half-written index.
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

// Place `src` at `dest` and verify it by hash. Moves when possible (same
// drive), otherwise copies. The source is only removed after the destination
// verifies. Returns true on success.
async function placeVerified(src, dest, expectedHash, { move }) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (move) {
    try {
      fs.renameSync(src, dest);
    } catch {
      fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
    }
  } else {
    fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
  }
  const got = await md5File(dest);
  if (got !== expectedHash) {
    try {
      fs.unlinkSync(dest);
    } catch {}
    return false;
  }
  if (move && fs.existsSync(src)) fs.unlinkSync(src);
  return true;
}

module.exports = { md5File, readHead, walk, readJson, writeJson, placeVerified };
