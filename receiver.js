#!/usr/bin/env node
'use strict';
/*
  PicJot Wi-Fi receiver (roadmap Step 33; design in docs/wifi-backup.md).

    node pc/receiver.js                 # backs up to the folder the USB backup uses
    node pc/receiver.js --to "E:\Photos" [--port 47823] [--no-browser]

  The phone sends, the PC decides. The receiver collects the phone's photo
  listing and the photos it asks for into the same staging folder the USB
  backup uses, then runs pc/backup.js's runBackup on them, so the checking,
  filing, tag files and receipts are exactly the USB backup's. The receipt
  and "tags synced" marker go back to the phone in the reply; the app saves
  them in its tag folder, as the USB tool would.

  Security: HTTPS with a self-signed certificate whose public key the phone
  pins (learned from the pairing QR code); each phone has its own token (only
  its SHA-256 is stored); requests from outside private networks are refused.
  Pairing: a local page (http://127.0.0.1, this PC only) shows a QR code with
  the PC's addresses, the port, the certificate pin and a one-time code that
  expires after 10 minutes.
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
const qrcode = require('./lib/vendor/qrcode');

const PROTOCOL = 1;
const DEFAULT_PORT = 47823;
const PAIR_CODE_MS = 10 * 60 * 1000;
const MAX_JSON_BYTES = 32 * 1024 * 1024;
// The phone folders a backup covers (as the USB backup).
const PHOTO_ROOTS = ['DCIM/', 'Pictures/', 'Download/'];

// ── Small helpers ─────────────────────────────────────────────────────────
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest();
const fromPosix = (p) => p.split('/').join(path.sep);

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

const fail = (status, message) => Object.assign(new Error(message), { status });

// ── Receiver ──────────────────────────────────────────────────────────────
// configDir: where receiver.json lives (the certificate, paired phones).
// to: the backup folder. port 0 picks a free port (tests).
function createReceiver({
  configDir,
  to,
  port = DEFAULT_PORT,
  host = '0.0.0.0',
  pcName = os.hostname(),
  now = () => new Date(),
  log = console.log,
  addresses = localAddresses,
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

  const meta = path.join(to, '.photoapp');
  const staging = path.join(meta, 'staging');
  const sessionFile = path.join(meta, 'wifi-session.json');
  const indexFile = path.join(meta, 'index.json');

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

  function pair(body) {
    const p = currentPairing();
    const code = String((body && body.code) || '');
    const ok =
      code.length === p.code.length && crypto.timingSafeEqual(Buffer.from(code), Buffer.from(p.code));
    if (!ok) throw fail(403, 'pairing code not valid (it may have expired: show the QR code again)');
    const phoneId = b64url(crypto.randomBytes(9));
    const token = b64url(crypto.randomBytes(32));
    const name = String((body && body.phoneName) || 'Phone').slice(0, 80);
    config.phones[phoneId] = {
      name,
      tokenSha256: sha256(token).toString('base64'),
      pairedAt: now().toISOString(),
      lastSeenAt: null,
    };
    saveConfig();
    pairing = null; // one use only; the page shows a fresh code
    log(`Paired with ${name}.`);
    return { phoneId, token, pcId: config.pcId, pcName };
  }

  // "Authorization: Bearer <phoneId>.<token>" -> phone id, or throws 401.
  function authenticate(req) {
    const m = /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(req.headers.authorization || '');
    const phone = m && config.phones[m[1]];
    if (!phone) throw fail(401, 'not paired');
    const given = sha256(m[2]);
    const stored = Buffer.from(phone.tokenSha256, 'base64');
    if (given.length !== stored.length || !crypto.timingSafeEqual(given, stored)) throw fail(401, 'not paired');
    return m[1];
  }

  // ── A backup session ──
  // Saved to disk so an interrupted backup resumes (the staged photos stay).
  const loadSession = () => readJson(sessionFile, null);

  // Already safe on the PC: the index has this phone path at this size and
  // the file is still there.
  function backedUpByPath() {
    const index = readJson(indexFile, { photos: {} });
    const out = new Map();
    for (const e of Object.values(index.photos || {})) {
      if (!e.from) continue;
      try {
        if (fs.statSync(path.join(to, fromPosix(e.path))).size === e.size) out.set(e.from, e.size);
      } catch {
        // missing on the PC: not backed up
      }
    }
    return out;
  }

  const stagedSize = (rel) => {
    try {
      return fs.statSync(path.join(staging, fromPosix(rel))).size;
    } catch {
      return -1;
    }
  };

  function inventory(phoneId, body) {
    if (finishing) throw fail(409, 'a backup is being finished; try again in a moment');
    const files = [];
    const seen = new Set();
    for (const f of (body && Array.isArray(body.files) && body.files) || []) {
      const size = Number(f && f.size);
      if (!f || !isPhotoRel(f.rel) || !Number.isSafeInteger(size) || size < 0 || seen.has(f.rel)) continue;
      seen.add(f.rel);
      files.push({ rel: f.rel, size, modified: f.modified ? String(f.modified) : '' });
    }
    const backedUp = backedUpByPath();
    const need = [];
    for (const f of files) {
      f.already = backedUp.get(f.rel) === f.size;
      if (!f.already && stagedSize(f.rel) !== f.size) need.push(f.rel);
    }
    const phone = String((body && body.phone) || config.phones[phoneId].name).slice(0, 80);
    writeJson(sessionFile, { phoneId, phone, startedAt: now().toISOString(), files });
    return { need, total: files.length, already: files.filter((f) => f.already).length };
  }

  async function receiveFile(phoneId, req, url) {
    const rel = url.searchParams.get('rel');
    const session = loadSession();
    const f = session && session.phoneId === phoneId && session.files.find((x) => x.rel === rel);
    if (!f) throw fail(409, 'not in this backup (send the photo list first)');
    const declared = Number(req.headers['content-length']);
    if (req.headers['content-length'] != null && declared !== f.size) {
      throw fail(400, `size ${declared} doesn't match the listed ${f.size}`);
    }
    const dest = path.join(staging, fromPosix(rel));
    const part = `${dest}.part`;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    await pipeline(req, fs.createWriteStream(part));
    const got = fs.statSync(part).size;
    if (got !== f.size) {
      fs.rmSync(part, { force: true });
      throw fail(400, `received ${got} bytes, expected ${f.size}`);
    }
    fs.renameSync(part, dest);
    return { ok: true, rel, size: got };
  }

  let finishing = false;
  async function finish(phoneId, body) {
    const session = loadSession();
    if (!session || session.phoneId !== phoneId) throw fail(409, 'no backup in progress (send the photo list first)');
    if (finishing) throw fail(409, 'a backup is already being finished');
    finishing = true;
    try {
      // Tag files: written into staging under the phone's tag folder; a tag
      // file whose text hasn't changed since it was last handled is skipped.
      const tagFolder = body && body.tagFolder;
      const tagListing = [];
      const pulled = readJson(path.join(meta, 'pulled.json'), {});
      if (Array.isArray(body && body.tagFiles) && body.tagFiles.length) {
        if (!safeRel(tagFolder)) throw fail(400, 'tag folder path not valid');
        for (const t of body.tagFiles) {
          if (!t || !isSidecarName(String(t.name || '')) || typeof t.text !== 'string') continue;
          const rel = `${tagFolder}/${t.name}`;
          const sig = `text|${sha256(t.text).toString('base64')}`;
          const already = pulled[rel] === sig;
          if (!already) {
            const dest = path.join(staging, fromPosix(rel));
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.writeFileSync(dest, t.text);
          }
          tagListing.push({ rel, size: Buffer.byteLength(t.text), modified: '', sig, kind: 'sidecar', already, staged: !already });
        }
      }
      const listing = [
        ...session.files.map((f) => ({
          rel: f.rel,
          size: f.size,
          modified: f.modified,
          sig: `${f.size}|${f.modified}`,
          kind: 'image',
          already: f.already,
          staged: stagedSize(f.rel) === f.size,
        })),
        ...tagListing,
      ];

      const delivered = {};
      const lines = [];
      const result = await runBackup({
        to,
        over: 'Wi-Fi',
        log: (m) => {
          lines.push(m);
          log(m);
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
        const dir = path.join(meta, 'receipts');
        const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => /^backup-receipt-.*\.json$/.test(n)).sort() : [];
        const newest = names[names.length - 1];
        if (newest) delivered.receipt = { name: newest, text: fs.readFileSync(path.join(dir, newest), 'utf8') };
      }
      fs.rmSync(sessionFile, { force: true });
      config.phones[phoneId].lastSeenAt = now().toISOString();
      saveConfig();
      return {
        summary: {
          copied: result.copied || 0,
          present: result.present || 0,
          tagged: result.tagged || 0,
          sidecarsWritten: result.sidecarsWritten || 0,
          tagsRemoved: result.tagsRemoved || 0,
          failed: result.failed || 0,
          missingOnPc: result.missingOnPc || 0,
        },
        receipt: delivered.receipt || null,
        tagSync: delivered.tagSync || null,
        errors: result.errors || [],
        log: lines,
      };
    } finally {
      finishing = false;
    }
  }

  // ── HTTP handling ──
  async function handle(req, res) {
    try {
      if (!isPrivateAddress(req.socket.remoteAddress)) throw fail(403, 'only on a private network');
      const url = new URL(req.url, 'https://receiver');
      const route = `${req.method} ${url.pathname}`;
      if (route === 'GET /v1/hello') {
        return send(res, 200, { app: 'picjot-receiver', protocol: PROTOCOL, pcId: config.pcId, pcName });
      }
      if (route === 'POST /v1/pair') return send(res, 200, pair(await readJsonBody(req)));
      const phoneId = authenticate(req);
      if (route === 'POST /v1/inventory') return send(res, 200, inventory(phoneId, await readJsonBody(req)));
      if (route === 'PUT /v1/file') return send(res, 200, await receiveFile(phoneId, req, url));
      if (route === 'POST /v1/finish') return send(res, 200, await finish(phoneId, await readJsonBody(req)));
      throw fail(404, 'not found');
    } catch (e) {
      if (!e.status) log(`Receiver error: ${e.message}`);
      if (!res.headersSent) send(res, e.status || 500, { error: e.message });
      else res.destroy();
    }
    return undefined;
  }

  // The pairing page: this PC only (127.0.0.1), so no certificate warning.
  function pairingPage(req, res) {
    if (req.url !== '/') {
      res.writeHead(404);
      res.end();
      return;
    }
    const qr = qrcode(0, 'M');
    qr.addData(pairingPayload());
    qr.make();
    const phones = Object.values(config.phones).map((p) => p.name);
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    const addrs = addresses();
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="60">
<title>PicJot receiver</title>
<style>body{font-family:system-ui,sans-serif;background:#111;color:#eee;max-width:560px;margin:40px auto;padding:0 16px;line-height:1.5}
.qr{background:#fff;display:inline-block;padding:12px;border-radius:12px}h1{font-size:24px}.muted{color:#aaa}</style></head><body>
<h1>Pair a phone with PicJot</h1>
<p>In PicJot on the phone: <b>Settings → Backup → Back up over Wi-Fi → Pair with PC</b>, then scan this code.</p>
<div class="qr">${qr.createSvgTag({ cellSize: 6, margin: 2 })}</div>
<p class="muted">This PC: ${esc(pcName)} (${esc(addrs.join(', ') || 'no network found')}), port ${listeningPort()}.<br>
Backups go to ${esc(to)}.<br>The code works once and expires after 10 minutes; this page refreshes itself.</p>
${phones.length ? `<p>Paired: ${phones.map(esc).join(', ')}</p>` : ''}
</body></html>`);
  }

  async function start({ pagePort = 0 } = {}) {
    if (!fs.existsSync(to)) throw new Error(`The backup folder isn't available: ${to}`);
    httpsServer = https.createServer({ key: config.keyPem, cert: config.certPem, minVersion: 'TLSv1.2' }, handle);
    await new Promise((resolve, reject) => {
      httpsServer.once('error', reject);
      httpsServer.listen(port, host, resolve);
    });
    pageServer = http.createServer(pairingPage);
    await new Promise((resolve) => pageServer.listen(pagePort, '127.0.0.1', resolve));
    return { port: listeningPort(), pageUrl: `http://127.0.0.1:${pageServer.address().port}/` };
  }

  async function stop() {
    for (const s of [httpsServer, pageServer]) {
      if (!s) continue;
      s.closeAllConnections();
      await new Promise((r) => s.close(r));
    }
    httpsServer = null;
    pageServer = null;
  }

  return { start, stop, pairingPayload, currentPairing, spkiSha256: config.spkiSha256, pcId: config.pcId };
}

// ── CLI ───────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { port: DEFAULT_PORT, browser: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--to') out.to = argv[++i];
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--no-browser') out.browser = false;
    else if (a === '-h' || a === '--help') out.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return out;
}

if (require.main === module) {
  (async () => {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log('Usage: node pc/receiver.js [--to <folder>] [--port <n>] [--no-browser]');
      return;
    }
    const configDir = path.join(process.env.APPDATA || os.homedir(), 'PhotoApp');
    const to = args.to || (readJson(path.join(configDir, 'backup.json'), {}) || {}).destination;
    if (!to) {
      console.log('No backup folder chosen yet. Run "Backup photos.cmd" once to choose it, or use --to <folder>.');
      process.exitCode = 2;
      return;
    }
    const receiver = createReceiver({ configDir, to: path.resolve(to), port: args.port });
    const { port, pageUrl } = await receiver.start();
    // Plain ASCII: the Windows console mangles typographic characters.
    console.log(`PicJot receiver is running on ${os.hostname()} (${localAddresses().join(', ') || 'no network'}), port ${port}.`);
    console.log(`Backups go to ${path.resolve(to)}.`);
    console.log(
      `To pair a phone, open ${pageUrl}${args.browser ? ' (opening it now)' : ''}. ` +
        'Keep this window open while the phone backs up; close it to stop.'
    );
    if (args.browser && process.platform === 'win32') {
      require('child_process').spawn('cmd', ['/c', 'start', '', pageUrl], { detached: true, stdio: 'ignore' }).unref();
    }
  })().catch((e) => {
    console.error(`Receiver failed: ${e.message}`);
    process.exitCode = 1;
  });
}

module.exports = { createReceiver, isPrivateAddress, safeRel, isPhotoRel, parseArgs };
