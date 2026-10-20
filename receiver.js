#!/usr/bin/env node
'use strict';
/*
  PicJot Wi-Fi receiver, shown as "PicJot WiFi Backup Manager" (called PicJot
  Receiver until 2026-10-20; roadmap Step 33; design in docs/wifi-backup.md).

    node pc/receiver.js                 # in this window; backs up to the folder the USB backup uses
    node pc/receiver.js --background    # for the tray icon (pc/tray): no browser, a log file,
                                        # "quit" on stdin (or stdin closing) stops it
    node pc/receiver.js --to "E:\Photos" [--port 47823] [--page-port 47824] [--no-browser]

  The phone sends, the PC decides. The receiver collects the phone's photo
  listing and the photos it asks for into the same staging folder the USB
  backup uses, then runs pc/backup.js's runBackup on them, so the checking,
  filing, tag files and receipts are exactly the USB backup's. The receipt
  and "tags synced" marker go back to the phone in the reply; the app saves
  them in its tag folder, as the USB tool would.

  Security: HTTPS with a self-signed certificate whose public key the phone
  pins (learned from the pairing QR code); each phone has its own token (only
  its SHA-256 is stored); requests from outside private networks are refused.
  The local pages (status, pairing; http://127.0.0.1 on this PC only) answer
  only requests addressed to 127.0.0.1 or localhost, so a web page can't
  reach them by pointing a name of its own at this PC.
  Pairing: /pair shows a QR code with the PC's addresses, the port, the
  certificate pin and a one-time code that expires after 10 minutes.
  Discovery (stage 2): the receiver announces itself on the home network
  (lib/mdns.js), so the phone finds it after the PC's address changes.
  The backup folder is read from %APPDATA%\PhotoApp\backup.json for each
  backup (unless --to is given), so changing it needs no restart. While it's
  missing (an unplugged drive) the receiver keeps running and tells the phone.
*/
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');

const { runBackup } = require('./backup');
const { createCertificate } = require('./lib/cert');
const { readJson, writeJson } = require('./lib/files');
const { isImage, isSidecarName } = require('./lib/plan');
const { createResponder } = require('./lib/mdns');
const { tagsText } = require('./lib/words');
const qrcode = require('./lib/vendor/qrcode');

// Its name on its pages and in messages (the tray program uses the same).
const APP_NAME = 'PicJot WiFi Backup Manager';
const PROTOCOL = 1;
const DEFAULT_PORT = 47823;
const DEFAULT_PAGE_PORT = 47824;
const PAIR_CODE_MS = 10 * 60 * 1000;
const MAX_JSON_BYTES = 32 * 1024 * 1024;
// A phone counts as backing up until this long after its last request (the
// tray keeps the PC awake meanwhile).
const BUSY_IDLE_MS = 2 * 60 * 1000;
const RECENT_LINES = 50;
const LOG_MAX_BYTES = 1024 * 1024;
// The phone folders a backup covers (as the USB backup).
const PHOTO_ROOTS = ['DCIM/', 'Pictures/', 'Download/'];

// ── Small helpers ─────────────────────────────────────────────────────────
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest();
const fromPosix = (p) => p.split('/').join(path.sep);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// A phone path that is safe to use under the staging folder: relative,
// forward slashes, no "." / ".." / empty parts, no drive letters.
function safeRel(rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 400) return false;
  if (rel.startsWith('/') || rel.includes('\\') || rel.includes(':') || rel.includes('\0')) return false;
  return rel.split('/').every((part) => part && part !== '.' && part !== '..');
}
const isPhotoRel = (rel) => safeRel(rel) && PHOTO_ROOTS.some((r) => rel.startsWith(r)) && isImage(rel);

// Loopback, private IPv4 ranges, link-local and unique-local IPv6 (also as
// IPv4-mapped addresses). Everything else is refused.
function isPrivateAddress(addr) {
  if (!addr) return false;
  const a = addr.replace(/^::ffff:/i, '');
  if (a === '::1' || a.startsWith('127.')) return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a);
  if (m) {
    const [x, y] = [Number(m[1]), Number(m[2])];
    return x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 169 && y === 254);
  }
  return /^fe[89ab]/i.test(a) || /^f[cd]/i.test(a);
}

// This PC's private IPv4 addresses (the phone tries them in order).
function localAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal && isPrivateAddress(i.address)) out.push(i.address);
    }
  }
  return out;
}

function readBody(req, limit = MAX_JSON_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (d) => {
      size += d.length;
      if (size > limit) {
        reject(Object.assign(new Error('request too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  try {
    return JSON.parse((await readBody(req)).toString('utf8'));
  } catch (e) {
    if (e.status) throw e;
    throw Object.assign(new Error('invalid JSON'), { status: 400 });
  }
}

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

function sendHtml(res, html) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(html);
}

const fail = (status, message) => Object.assign(new Error(message), { status });

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

// A finished backup in a sentence, e.g. "8 new photos backed up, 721
// already on the PC." (the phone's wording, lib/wifiBackup.js resultText).
function backupText(b) {
  if (!b) return '';
  let text = `${plural(b.copied || 0, 'new photo')} backed up`;
  const onPc = (b.already || 0) + (b.present || 0);
  if (onPc) text += `, ${onPc} already on the PC`;
  text += '.';
  // What happened to the phone's tags, even when no photo was new.
  if ('sidecarsWritten' in b) text += ` ${tagsText({ updated: b.sidecarsWritten, removed: b.tagsRemoved })}`;
  if (b.errors) text += ` ${plural(b.errors, 'problem')} (see 'Recent Activity').`;
  return text;
}

// ── Receiver ──────────────────────────────────────────────────────────────
// configDir: where receiver.json lives (the certificate, paired phones, the
// last backup). to: the backup folder, or a function returning it (read for
// each backup). port 0 picks a free port (tests). discovery: announce the
// receiver on the home network. background: run by the tray icon (only
// changes the status page's wording).
function createReceiver({
  configDir,
  to,
  port = DEFAULT_PORT,
  host = '0.0.0.0',
  pcName = os.hostname(),
  now = () => new Date(),
  log = console.log,
  addresses = localAddresses,
  discovery = false,
  background = false,
}) {
  const configFile = path.join(configDir, 'receiver.json');
  let config = readJson(configFile, null);
  if (!config || config.version !== 1 || !config.certPem || !config.keyPem) {
    const cert = createCertificate({ now: now() });
    config = {
      version: 1,
      pcId: b64url(crypto.randomBytes(9)),
      certPem: cert.certPem,
      keyPem: cert.keyPem,
      spkiSha256: cert.spkiSha256,
      phones: {},
    };
    writeJson(configFile, config);
  }
  const saveConfig = () => writeJson(configFile, config);

  // Recent log lines, for the status page.
  const recent = [];
  const say = (m) => {
    recent.push({ at: now().toISOString(), text: m });
    if (recent.length > RECENT_LINES) recent.shift();
    log(m);
  };

  // ── The backup folder ──
  const destination = () => {
    const d = typeof to === 'function' ? to() : to;
    return d ? path.resolve(d) : null;
  };
  // Why backups can't run right now, in words for the phone; null when they can.
  function folderProblem(d = destination()) {
    if (!d) return `No backup folder is chosen on the PC yet ('${APP_NAME}' icon → 'Change Backup Folder').`;
    if (!fs.existsSync(path.parse(d).root)) {
      return `The backup folder ${d} isn't available: is the backup drive connected to the PC?`;
    }
    return null;
  }
  // The backup folder's paths, or a 503 whose message the phone shows.
  function folder() {
    const d = destination();
    const problem = folderProblem(d);
    if (problem) throw fail(503, problem);
    const meta = path.join(d, '.photoapp');
    return {
      to: d,
      meta,
      staging: path.join(meta, 'staging'),
      sessionFile: path.join(meta, 'wifi-session.json'),
      indexFile: path.join(meta, 'index.json'),
    };
  }

  // ── Pairing ──
  let pairing = null; // { code, expiresAt }
  const currentPairing = () => {
    if (!pairing || pairing.expiresAt <= now().getTime()) {
      pairing = { code: b64url(crypto.randomBytes(16)), expiresAt: now().getTime() + PAIR_CODE_MS };
    }
    return pairing;
  };
  let httpsServer = null;
  let pageServer = null;
  let responder = null;
  const listeningPort = () => (httpsServer && httpsServer.address() ? httpsServer.address().port : port);

  // The text in the QR code.
  function pairingPayload() {
    const p = currentPairing();
    const q = new URLSearchParams({
      v: String(PROTOCOL),
      id: config.pcId,
      n: pcName,
      h: addresses().join(','),
      p: String(listeningPort()),
      f: config.spkiSha256,
      c: p.code,
    });
    return `picjot-pair:?${q.toString()}`;
  }

  // A phone's device key (the app's deviceKey: the same when it pairs again or
  // PicJot is reinstalled, different for each PC), or null.
  const deviceKeyOf = (v) => (typeof v === 'string' && /^[A-Za-z0-9_-]{20,100}$/.test(v) ? v : null);

  function pair(body) {
    const p = currentPairing();
    const code = String((body && body.code) || '');
    const ok =
      code.length === p.code.length && crypto.timingSafeEqual(Buffer.from(code), Buffer.from(p.code));
    if (!ok) throw fail(403, 'pairing code not valid (it may have expired: show the QR code again)');
    const phoneId = b64url(crypto.randomBytes(9));
    const token = b64url(crypto.randomBytes(32));
    const name = String((body && body.phoneName) || 'Phone').slice(0, 80);
    const deviceKey = deviceKeyOf(body && body.deviceKey);
    // The same phone pairing again replaces its earlier pairing (whose token
    // then stops working), so a phone is never listed twice.
    const replaced = deviceKey
      ? Object.keys(config.phones).filter((id) => config.phones[id].deviceKey === deviceKey)
      : [];
    for (const id of replaced) {
      delete config.phones[id];
      if (active && active.phoneId === id) active = null;
    }
    config.phones[phoneId] = {
      name,
      tokenSha256: sha256(token).toString('base64'),
      pairedAt: now().toISOString(),
      lastSeenAt: null,
      ...(deviceKey ? { deviceKey } : {}),
    };
    saveConfig();
    pairing = null; // one use only; the page shows a fresh code
    say(replaced.length ? `Paired with ${name} again (its earlier pairing is replaced).` : `Paired with ${name}.`);
    return { phoneId, token, pcId: config.pcId, pcName };
  }

  // "Authorization: Bearer <phoneId>.<token>" -> phone id, or throws 401.
  // A pairing made before phones sent a device key gets the one this request
  // carries, so it's replaced the next time the phone pairs.
  function authenticate(req) {
    const m = /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(req.headers.authorization || '');
    const phone = m && config.phones[m[1]];
    if (!phone) throw fail(401, 'not paired');
    const given = sha256(m[2]);
    const stored = Buffer.from(phone.tokenSha256, 'base64');
    if (given.length !== stored.length || !crypto.timingSafeEqual(given, stored)) throw fail(401, 'not paired');
    const key = deviceKeyOf(req.headers['x-picjot-device']);
    if (key && !phone.deviceKey) {
      phone.deviceKey = key;
      saveConfig();
    }
    return m[1];
  }

  // The status page's Forget buttons carry this: another web page can send
  // a form to 127.0.0.1, but can't read the page to learn it.
  const formToken = b64url(crypto.randomBytes(16));

  // ── Who is backing up (for the status page and keeping the PC awake) ──
  let finishing = false;
  let active = null; // { phoneId, phone, lastAt }
  let requests = 0;
  const busy = () =>
    finishing || requests > 0 || Boolean(active && now().getTime() - active.lastAt < BUSY_IDLE_MS);

  // ── A backup session ──
  // Saved to disk so an interrupted backup resumes (the staged photos stay).
  const loadSession = (f) => readJson(f.sessionFile, null);

  // Already safe on the PC: the index has this phone path at this size and
  // the file is still there.
  function backedUpByPath(f) {
    const index = readJson(f.indexFile, { photos: {} });
    const out = new Map();
    for (const e of Object.values(index.photos || {})) {
      if (!e.from) continue;
      try {
        if (fs.statSync(path.join(f.to, fromPosix(e.path))).size === e.size) out.set(e.from, e.size);
      } catch {
        // missing on the PC: not backed up
      }
    }
    return out;
  }

  const stagedSize = (f, rel) => {
    try {
      return fs.statSync(path.join(f.staging, fromPosix(rel))).size;
    } catch {
      return -1;
    }
  };

  function inventory(phoneId, body) {
    const f = folder();
    if (finishing) throw fail(409, 'a backup is being finished; try again in a moment');
    const files = [];
    const seen = new Set();
    for (const x of (body && Array.isArray(body.files) && body.files) || []) {
      const size = Number(x && x.size);
      if (!x || !isPhotoRel(x.rel) || !Number.isSafeInteger(size) || size < 0 || seen.has(x.rel)) continue;
      seen.add(x.rel);
      files.push({ rel: x.rel, size, modified: x.modified ? String(x.modified) : '' });
    }
    const backedUp = backedUpByPath(f);
    const need = [];
    for (const x of files) {
      x.already = backedUp.get(x.rel) === x.size;
      if (!x.already && stagedSize(f, x.rel) !== x.size) need.push(x.rel);
    }
    const phone = String((body && body.phone) || config.phones[phoneId].name).slice(0, 80);
    // The phone's name as it says now (e.g. its own name was added: "DJP S23
    // (Samsung SM-S911U)"), so the status page lists it as the phone does.
    if (body && body.phone && phone !== config.phones[phoneId].name) {
      config.phones[phoneId].name = phone;
      saveConfig();
    }
    writeJson(f.sessionFile, { phoneId, phone, startedAt: now().toISOString(), files });
    active = { phoneId, phone, lastAt: now().getTime() };
    if (need.length) say(`${phone} is backing up: ${plural(need.length, 'photo')} to receive.`);
    // The backup folder, for the phone's Settings ("PC > folder").
    return { need, total: files.length, already: files.filter((x) => x.already).length, folder: f.to };
  }

  async function receiveFile(phoneId, req, url) {
    const f = folder();
    const rel = url.searchParams.get('rel');
    const session = loadSession(f);
    const listed = session && session.phoneId === phoneId && session.files.find((x) => x.rel === rel);
    if (!listed) throw fail(409, 'not in this backup (send the photo list first)');
    const declared = Number(req.headers['content-length']);
    if (req.headers['content-length'] != null && declared !== listed.size) {
      throw fail(400, `size ${declared} doesn't match the listed ${listed.size}`);
    }
    const dest = path.join(f.staging, fromPosix(rel));
    const part = `${dest}.part`;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    await pipeline(req, fs.createWriteStream(part));
    const got = fs.statSync(part).size;
    if (got !== listed.size) {
      fs.rmSync(part, { force: true });
      throw fail(400, `received ${got} bytes, expected ${listed.size}`);
    }
    fs.renameSync(part, dest);
    return { ok: true, rel, size: got };
  }

  async function finish(phoneId, body) {
    const f = folder();
    const session = loadSession(f);
    if (!session || session.phoneId !== phoneId) throw fail(409, 'no backup in progress (send the photo list first)');
    if (finishing) throw fail(409, 'a backup is already being finished');
    finishing = true;
    try {
      // Tag files: written into staging under the phone's tag folder; a tag
      // file whose text hasn't changed since it was last handled is skipped.
      const tagFolder = body && body.tagFolder;
      const tagListing = [];
      const pulled = readJson(path.join(f.meta, 'pulled.json'), {});
      if (Array.isArray(body && body.tagFiles) && body.tagFiles.length) {
        if (!safeRel(tagFolder)) throw fail(400, 'tag folder path not valid');
        for (const t of body.tagFiles) {
          if (!t || !isSidecarName(String(t.name || '')) || typeof t.text !== 'string') continue;
          const rel = `${tagFolder}/${t.name}`;
          const sig = `text|${sha256(t.text).toString('base64')}`;
          const already = pulled[rel] === sig;
          if (!already) {
            const dest = path.join(f.staging, fromPosix(rel));
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.writeFileSync(dest, t.text);
          }
          tagListing.push({ rel, size: Buffer.byteLength(t.text), modified: '', sig, kind: 'sidecar', already, staged: !already });
        }
      }
      const listing = [
        ...session.files.map((x) => ({
          rel: x.rel,
          size: x.size,
          modified: x.modified,
          sig: `${x.size}|${x.modified}`,
          kind: 'image',
          already: x.already,
          staged: stagedSize(f, x.rel) === x.size,
        })),
        ...tagListing,
      ];

      const delivered = {};
      const lines = [];
      const result = await runBackup({
        to: f.to,
        over: 'Wi-Fi',
        log: (m) => {
          lines.push(m);
          say(m);
        },
        now,
        pull: async () => ({ phone: session.phone, files: listing, errors: [] }),
        // Receipts and markers go back in the reply instead of over USB.
        push: async ({ file }) => {
          const name = path.basename(file);
          delivered[name.startsWith('backup-receipt-') ? 'receipt' : 'tagSync'] = {
            name,
            text: fs.readFileSync(file, 'utf8'),
          };
          return { pushed: true, errors: [] };
        },
      });

      // Always send the newest receipt, so a phone that missed one catches up.
      if (!delivered.receipt) {
        const dir = path.join(f.meta, 'receipts');
        const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => /^backup-receipt-.*\.json$/.test(n)).sort() : [];
        const newest = names[names.length - 1];
        if (newest) delivered.receipt = { name: newest, text: fs.readFileSync(path.join(dir, newest), 'utf8') };
      }
      fs.rmSync(f.sessionFile, { force: true });
      const summary = {
        copied: result.copied || 0,
        present: result.present || 0,
        tagged: result.tagged || 0,
        sidecarsWritten: result.sidecarsWritten || 0,
        tagsRemoved: result.tagsRemoved || 0,
        failed: result.failed || 0,
        missingOnPc: result.missingOnPc || 0,
      };
      config.phones[phoneId].lastSeenAt = now().toISOString();
      config.lastBackup = {
        at: now().toISOString(),
        phone: session.phone,
        ...summary,
        already: session.files.filter((x) => x.already).length,
        errors: (result.errors || []).length,
      };
      saveConfig();
      say(`Backup from ${session.phone} finished: ${backupText(config.lastBackup)}`);
      active = null;
      return {
        summary,
        receipt: delivered.receipt || null,
        tagSync: delivered.tagSync || null,
        errors: result.errors || [],
        log: lines,
      };
    } finally {
      finishing = false;
    }
  }

  // ── HTTPS (the phone) ──
  async function handle(req, res) {
    let counted = false;
    try {
      if (!isPrivateAddress(req.socket.remoteAddress)) throw fail(403, 'only on a private network');
      const url = new URL(req.url, 'https://receiver');
      const route = `${req.method} ${url.pathname}`;
      if (route === 'GET /v1/hello') {
        const problem = folderProblem();
        return send(res, 200, {
          app: 'picjot-receiver',
          protocol: PROTOCOL,
          pcId: config.pcId,
          pcName,
          hosts: addresses(),
          ready: !problem,
          problem,
        });
      }
      if (route === 'POST /v1/pair') return send(res, 200, pair(await readJsonBody(req)));
      const phoneId = authenticate(req);
      requests += 1;
      counted = true;
      if (!active || active.phoneId !== phoneId) {
        active = { phoneId, phone: config.phones[phoneId].name, lastAt: now().getTime() };
      }
      if (route === 'POST /v1/inventory') return send(res, 200, inventory(phoneId, await readJsonBody(req)));
      if (route === 'PUT /v1/file') return send(res, 200, await receiveFile(phoneId, req, url));
      if (route === 'POST /v1/finish') return send(res, 200, await finish(phoneId, await readJsonBody(req)));
      throw fail(404, 'not found');
    } catch (e) {
      if (!e.status || e.status === 503) say(e.status ? e.message : `Receiver error: ${e.message}`);
      if (!res.headersSent) send(res, e.status || 500, { error: e.message });
      else res.destroy();
    } finally {
      if (counted) {
        requests -= 1;
        if (active) active.lastAt = now().getTime();
      }
    }
    return undefined;
  }

  // ── Local pages (this PC only) ──
  function status() {
    const d = destination();
    const isBusy = busy();
    return {
      app: 'picjot-receiver',
      pcName,
      port: listeningPort(),
      addresses: addresses(),
      folder: d,
      problem: folderProblem(d),
      busy: isBusy,
      phone: isBusy && active ? active.phone : null,
      lastBackup: config.lastBackup ? { ...config.lastBackup, text: backupText(config.lastBackup) } : null,
      phoneCount: Object.keys(config.phones).length,
      phones: Object.entries(config.phones).map(([id, p]) => ({ id, name: p.name, pairedAt: p.pairedAt, lastSeenAt: p.lastSeenAt })),
      recent: recent.slice(-15).reverse(),
    };
  }

  const STYLE = `body{font-family:system-ui,sans-serif;background:#111;color:#eee;max-width:620px;margin:40px auto;padding:0 16px;line-height:1.5}
h1{font-size:24px;margin-bottom:4px}h2{font-size:17px;margin:28px 0 6px}.muted{color:#aaa}a{color:#f0b23c}
.qr{background:#fff;display:inline-block;padding:12px;border-radius:12px}
.state{font-size:17px;margin:8px 0 20px}.ok{color:#7fc79a}.busy{color:#f0b23c}.warn{color:#ff8a80}
dl{display:grid;grid-template-columns:auto 1fr;gap:4px 16px;margin:0}dt{color:#aaa}dd{margin:0;overflow-wrap:anywhere}
.button{display:inline-block;background:#2d6a4f;color:#fff;text-decoration:none;padding:10px 18px;border-radius:999px;font-weight:600;margin-top:8px}
ul{padding-left:20px;margin:4px 0}.log{font-size:13px;color:#ccc;list-style:none;padding:0}.log span{color:#888;margin-right:8px}
form.inline{display:inline;margin-left:8px}form.inline button{background:none;border:1px solid #555;color:#ccc;border-radius:999px;padding:1px 10px;font:inherit;font-size:13px;cursor:pointer}`;

  const when = (iso) => {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    } catch {
      return iso;
    }
  };

  function statusPage() {
    const s = status();
    const state = s.busy
      ? `<p class="state busy">● Backing up from ${esc(s.phone || 'a phone')}…</p>`
      : s.problem
        ? `<p class="state warn">● ${esc(s.problem)}</p>`
        : '<p class="state ok">● Ready: phones can back up whenever this PC is on.</p>';
    const last = s.lastBackup
      ? `${esc(when(s.lastBackup.at))} from ${esc(s.lastBackup.phone)}: ${esc(s.lastBackup.text)}`
      : 'None yet.';
    const phones = s.phones.length
      ? `<ul>${s.phones
          .map(
            (p) =>
              `<li>${esc(p.name)} <span class="muted">· paired ${esc(when(p.pairedAt))}${
                p.lastSeenAt ? ` · last backup ${esc(when(p.lastSeenAt))}` : ''
              }</span><form class="inline" method="post" action="/forget" onsubmit="return confirm('Forget this phone? It stops backing up to this PC until it pairs again.')"><input type="hidden" name="phone" value="${esc(p.id)}"><input type="hidden" name="t" value="${formToken}"><button>Forget</button></form></li>`
          )
          .join('')}</ul>`
      : '<p class="muted">No phone paired yet.</p>';
    const log = s.recent.length
      ? `<ul class="log">${s.recent.map((r) => `<li><span>${esc(when(r.at))}</span>${esc(r.text)}</li>`).join('')}</ul>`
      : '<p class="muted">Nothing yet.</p>';
    const footer = background
      ? `${APP_NAME} runs in the background. Right-click its icon by the clock for 'Pair a Phone', 'Change Backup Folder', 'Start with Windows' or 'Quit'. Its log: %APPDATA%\\PhotoApp\\receiver.log.`
      : 'Running in a window: close the window to stop the receiver.';
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="10">
<title>${APP_NAME}</title><style>${STYLE}</style></head><body>
<h1>${APP_NAME}</h1>
${state}
<dl>
<dt>This PC</dt><dd>${esc(s.pcName)} (${esc(s.addresses.join(', ') || 'no network found')}), port ${s.port}</dd>
<dt>Backup Folder</dt><dd>${esc(s.folder || 'not chosen yet')}</dd>
<dt>Last Backup</dt><dd>${last}</dd>
</dl>
<h2>Phones</h2>
${phones}
<a class="button" href="/pair">Pair a Phone</a>
<h2>Recent Activity</h2>
${log}
<p class="muted" style="margin-top:28px">${esc(footer)}</p>
</body></html>`;
  }

  function pairingPage() {
    const qr = qrcode(0, 'M');
    qr.addData(pairingPayload());
    qr.make();
    const phones = Object.values(config.phones).map((p) => p.name);
    const addrs = addresses();
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="60">
<title>Pair a Phone · ${APP_NAME}</title><style>${STYLE}</style></head><body>
<p><a href="/">← ${APP_NAME}</a></p>
<h1>Pair a Phone with PicJot</h1>
<p>In PicJot on the phone: <b>'Settings → Backup → Back Up over Wi-Fi → Pair with PC'</b>, then scan this code.</p>
<div class="qr">${qr.createSvgTag({ cellSize: 6, margin: 2 })}</div>
<p class="muted">This PC: ${esc(pcName)} (${esc(addrs.join(', ') || 'no network found')}), port ${listeningPort()}.<br>
Backups go to ${esc(destination() || 'a folder not chosen yet')}.<br>The code works once and expires after 10 minutes; this page refreshes itself.</p>
${phones.length ? `<p>Paired: ${phones.map(esc).join(', ')}</p>` : ''}
</body></html>`;
  }

  // Only requests addressed to this PC by number or as localhost: a web page
  // that points a name of its own at 127.0.0.1 is refused (DNS rebinding).
  function addressedHere(req) {
    const p = pageServer && pageServer.address() ? pageServer.address().port : 0;
    return req.headers.host === `127.0.0.1:${p}` || req.headers.host === `localhost:${p}`;
  }

  // Forget a paired phone (a lost one, or one that paired again): its token
  // stops working. Only from the status page: same origin, its form token.
  async function forgetPhone(req, res) {
    const p = pageServer.address().port;
    const origin = req.headers.origin;
    let form = null;
    if (!origin || origin === `http://127.0.0.1:${p}` || origin === `http://localhost:${p}`) {
      form = Object.fromEntries(new URLSearchParams((await readBody(req, 4096)).toString('utf8')));
    }
    if (!form || form.t !== formToken) {
      res.writeHead(403);
      res.end();
      return;
    }
    const phone = config.phones[form.phone];
    if (phone) {
      delete config.phones[form.phone];
      saveConfig();
      if (active && active.phoneId === form.phone) active = null;
      say(`Forgot ${phone.name} (paired ${when(phone.pairedAt)}): it needs to pair again to back up.`);
    }
    res.writeHead(303, { location: '/' });
    res.end();
  }

  function pages(req, res) {
    if (!addressedHere(req)) {
      res.writeHead(403);
      res.end();
      return;
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/') return sendHtml(res, statusPage());
    if (req.method === 'GET' && url.pathname === '/pair') return sendHtml(res, pairingPage());
    if (req.method === 'GET' && url.pathname === '/api/status') return send(res, 200, status());
    if (req.method === 'POST' && url.pathname === '/forget') {
      forgetPhone(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(400);
        res.end();
      });
      return undefined;
    }
    res.writeHead(404);
    res.end();
    return undefined;
  }

  async function start({ pagePort = 0 } = {}) {
    const problem = folderProblem();
    if (problem) say(problem);
    httpsServer = https.createServer({ key: config.keyPem, cert: config.certPem, minVersion: 'TLSv1.2' }, handle);
    await listen(httpsServer, port, host);
    pageServer = http.createServer(pages);
    try {
      await listen(pageServer, pagePort, '127.0.0.1');
    } catch (e) {
      await stop();
      throw e;
    }
    if (discovery) responder = createResponder({ pcId: config.pcId, port: listeningPort, log: say });
    return { port: listeningPort(), pageUrl: `http://127.0.0.1:${pageServer.address().port}/` };
  }

  async function stop() {
    if (responder) await responder.close();
    responder = null;
    for (const s of [httpsServer, pageServer]) {
      if (!s || !s.listening) continue;
      s.closeAllConnections();
      await new Promise((r) => s.close(r));
    }
    httpsServer = null;
    pageServer = null;
  }

  // Resolves once no backup is being filed (so quitting never cuts one off).
  const whenIdle = () =>
    new Promise((resolve) => {
      const check = () => (finishing ? setTimeout(check, 500) : resolve());
      check();
    });

  return {
    start,
    stop,
    whenIdle,
    status,
    isFinishing: () => finishing,
    pairingPayload,
    currentPairing,
    spkiSha256: config.spkiSha256,
    pcId: config.pcId,
  };
}

// ── CLI ───────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { port: DEFAULT_PORT, pagePort: DEFAULT_PAGE_PORT, browser: true, background: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--to') out.to = argv[++i];
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--page-port') out.pagePort = Number(argv[++i]);
    else if (a === '--no-browser') out.browser = false;
    else if (a === '--background') {
      out.background = true;
      out.browser = false;
    } else if (a === '-h' || a === '--help') out.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return out;
}

// Local time as "2026-10-19 14:03:22".
function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Appends timestamped lines to `file`; past 1 MB it becomes `file`.1 and a
// new one starts. Never throws.
function fileLogger(file) {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    // a new log
  }
  return (line) => {
    try {
      if (size > LOG_MAX_BYTES) {
        fs.renameSync(file, `${file}.1`);
        size = 0;
      }
      const text = `${stamp()}  ${line}\n`;
      fs.appendFileSync(file, text);
      size += Buffer.byteLength(text);
    } catch {
      // logging must never stop the receiver
    }
  };
}

if (require.main === module) {
  (async () => {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log('Usage: node pc/receiver.js [--background] [--to <folder>] [--port <n>] [--page-port <n>] [--no-browser]');
      return;
    }
    const configDir = path.join(process.env.APPDATA || os.homedir(), 'PhotoApp');
    const chosen = () => (readJson(path.join(configDir, 'backup.json'), {}) || {}).destination || null;
    const to = args.to ? path.resolve(args.to) : chosen;
    if (!args.background && !args.to && !chosen()) {
      console.log('No backup folder chosen yet. Run "Backup photos.cmd" once to choose it, or use --to <folder>.');
      process.exitCode = 2;
      return;
    }
    fs.mkdirSync(configDir, { recursive: true });
    const toFile = fileLogger(path.join(configDir, 'receiver.log'));
    const log = (m) => {
      console.log(m);
      toFile(m);
    };
    process.on('uncaughtException', (e) => {
      log(`Unexpected problem: ${(e && e.stack) || e}`);
      process.exit(1);
    });

    const receiver = createReceiver({ configDir, to, port: args.port, log, discovery: true, background: args.background });
    let started;
    try {
      started = await receiver.start({ pagePort: args.pagePort });
    } catch (e) {
      if (e && e.code === 'EADDRINUSE') {
        log(`Port ${e.port} is already in use: ${APP_NAME} may already be running (look for its icon by the clock).`);
        process.exitCode = 3;
        return;
      }
      throw e;
    }
    const { port, pageUrl } = started;
    // Plain ASCII: the Windows console mangles typographic characters.
    log(`${APP_NAME} is running on ${os.hostname()} (${localAddresses().join(', ') || 'no network'}), port ${port}.`);
    log(`Backups go to ${(typeof to === 'function' ? to() : to) || '(no folder chosen yet)'}. Status page: ${pageUrl}`);
    if (!args.background) {
      console.log(
        `To pair a phone, open ${pageUrl}pair${args.browser ? ' (opening it now)' : ''}. ` +
          'Keep this window open while the phone backs up; close it to stop.'
      );
      if (args.browser && process.platform === 'win32') {
        require('child_process').spawn('cmd', ['/c', 'start', '', `${pageUrl}pair`], { detached: true, stdio: 'ignore' }).unref();
      }
    }

    // Stopping waits for a backup being filed, so it's never cut off.
    let stopping = false;
    const shutdown = async (why) => {
      if (stopping) return;
      stopping = true;
      log(`${why} Stopping${receiver.isFinishing() ? ' once the backup being filed is done' : ''}.`);
      await receiver.whenIdle();
      await receiver.stop();
      process.exit(0);
    };
    process.on('SIGINT', () => shutdown('Ctrl+C.'));
    if (args.background) {
      // The tray icon writes "quit"; if the tray itself goes, stdin closes.
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (d) => /\bquit\b/.test(d) && shutdown('Asked to quit.'));
      process.stdin.on('end', () => shutdown('The tray icon has closed.'));
      process.stdin.on('error', () => shutdown('The tray icon has closed.'));
    }
  })().catch((e) => {
    console.error(`Receiver failed: ${e.message}`);
    process.exitCode = 1;
  });
}

module.exports = { createReceiver, isPrivateAddress, safeRel, isPhotoRel, parseArgs, backupText };
