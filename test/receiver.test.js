'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const { createReceiver, isPrivateAddress, safeRel, isPhotoRel, backupText, parseArgs } = require('../receiver');
const { spkiSha256 } = require('../lib/cert');

const quiet = () => {};
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'picjot-recv-'));
}

// A GET on the local pages: { status, text }. `host` overrides the Host header.
function getPage(url, host) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    http
      .get({ host: u.hostname, port: u.port, path: u.pathname, headers: host ? { host } : {} }, (res) => {
        let text = '';
        res.on('data', (d) => (text += d));
        res.on('end', () => resolve({ status: res.statusCode, text }));
      })
      .on('error', reject);
  });
}

// The phone's side of a request: HTTPS, the receiver's key pinned, JSON or
// raw bytes. Resolves { status, body }.
function call(port, pin, method, urlPath, { token, json, bytes, contentLength, headers: extra } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { ...extra };
    if (token) headers.authorization = `Bearer ${token}`;
    let payload = null;
    if (json !== undefined) {
      payload = Buffer.from(JSON.stringify(json));
      headers['content-type'] = 'application/json';
    } else if (bytes) payload = bytes;
    if (payload) headers['content-length'] = contentLength ?? payload.length;
    const req = https.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: urlPath,
        headers,
        agent: false,
        rejectUnauthorized: false,
        checkServerIdentity: () => undefined,
      },
      (res) => {
        if (spkiSha256(res.socket.getPeerX509Certificate().publicKey) !== pin) {
          res.destroy();
          reject(new Error('pin mismatch'));
          return;
        }
        let text = '';
        res.on('data', (d) => (text += d));
        res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
      }
    );
    req.on('error', reject);
    if (payload) req.end(payload);
    else req.end();
  });
}

async function setup() {
  const configDir = tmp();
  const to = tmp();
  const receiver = createReceiver({ configDir, to, port: 0, host: '127.0.0.1', pcName: 'TEST-PC', log: quiet, addresses: () => ['192.168.1.20'] });
  const { port, pageUrl } = await receiver.start();
  const pin = receiver.spkiSha256;
  const api = (method, p, opts) => call(port, pin, method, p, opts);
  return { configDir, to, receiver, port, pin, pageUrl, api };
}

async function pairPhone(api, receiver) {
  const r = await api('POST', '/v1/pair', { json: { code: receiver.currentPairing().code, phoneName: 'Galaxy' } });
  assert.strictEqual(r.status, 200);
  return `${r.body.phoneId}.${r.body.token}`;
}

test('address and path checks', () => {
  for (const a of ['127.0.0.1', '::1', '10.0.0.5', '172.16.0.1', '172.31.255.1', '192.168.1.20', '::ffff:192.168.1.20', '169.254.3.4', 'fe80::1', 'fd00::2']) {
    assert.ok(isPrivateAddress(a), a);
  }
  for (const a of ['8.8.8.8', '172.32.0.1', '::ffff:1.2.3.4', '2001:db8::1', '', undefined]) assert.ok(!isPrivateAddress(a), String(a));
  assert.ok(safeRel('DCIM/Camera/a.jpg'));
  for (const r of ['', '/DCIM/a.jpg', 'DCIM/../x.jpg', 'DCIM/./a.jpg', 'DCIM//a.jpg', 'C:/a.jpg', 'DCIM\\a.jpg', 'a\0b']) {
    assert.ok(!safeRel(r), JSON.stringify(r));
  }
  assert.ok(isPhotoRel('Pictures/Screenshots/s.png'));
  assert.ok(!isPhotoRel('Documents/a.jpg'), 'outside DCIM / Pictures / Download');
  assert.ok(!isPhotoRel('DCIM/notes.txt'), 'not a photo');
});

test('pairing: one-time code, then a token; the QR text carries the pin', async () => {
  const { receiver, api, pageUrl, configDir } = await setup();
  try {
    const hello = await api('GET', '/v1/hello');
    assert.strictEqual(hello.body.pcName, 'TEST-PC');

    const payload = receiver.pairingPayload();
    assert.match(payload, /^picjot-pair:\?/);
    const q = new URLSearchParams(payload.split('?')[1]);
    assert.strictEqual(q.get('f'), receiver.spkiSha256);
    assert.strictEqual(q.get('h'), '192.168.1.20');
    const code = q.get('c');

    assert.strictEqual((await api('POST', '/v1/pair', { json: { code: 'nope' } })).status, 403);
    const ok = await api('POST', '/v1/pair', { json: { code, phoneName: 'Galaxy' } });
    assert.strictEqual(ok.status, 200);
    assert.ok(ok.body.token && ok.body.phoneId);
    assert.strictEqual((await api('POST', '/v1/pair', { json: { code } })).status, 403, 'a code works once');

    // Only the token's hash is stored.
    const saved = fs.readFileSync(path.join(configDir, 'receiver.json'), 'utf8');
    assert.ok(!saved.includes(ok.body.token));

    // Unpaired or wrong tokens are refused.
    assert.strictEqual((await api('POST', '/v1/inventory', { json: { files: [] } })).status, 401);
    assert.strictEqual((await api('POST', '/v1/inventory', { token: `${ok.body.phoneId}.wrong`, json: { files: [] } })).status, 401);

    // The pairing page (this PC only) draws the QR code; the status page
    // lists the paired phone.
    const pairPage = await getPage(`${pageUrl}pair`);
    assert.match(pairPage.text, /<svg/);
    const statusPage = await getPage(pageUrl);
    assert.strictEqual(statusPage.status, 200);
    assert.match(statusPage.text, /Galaxy/);
    assert.match(statusPage.text, /Pair a Phone/);
    assert.match(statusPage.text, /<title>PicJot WiFi Backup Manager<\/title>/);
  } finally {
    await receiver.stop();
  }
});

// A form POST to the local pages: { status, location }.
function postForm(url, fields, headers = {}) {
  const u = new URL(url);
  const body = new URLSearchParams(fields).toString();
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body), ...headers } },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location }));
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

test('the same phone pairing again replaces its earlier pairing; another phone doesn\'t', async () => {
  const { receiver, api, configDir } = await setup();
  try {
    const pairAs = async (json) => {
      const r = await api('POST', '/v1/pair', { json: { code: receiver.currentPairing().code, ...json } });
      assert.strictEqual(r.status, 200);
      return `${r.body.phoneId}.${r.body.token}`;
    };
    const inv = (token, headers) => api('POST', '/v1/inventory', { token, json: { files: [] }, headers });
    const keyA = 'A'.repeat(43);
    const keyB = 'B'.repeat(43);

    const first = await pairAs({ phoneName: 'Galaxy', deviceKey: keyA });
    const second = await pairAs({ phoneName: 'Galaxy', deviceKey: keyA });
    assert.strictEqual(receiver.status().phoneCount, 1, 'replaced, not added');
    assert.strictEqual((await inv(first)).status, 401, 'the earlier token stops working');
    assert.strictEqual((await inv(second)).status, 200);
    assert.ok(receiver.status().recent.some((r) => /Paired with Galaxy again/.test(r.text)));

    // The same model, a different phone: both stay.
    await pairAs({ phoneName: 'Galaxy', deviceKey: keyB });
    assert.strictEqual(receiver.status().phoneCount, 2);

    // A pairing from before phones sent a key gets one from its next request,
    // and is replaced when that phone pairs again.
    const legacy = await pairAs({ phoneName: 'Pixel' });
    assert.strictEqual(receiver.status().phoneCount, 3);
    assert.strictEqual((await inv(legacy, { 'x-picjot-device': 'C'.repeat(43) })).status, 200);
    await pairAs({ phoneName: 'Pixel', deviceKey: 'C'.repeat(43) });
    assert.strictEqual(receiver.status().phoneCount, 3);
    assert.strictEqual((await inv(legacy)).status, 401);

    // Malformed keys are ignored (the phone is simply added).
    await pairAs({ phoneName: 'Odd', deviceKey: 'short' });
    assert.strictEqual(receiver.status().phoneCount, 4);
    const saved = JSON.parse(fs.readFileSync(path.join(configDir, 'receiver.json'), 'utf8'));
    assert.strictEqual(Object.values(saved.phones).filter((p) => p.deviceKey === keyA).length, 1);
  } finally {
    await receiver.stop();
  }
});

test('Forget on the status page unpairs a phone; other pages can\'t do it', async () => {
  const { receiver, api, pageUrl } = await setup();
  try {
    const token = await pairPhone(api, receiver);
    const phoneId = token.split('.')[0];
    const page = (await getPage(pageUrl)).text;
    const formToken = /name="t" value="([^"]+)"/.exec(page)[1];
    assert.match(page, new RegExp(`name="phone" value="${phoneId}"`));
    const port = new URL(pageUrl).port;

    assert.strictEqual((await postForm(`${pageUrl}forget`, { phone: phoneId, t: 'guess' })).status, 403, 'wrong token');
    assert.strictEqual(
      (await postForm(`${pageUrl}forget`, { phone: phoneId, t: formToken }, { origin: 'https://evil.example' })).status,
      403,
      'another site'
    );
    assert.strictEqual((await api('POST', '/v1/inventory', { token, json: { files: [] } })).status, 200, 'still paired');

    const ok = await postForm(`${pageUrl}forget`, { phone: phoneId, t: formToken }, { origin: `http://127.0.0.1:${port}` });
    assert.strictEqual(ok.status, 303);
    assert.strictEqual(ok.location, '/');
    assert.strictEqual(receiver.status().phoneCount, 0);
    assert.strictEqual((await api('POST', '/v1/inventory', { token, json: { files: [] } })).status, 401, 'its token no longer works');
  } finally {
    await receiver.stop();
  }
});

test('the local pages refuse requests addressed to another name (DNS rebinding)', async () => {
  const { receiver, pageUrl } = await setup();
  try {
    const port = new URL(pageUrl).port;
    assert.strictEqual((await getPage(`${pageUrl}pair`, `evil.example:${port}`)).status, 403);
    assert.strictEqual((await getPage(`${pageUrl}api/status`, `evil.example:${port}`)).status, 403);
    assert.strictEqual((await getPage(`${pageUrl}api/status`, `localhost:${port}`)).status, 200);
  } finally {
    await receiver.stop();
  }
});

test('a pairing code expires after 10 minutes', async () => {
  let t = Date.parse('2026-10-17T12:00:00Z');
  const receiver = createReceiver({ configDir: tmp(), to: tmp(), port: 0, host: '127.0.0.1', log: quiet, now: () => new Date(t) });
  const { port } = await receiver.start();
  try {
    const code = receiver.currentPairing().code;
    t += 10 * 60 * 1000 + 1;
    const r = await call(port, receiver.spkiSha256, 'POST', '/v1/pair', { json: { code } });
    assert.strictEqual(r.status, 403);
  } finally {
    await receiver.stop();
  }
});

test('a backup over Wi-Fi: list, send, finish; files filed, tags beside, receipt returned; then resumable and incremental', async () => {
  const { to, receiver, api } = await setup();
  try {
    const token = await pairPhone(api, receiver);
    const photo1 = Buffer.from('jpeg bytes one');
    const photo2 = Buffer.from('png bytes two!');
    const rel1 = 'DCIM/Camera/20260720_154654.jpg';
    const rel2 = 'Pictures/Screenshots/shot.png';
    const files = [
      { rel: rel1, size: photo1.length, modified: '2026-07-20T15:46:54.000Z' },
      { rel: rel2, size: photo2.length, modified: '2025-03-04T10:00:00.000Z' },
      { rel: '../evil.jpg', size: 3 },
      { rel: 'Documents/a.jpg', size: 3 },
    ];

    let inv = await api('POST', '/v1/inventory', { token, json: { phone: 'Galaxy S', files } });
    assert.strictEqual(inv.status, 200);
    assert.deepStrictEqual(inv.body.need.sort(), [rel1, rel2].sort(), 'only valid photo paths');
    assert.ok(receiver.status().busy, 'backing up (the tray keeps the PC awake)');
    assert.strictEqual(receiver.status().phone, 'Galaxy S');
    // Paired as "Galaxy": the status page now lists the name the phone gives.
    assert.deepStrictEqual(receiver.status().phones.map((p) => p.name), ['Galaxy S']);
    assert.strictEqual(inv.body.folder, path.resolve(to), 'the backup folder, for the phone');

    const put = (rel, bytes, extra) => api('PUT', `/v1/file?rel=${encodeURIComponent(rel)}`, { token, bytes, ...extra });
    assert.strictEqual((await put('DCIM/Camera/other.jpg', photo1)).status, 409, 'not listed');
    assert.strictEqual((await put(rel1, photo1, { contentLength: photo1.length + 1 })).status, 400, 'wrong size');
    assert.strictEqual((await put(rel1, photo1)).status, 200);

    // Interrupted here: a new list only asks for what's still missing.
    inv = await api('POST', '/v1/inventory', { token, json: { phone: 'Galaxy S', files } });
    assert.deepStrictEqual(inv.body.need, [rel2]);
    assert.strictEqual((await put(rel2, photo2)).status, 200);

    const tagRecord = {
      version: 2,
      hashAlgorithm: 'md5',
      contentHash: md5(photo1),
      caption: 'Lunch',
      creationTime: Date.parse('2026-07-20T15:46:54Z'),
    };
    const fin = await api('POST', '/v1/finish', {
      token,
      json: { tagFolder: 'DCIM/photoAppMetadada', tagFiles: [{ name: `${md5(photo1)}.json`, text: JSON.stringify(tagRecord) }] },
    });
    assert.strictEqual(fin.status, 200, JSON.stringify(fin.body));
    assert.strictEqual(fin.body.summary.copied, 2);
    assert.deepStrictEqual(fin.body.errors, []);
    assert.ok(fs.existsSync(path.join(to, '2026', '07', '20260720_154654.jpg')));
    assert.ok(fs.existsSync(path.join(to, '2026', '07', '20260720_154654.jpg.json')), 'tag file beside the photo');
    assert.ok(fs.existsSync(path.join(to, '2025', '03', 'shot.png')), 'dated by the phone\'s modified time');
    const receipt = JSON.parse(fin.body.receipt.text);
    assert.strictEqual(receipt.type, 'photoapp-backup-receipt');
    assert.strictEqual(receipt.phone, 'Galaxy S');
    assert.deepStrictEqual(receipt.photos.map((p) => p.from).sort(), [rel1, rel2].sort());
    assert.ok(receipt.photos.some((p) => p.hash === md5(photo1)));
    assert.match(fin.body.receipt.name, /^backup-receipt-/);
    assert.ok(fin.body.tagSync && JSON.parse(fin.body.tagSync.text).type === 'photoapp-tag-sync');
    const s = receiver.status();
    assert.ok(!s.busy, 'done');
    assert.strictEqual(s.lastBackup.phone, 'Galaxy S');
    assert.strictEqual(s.lastBackup.text, '2 new photos backed up.');
    assert.ok(s.recent.some((r) => /Backup from Galaxy S finished/.test(r.text)));

    // Next time: nothing new to send, and the newest receipt still comes back.
    inv = await api('POST', '/v1/inventory', { token, json: { files } });
    assert.deepStrictEqual(inv.body.need, []);
    assert.strictEqual(inv.body.already, 2);
    const again = await api('POST', '/v1/finish', { token, json: {} });
    assert.strictEqual(again.body.summary.copied, 0);
    assert.strictEqual(again.body.receipt.name, fin.body.receipt.name);

    // A photo missing on the PC is asked for again.
    fs.rmSync(path.join(to, '2025', '03', 'shot.png'));
    inv = await api('POST', '/v1/inventory', { token, json: { files } });
    assert.deepStrictEqual(inv.body.need, [rel2]);

    // Finishing needs a list first.
    await api('POST', '/v1/finish', { token, json: {} });
    assert.strictEqual((await api('POST', '/v1/finish', { token, json: {} })).status, 409);
  } finally {
    await receiver.stop();
  }
});

test('without its backup drive it keeps running, tells the phone, and carries on once the drive is back', async () => {
  // A drive letter that isn't there stands in for an unplugged drive.
  const letters = 'QRSTUVWXYZ'.split('').filter((l) => !fs.existsSync(`${l}:\\`));
  const missing = process.platform === 'win32' ? `${letters[0]}:\\Photos` : '/nonexistent-drive/Photos';
  const present = tmp();
  let to = missing;
  const receiver = createReceiver({ configDir: tmp(), to: () => to, port: 0, host: '127.0.0.1', log: quiet });
  const { port } = await receiver.start();
  const api = (method, p, opts) => call(port, receiver.spkiSha256, method, p, opts);
  try {
    const hello = await api('GET', '/v1/hello');
    assert.strictEqual(hello.body.ready, false);
    assert.match(hello.body.problem, /isn't available: is the backup drive connected/);
    const token = await pairPhone(api, receiver);
    const inv = await api('POST', '/v1/inventory', { token, json: { files: [] } });
    assert.strictEqual(inv.status, 503);
    assert.match(inv.body.error, /backup drive/);
    assert.ok(receiver.status().problem);

    to = present; // plugged back in (or another folder chosen): no restart needed
    assert.strictEqual((await api('GET', '/v1/hello')).body.ready, true);
    assert.strictEqual((await api('POST', '/v1/inventory', { token, json: { files: [] } })).status, 200);
    assert.ok(fs.existsSync(path.join(present, '.photoapp', 'wifi-session.json')), 'the session lives in the new folder');
  } finally {
    await receiver.stop();
  }
});

test('hello lists the PC\'s addresses, so the phone keeps them current', async () => {
  const { receiver, api } = await setup();
  try {
    const hello = await api('GET', '/v1/hello');
    assert.deepStrictEqual(hello.body.hosts, ['192.168.1.20']);
    assert.strictEqual(hello.body.ready, true);
    assert.strictEqual(hello.body.problem, null);
  } finally {
    await receiver.stop();
  }
});

test('a finished backup in words, and the command line', () => {
  assert.strictEqual(backupText({ copied: 1, already: 700, present: 2 }), '1 new photo backed up, 702 already on the PC.');
  assert.strictEqual(backupText({ copied: 0, errors: 2 }), "0 new photos backed up. 2 problems (see 'Recent Activity').");
  const bg = parseArgs(['--background', '--page-port', '0']);
  assert.ok(bg.background && !bg.browser);
  assert.strictEqual(bg.pagePort, 0);
  assert.throws(() => parseArgs(['--nope']), /Unknown argument/);
});

test('keeps its certificate and paired phones across restarts', async () => {
  const configDir = tmp();
  const to = tmp();
  const first = createReceiver({ configDir, to, port: 0, host: '127.0.0.1', log: quiet });
  const { port } = await first.start();
  const r = await call(port, first.spkiSha256, 'POST', '/v1/pair', { json: { code: first.currentPairing().code } });
  await first.stop();

  const second = createReceiver({ configDir, to, port: 0, host: '127.0.0.1', log: quiet });
  assert.strictEqual(second.spkiSha256, first.spkiSha256);
  const { port: port2 } = await second.start();
  try {
    const inv = await call(port2, second.spkiSha256, 'POST', '/v1/inventory', { token: `${r.body.phoneId}.${r.body.token}`, json: { files: [] } });
    assert.strictEqual(inv.status, 200);
  } finally {
    await second.stop();
  }
});
