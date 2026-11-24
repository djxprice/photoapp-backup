'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const { createReceiver, isPrivateAddress, safeRel, isPhotoRel, backupText, importText, parseArgs } = require('../receiver');
const { spkiSha256 } = require('../lib/cert');
const { jpeg, jpegWithDate } = require('./jpegs');

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
      .get({ host: u.hostname, port: u.port, path: u.pathname + u.search, headers: host ? { host } : {} }, (res) => {
        let text = '';
        res.on('data', (d) => (text += d));
        res.on('end', () => resolve({ status: res.statusCode, text }));
      })
      .on('error', reject);
  });
}

// The phone's side of a request: HTTPS, the receiver's key pinned, JSON or
// raw bytes. Resolves { status, body }, or with `raw` { status, headers, buf }.
function call(port, pin, method, urlPath, { token, json, bytes, contentLength, headers: extra, raw } = {}) {
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
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (raw) resolve({ status: res.statusCode, headers: res.headers, buf });
          else resolve({ status: res.statusCode, body: buf.length ? JSON.parse(buf.toString('utf8')) : null });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.end(payload);
    else req.end();
  });
}

async function setup(extra = {}) {
  const configDir = tmp();
  const to = tmp();
  const receiver = createReceiver({ configDir, to, port: 0, host: '127.0.0.1', pcName: 'TEST-PC', log: quiet, addresses: () => ['192.168.1.20'], ...extra });
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
    assert.match(statusPage.text, /<title>PicJot<\/title>/);
  } finally {
    await receiver.stop();
  }
});

test("without a network: the pairing page says so instead of a code with no address, and the status page isn't Ready", async () => {
  let addrs = [];
  const { receiver, pageUrl } = await setup({ addresses: () => addrs });
  try {
    const off = await getPage(`${pageUrl}pair`);
    assert.doesNotMatch(off.text, /<svg/);
    assert.match(off.text, /This PC isn't connected to a network/);
    assert.match(off.text, /content="5"/);
    const status = await getPage(pageUrl);
    assert.match(status.text, /isn't connected to a network, so phones can't reach it/);
    assert.doesNotMatch(status.text, /● Ready/);

    // Back on the network: the code, and Ready.
    addrs = ['192.168.1.9'];
    const on = await getPage(`${pageUrl}pair`);
    assert.match(on.text, /<svg/);
    assert.match(on.text, /content="60"/);
    assert.match((await getPage(pageUrl)).text, /● Ready/);
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

// A JSON POST to the local pages: { status, body }.
function postJson(url, json, headers = {}) {
  const u = new URL(url);
  const body = JSON.stringify(json);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers } },
      (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') }));
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

test("the timeline page's own Do Not Show list: kept in the settings, changed only from that page", async () => {
  const { receiver, pageUrl, configDir } = await setup();
  try {
    const page = (await getPage(`${pageUrl}timeline`)).text;
    const token = JSON.parse(/const TOKEN = ("[^"]*");/.exec(page)[1]);
    const port = new URL(pageUrl).port;
    const url = `${pageUrl}timeline/hide`;

    assert.strictEqual((await postJson(url, { t: 'guess', hide: ['work'] })).status, 403, 'wrong token');
    assert.strictEqual((await postJson(url, { t: token, hide: ['work'] }, { origin: 'https://evil.example' })).status, 403, 'another site');
    assert.strictEqual((await postJson(url, { t: token, hide: 'work' })).status, 403, 'not a list');

    const ok = await postJson(url, { t: token, hide: ['#Work', 'work', ' private '] }, { origin: `http://127.0.0.1:${port}` });
    assert.strictEqual(ok.status, 200);
    assert.deepStrictEqual(ok.body.hide, ['Work', 'private']);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(configDir, 'receiver.json'), 'utf8')).timelineHide, ['Work', 'private']);
    const data = JSON.parse((await getPage(`${pageUrl}timeline/data`)).text);
    assert.deepStrictEqual(data.hide.terms, ['Work', 'private']);
  } finally {
    await receiver.stop();
  }
});

// Bytes POSTed to a local page (its query kept): { status, body }.
function postBytes(url, buf, headers = {}) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST', headers: { 'content-type': 'image/jpeg', 'content-length': buf.length, ...headers } },
      (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') }));
      }
    );
    req.on('error', reject);
    req.end(buf);
  });
}

test('exporting the timeline: PicJot saves the folder in Documents › PicJot Timelines; only JPEGs without EXIF, only from the page', async () => {
  const exportsDir = tmp();
  const opened = [];
  const { to, receiver, pageUrl } = await setup({
    exportsRoot: () => ({ dir: exportsDir, label: 'Documents\\PicJot Timelines' }),
    openFolder: (dir) => opened.push(dir),
    now: () => new Date(2026, 10, 22, 15, 0),
  });
  try {
    const h = 'a'.repeat(32);
    const put = (rel, value) => {
      const p = path.join(to, ...rel.split('/'));
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value));
    };
    put('.photoapp/index.json', { version: 1, photos: { [h]: { path: '2016/07/a.jpg', size: 1, tagged: true } } });
    put('2016/07/a.jpg', 'picture');
    put('PicJot Tags/2016/07/a.jpg.json', { version: 2, hashAlgorithm: 'md5', contentHash: h, significance: 'timeline', caption: 'Canoe', tags: [], note: '', creationTime: '2016-07-03T18:00:00.000Z' });
    const page = (await getPage(`${pageUrl}timeline`)).text;
    const token = JSON.parse(/const TOKEN = ("[^"]*");/.exec(page)[1]);
    const port = new URL(pageUrl).port;
    const start = (body, headers) => postJson(`${pageUrl}timeline/export/start`, body, headers);

    assert.strictEqual((await start({ t: 'guess', title: 'Trip' })).status, 403, 'wrong token');
    assert.strictEqual((await start({ t: token, title: 'Trip' }, { origin: 'https://evil.example' })).status, 403, 'another site');
    const ex = await start({ t: token, title: 'Trip', group: 'month' }, { origin: `http://127.0.0.1:${port}` });
    assert.strictEqual(ex.status, 200);
    assert.strictEqual(ex.body.name, 'Trip 2026-11-22');
    assert.strictEqual(ex.body.where, 'Documents\\PicJot Timelines\\Trip 2026-11-22');
    assert.deepStrictEqual(ex.body.photos, [{ hash: h }]);
    // What the dialog shows as the dates change (read-only, no token).
    const count = async (q) => JSON.parse((await getPage(`${pageUrl}timeline/export/count?${q}`)).text);
    assert.deepStrictEqual(await count('group=month&from=2017-01-01'), { photos: 0, moments: 0 });
    assert.deepStrictEqual(await count('to=2016-12-31'), { photos: 1, moments: 0 });
    const dated = await start({ t: token, title: 'Later', dateFrom: '2017-01-01' });
    assert.deepStrictEqual(dated.body.photos, [], 'the dates limit the export too');
    const dir = path.join(exportsDir, 'Trip 2026-11-22');
    assert.match(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), /<title>Trip<\/title>/);

    // The pictures the page made.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9]);
    const picture = (q, buf, headers = { 'x-picjot-token': token }) => postBytes(`${pageUrl}timeline/export/photo?${new URLSearchParams(q)}`, buf, headers);
    assert.strictEqual((await picture({ id: ex.body.id, hash: h, size: 'full' }, jpeg, { 'x-picjot-token': 'guess' })).status, 403);
    assert.strictEqual((await picture({ id: 'nope', hash: h, size: 'full' }, jpeg)).status, 404, 'no such export');
    assert.strictEqual((await picture({ id: ex.body.id, hash: 'b'.repeat(32), size: 'full' }, jpeg)).status, 404, 'not in it');
    assert.strictEqual((await picture({ id: ex.body.id, hash: h, size: 'huge' }, jpeg)).status, 400);
    assert.strictEqual((await picture({ id: ex.body.id, hash: h, size: 'full' }, Buffer.from('<html>'))).status, 415, 'not a JPEG');
    const withExif = Buffer.concat([jpeg.subarray(0, 2), Buffer.from([0xff, 0xe1, 0, 8]), Buffer.from('Exif\0\0', 'latin1'), jpeg.subarray(2)]);
    assert.strictEqual((await picture({ id: ex.body.id, hash: h, size: 'full' }, withExif)).status, 415, 'EXIF (location) never gets in');
    assert.strictEqual((await picture({ id: ex.body.id, hash: h, size: 'full' }, jpeg)).status, 200);
    assert.strictEqual((await picture({ id: ex.body.id, hash: h, size: 'thumb' }, jpeg)).status, 200);
    assert.ok(fs.readFileSync(path.join(dir, 'photos', `${h}.jpg`)).equals(jpeg));
    assert.ok(fs.existsSync(path.join(dir, 'thumbs', `${h}.jpg`)));

    assert.strictEqual((await postJson(`${pageUrl}timeline/export/done`, { t: token, id: ex.body.id, failed: 0 })).status, 200);
    assert.strictEqual((await postJson(`${pageUrl}timeline/export/open`, { t: 'guess', id: ex.body.id })).status, 403);
    assert.strictEqual((await postJson(`${pageUrl}timeline/export/open`, { t: token, id: ex.body.id })).status, 200);
    assert.deepStrictEqual(opened, [dir]);

    // The same title again: a second folder, nothing overwritten.
    const again = await start({ t: token, title: 'Trip' });
    assert.strictEqual(again.body.name, 'Trip 2026-11-22 (2)');
    assert.ok(fs.existsSync(path.join(dir, 'photos', `${h}.jpg`)));
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

test('a backup over Wi-Fi: list, send, finish; files filed, tags in the tag folder, receipt returned; then resumable and incremental', async () => {
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
    // The phone's skipped list (2026-11-23) goes with the tag files.
    const skipList = { type: 'photoapp-skipped', version: 1, photos: [{ contentHash: md5(photo2), skippedAt: '2026-11-23T10:00:00.000Z' }] };
    const fin = await api('POST', '/v1/finish', {
      token,
      json: {
        tagFolder: 'DCIM/photoAppMetadada',
        tagFiles: [
          { name: `${md5(photo1)}.json`, text: JSON.stringify(tagRecord) },
          { name: 'skipped.json', text: JSON.stringify(skipList) },
        ],
      },
    });
    assert.strictEqual(fin.status, 200, JSON.stringify(fin.body));
    const skipDir = path.join(to, '.photoapp', 'skipped');
    const keptLists = fs.readdirSync(skipDir);
    assert.strictEqual(keptLists.length, 1, "the phone's skipped list, kept apart from the tag files");
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(skipDir, keptLists[0]), 'utf8')).photos, skipList.photos);
    assert.ok(!fs.existsSync(path.join(to, 'PicJot Tags', 'skipped.json')));
    assert.strictEqual(fin.body.summary.copied, 2);
    assert.deepStrictEqual(fin.body.errors, []);
    assert.ok(fs.existsSync(path.join(to, '2026', '07', '20260720_154654.jpg')));
    assert.ok(fs.existsSync(path.join(to, 'PicJot Tags', '2026', '07', '20260720_154654.jpg.json')), 'tag file in the tag folder');
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
    assert.strictEqual(s.lastBackup.text, '2 new photos backed up. Tags on the PC updated for 1 photo.');
    assert.ok(s.recent.some((r) => /Backup from Galaxy S finished/.test(r.text)));

    // Next time: nothing new to send, and the newest receipt still comes back.
    // A caption edited on the phone still reaches the PC, and the result says
    // so (no new photos, but the tags changed).
    inv = await api('POST', '/v1/inventory', { token, json: { files } });
    assert.deepStrictEqual(inv.body.need, []);
    assert.strictEqual(inv.body.already, 2);
    const edited = { ...tagRecord, caption: 'Lunch by the lake' };
    const tagJson = (rec) => ({ tagFolder: 'DCIM/photoAppMetadada', tagFiles: [{ name: `${md5(photo1)}.json`, text: JSON.stringify(rec) }] });
    const again = await api('POST', '/v1/finish', { token, json: tagJson(edited) });
    assert.strictEqual(again.body.summary.copied, 0);
    assert.strictEqual(again.body.summary.sidecarsWritten, 1);
    assert.strictEqual(again.body.receipt.name, fin.body.receipt.name);
    assert.strictEqual(
      receiver.status().lastBackup.text,
      '0 new photos backed up, 2 already on the PC. Tags on the PC updated for 1 photo.'
    );
    assert.match(fs.readFileSync(path.join(to, 'PicJot Tags', '2026', '07', '20260720_154654.jpg.json'), 'utf8'), /Lunch by the lake/);
    // The same tags again: nothing to do, and it says that too.
    await api('POST', '/v1/inventory', { token, json: { files } });
    await api('POST', '/v1/finish', { token, json: tagJson(edited) });
    assert.strictEqual(
      receiver.status().lastBackup.text,
      '0 new photos backed up, 2 already on the PC. Tags on the PC already up to date.'
    );

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

test('old photos (Step 26b): which ones, in batches, the picture, reviewed', async () => {
  const { to, receiver, api } = await setup();
  try {
    const token = await pairPhone(api, receiver);
    const put = (rel, buf) => {
      const p = path.join(to, ...rel.split('/'));
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, buf);
      return buf;
    };
    const a = put('2009/07/a.jpg', jpegWithDate('2009:07:14 15:22:10'));
    const b = put('2026/10/b.jpg', Buffer.from('still on the phone'));
    const preview = jpeg({ size: 30 * 1024 });
    const c = put('2015/01/c.NEF', Buffer.concat([Buffer.from('MM\0*'), jpeg({ size: 500 }), preview, jpeg({ sof: 0xc3, size: 90000 })]));
    const d = put('2012/05/d.jpg', Buffer.from('tagged on the PC'));
    put('PicJot Tags/2012/05/d.jpg.json', JSON.stringify({ contentHash: md5(d), hashAlgorithm: 'md5', caption: 'x' }));
    // Tagged before tag files moved into the tag folder (no backup since).
    const d2 = put('2012/05/d2.jpg', Buffer.from('tagged on the PC, beside'));
    put('2012/05/d2.jpg.json', JSON.stringify({ contentHash: md5(d2), hashAlgorithm: 'md5', caption: 'y' }));
    const e = put('2011/03/e.jpg', Buffer.from('from a Google Takeout'));
    put('2011/03/e.jpg.json', JSON.stringify({ title: 'e.jpg', photoTakenTime: { timestamp: '1300000000' } }));
    const f = put('2010/06/f.heic', Buffer.from('heic bytes'));
    // Skipped on a phone (its skipped list), then freed from it: not offered.
    const g = put('2016/04/g.jpg', Buffer.from('skipped on a phone'));
    put('.photoapp/skipped/a-phone.json', JSON.stringify({ type: 'photoapp-skipped', version: 1, photos: [{ contentHash: md5(g) }] }));
    const index = { version: 1, photos: {} };
    for (const [rel, buf, from, description] of [
      ['2009/07/a.jpg', a, 'old camera/a.jpg'],
      ['2026/10/b.jpg', b, 'DCIM/Camera/b.jpg'],
      ['2015/01/c.NEF', c],
      ['2012/05/d.jpg', d],
      ['2012/05/d2.jpg', d2],
      ['2011/03/e.jpg', e, null, 'Snow day'],
      ['2010/06/f.heic', f],
      ['2016/04/g.jpg', g, 'DCIM/Camera/g.jpg'],
    ]) {
      index.photos[md5(buf)] = { path: rel, size: buf.length, ...(from ? { from } : {}), ...(description ? { description } : {}) };
    }
    index.photos[md5(e)].takeoutTime = '2011-03-13T07:06:40.000Z'; // Google's time taken, in UTC
    put('.photoapp/index.json', JSON.stringify(index));

    // Not before this phone's first Wi-Fi backup: the PC doesn't know what's on it.
    const early = await api('GET', '/v1/old', { token });
    assert.strictEqual(early.status, 409);
    assert.match(early.body.error, /Back up over Wi-Fi once first/);
    // A picture, though, goes to any paired phone (a new phone's restored
    // notes show theirs on its timeline before its first backup).
    assert.strictEqual((await api('GET', `/v1/old/file?hash=${md5(a)}`, { token, raw: true })).status, 200);

    const inv = await api('POST', '/v1/inventory', { token, json: { files: [{ rel: 'DCIM/Camera/b.jpg', size: b.length }] } });
    assert.strictEqual(inv.status, 200);

    // b is on the phone, d and d2 are tagged, g was skipped; e's Takeout .json isn't a tag file.
    const overview = await api('GET', '/v1/old', { token });
    assert.deepStrictEqual(overview.body, {
      total: 4,
      years: [2015, 2011, 2010, 2009].map((year) => ({ year, count: 1 })),
      reviewed: 0,
    });

    const batch = await api('POST', '/v1/old/batch', { token, json: { count: 2 } });
    assert.deepStrictEqual(batch.body.photos.map((p) => p.path), ['2015/01/c.NEF', '2011/03/e.jpg']);
    assert.strictEqual(batch.body.photos[0].kind, 'raw');
    assert.strictEqual(batch.body.photos[1].caption, 'Snow day', 'the Takeout description, to start from');
    assert.ok(!('caption' in batch.body.photos[0]));
    assert.strictEqual(batch.body.photos[0].taken, null, 'a RAW file without an EXIF date: only its month');
    const t = new Date('2011-03-13T07:06:40.000Z');
    const two = (n) => String(n).padStart(2, '0');
    assert.strictEqual(
      batch.body.photos[1].taken,
      `${t.getFullYear()}-${two(t.getMonth() + 1)}-${two(t.getDate())}T${two(t.getHours())}:${two(t.getMinutes())}:${two(t.getSeconds())}`,
      "no EXIF date: Google's, in the PC's time"
    );
    assert.strictEqual(batch.body.remaining, 4);
    const oldest = await api('POST', '/v1/old/batch', { token, json: { count: 1, order: 'oldest' } });
    assert.deepStrictEqual(oldest.body.photos, [
      { hash: md5(a), name: 'a.jpg', path: '2009/07/a.jpg', year: 2009, month: 7, taken: '2009-07-14T15:22:10', size: a.length, kind: 'jpeg' },
    ]);
    const y2010 = await api('POST', '/v1/old/batch', { token, json: { year: 2010 } });
    assert.deepStrictEqual(y2010.body.photos.map((p) => p.kind), ['heic']);

    // The pictures: a JPEG as it is, the JPEG inside a RAW file.
    const fileOf = (hash) => api('GET', `/v1/old/file?hash=${hash}`, { token, raw: true });
    const pa = await fileOf(md5(a));
    assert.strictEqual(pa.status, 200);
    assert.ok(pa.buf.equals(a));
    assert.strictEqual(pa.headers['content-type'], 'image/jpeg');
    const pc = await fileOf(md5(c));
    assert.strictEqual(pc.status, 200);
    assert.ok(pc.buf.equals(preview));
    assert.strictEqual(pc.headers['x-picjot-kind'], 'raw');
    assert.strictEqual((await fileOf('0'.repeat(32))).status, 404);
    assert.strictEqual((await api('GET', '/v1/old/file?hash=zz', { token, raw: true })).status, 404);

    // Reviewed (or skipped) ones aren't offered again.
    const done = await api('POST', '/v1/old/done', {
      token,
      json: { photos: [{ hash: md5(c), skipped: true }, { hash: md5(a) }, { hash: 'not-a-photo' }] },
    });
    assert.deepStrictEqual(done.body, { ok: true, added: 2, remaining: 2 });
    const saved = JSON.parse(fs.readFileSync(path.join(to, '.photoapp', 'old-photos.json'), 'utf8'));
    assert.strictEqual(saved.done[md5(c)].skipped, true);
    assert.strictEqual(saved.done[md5(a)].skipped, false);
    const after = await api('GET', '/v1/old', { token });
    assert.strictEqual(after.body.total, 2);
    assert.strictEqual(after.body.reviewed, 2);

    // Unpaired phones get nothing.
    assert.strictEqual((await api('GET', '/v1/old')).status, 401);
  } finally {
    await receiver.stop();
  }
});

test("notes for restoring on a new phone: every photo's and Moment's (waiting ones too), newest copy, none cleared; no backup needed first", async () => {
  const { to, receiver, api } = await setup();
  try {
    const token = await pairPhone(api, receiver);
    const put = (rel, value) => {
      const p = path.join(to, ...rel.split('/'));
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value));
    };
    const h = (c) => c.repeat(32);
    put('PicJot Tags/2026/07/a.jpg.json', { version: 2, hashAlgorithm: 'md5', contentHash: h('a'), caption: 'Lake', photoFile: 'a.jpg', updatedAt: '2026-07-02T00:00:00Z' });
    // A RAW+JPEG pair's older copy of the same photo's notes: the newer one wins.
    put('PicJot Tags/2026/07/a.dng.json', { version: 2, hashAlgorithm: 'md5', contentHash: h('a'), caption: 'Old', updatedAt: '2026-07-01T00:00:00Z' });
    put('PicJot Tags/2015/08/Moment - Moved (bbbbbb).json', { version: 2, kind: 'moment', id: h('b'), title: 'Moved', date: '2015-08-01' });
    put('PicJot Tags/2015/09/Moment - Gone (cccccc).json', { version: 2, kind: 'moment', id: h('c'), cleared: true });
    put('PicJot Tags/2011/03/takeout.json', { title: 'e.jpg', photoTakenTime: { timestamp: '1300000000' } });
    put('PicJot Tags/2011/03/broken.json', '{ "contentHash": ');
    // Filed beside its photo before 2026-10-22, with no backup since.
    put('2012/05/d.jpg.json', { hashAlgorithm: 'md5', contentHash: h('d'), note: 'beside' });
    put('.photoapp/index.json', { version: 1, photos: { [h('d')]: { path: '2012/05/d.jpg', size: 5 } } });
    // Waiting for its photo, which never reached the backup.
    put(`.photoapp/orphan-sidecars/${h('e')}.json`, { hashAlgorithm: 'md5', contentHash: h('e'), caption: 'waiting' });
    // A phone's skipped list (2026-11-23): sent as it is; the app reads it as skips.
    const skipList = { type: 'photoapp-skipped', version: 1, photos: [{ contentHash: h('f') }] };
    put('.photoapp/skipped/a-phone.json', skipList);

    const r = await api('GET', '/v1/notes', { token });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.pcName, 'TEST-PC');
    assert.strictEqual(r.body.photos, 3);
    assert.strictEqual(r.body.moments, 1);
    const lists = r.body.records.filter((x) => x.type === 'photoapp-skipped');
    assert.deepStrictEqual(lists, [skipList]);
    const by = Object.fromEntries(r.body.records.filter((x) => !x.type).map((x) => [x.contentHash || x.id, x]));
    assert.deepStrictEqual(Object.keys(by).sort(), [h('a'), h('b'), h('d'), h('e')]);
    assert.strictEqual(by[h('a')].caption, 'Lake');
    assert.strictEqual(by[h('d')].note, 'beside');

    // Unpaired phones get nothing.
    assert.strictEqual((await api('GET', '/v1/notes')).status, 401);
  } finally {
    await receiver.stop();
  }
});

test("adding a folder of old photos: copied in, then offered as old photos", async () => {
  const { to, receiver, api, pageUrl } = await setup();
  try {
    const token = await pairPhone(api, receiver);
    const src = tmp();
    const photo = jpegWithDate('2008:12:24 18:00:00');
    fs.mkdirSync(path.join(src, 'Christmas 2008'), { recursive: true });
    fs.writeFileSync(path.join(src, 'Christmas 2008', 'IMG_0001.jpg'), photo);

    // Not the backup folder, nor one holding it; not a missing folder.
    await assert.rejects(receiver.importFolder(to), /other than the backup folder/);
    await assert.rejects(receiver.importFolder(path.dirname(to)), /other than the backup folder/);
    await assert.rejects(receiver.importFolder(path.join(src, 'nope')), /isn't a folder/);
    // Why it didn't happen shows on the page, not only in the log.
    assert.match((await getPage(pageUrl)).text, /Couldn(&#39;|')t add the photos: Choose a folder other than the backup folder/);

    const r = await receiver.importFolder(src);
    assert.strictEqual(r.copied, 1);
    assert.ok(fs.existsSync(path.join(to, '2008', '12', 'IMG_0001.jpg')));
    assert.ok(fs.existsSync(path.join(src, 'Christmas 2008', 'IMG_0001.jpg')), 'the original stays');
    assert.strictEqual(importText(r), '1 photo added.');
    assert.strictEqual(importText({ copied: 2, present: 3, failed: 1 }), "2 photos added, 3 already in the backup. 1 photo couldn't be copied (see 'Recent Activity').");
    assert.strictEqual(importText({ copied: 5, notCopied: 7 }), '5 photos added. 7 photos not added: the backup drive is nearly full.');
    const page = await getPage(pageUrl);
    assert.match(page.text, /Photos Added/);

    // Again: nothing new.
    assert.strictEqual((await receiver.importFolder(src)).present, 1);

    await api('POST', '/v1/inventory', { token, json: { files: [] } });
    const overview = await api('GET', '/v1/old', { token });
    assert.deepStrictEqual(overview.body.years, [{ year: 2008, count: 1 }]);
  } finally {
    await receiver.stop();
  }
});

test('adding a folder that won\'t fit: refused before anything is copied, and said so on the page', async () => {
  const { to, receiver, pageUrl } = await setup({ freeBytes: () => 50 * 1024 * 1024 });
  try {
    const src = tmp();
    fs.writeFileSync(path.join(src, 'IMG_0001.jpg'), jpegWithDate('2008:12:24 18:00:00'));
    await assert.rejects(receiver.importFolder(src), /Not enough room: the photo in .* needs about 1 MB, and the backup drive has 52 MB free/);
    assert.ok(!fs.existsSync(path.join(to, '2008')), 'nothing copied');
    assert.match((await getPage(pageUrl)).text, /Not enough room/);
  } finally {
    await receiver.stop();
  }
});

test('copying the backup to another drive: all of it, then only what is new; nothing deleted from the copy; refused on the same drive or another backup', async () => {
  const copyRoot = tmp();
  // Stand-in drives: the copy's folder is "E:", everything else "C:".
  const driveOf = (p) => (path.resolve(p).startsWith(copyRoot) ? 'E:' : 'C:');
  const { to, receiver, pageUrl } = await setup({ driveOf });
  try {
    const src = tmp();
    fs.writeFileSync(path.join(src, 'IMG_0001.jpg'), jpegWithDate('2008:12:24 18:00:00'));
    fs.writeFileSync(path.join(src, 'IMG_0002.jpg'), jpegWithDate('2009:07:14 12:00:00'));
    await receiver.importFolder(src);
    fs.mkdirSync(path.join(to, 'PicJot Tags', '2008', '12'), { recursive: true });
    fs.writeFileSync(path.join(to, 'PicJot Tags', '2008', '12', 'IMG_0001.jpg.json'), '{"caption":"Christmas"}');
    assert.match((await getPage(pageUrl)).text, /only in this backup. Keep a copy on another drive/);

    // Refused: inside the backup, the same drive, another PicJot backup.
    await assert.rejects(receiver.copyBackup(path.join(to, '2008')), /outside the backup folder/);
    await assert.rejects(receiver.copyBackup(tmp()), /on another drive/);
    const stick = path.join(copyRoot, 'stick');
    fs.mkdirSync(path.join(stick, '.photoapp'), { recursive: true });
    await assert.rejects(receiver.copyBackup(stick), /another PicJot backup/);
    fs.rmSync(stick, { recursive: true });

    // The first copy: all of it, into the empty folder chosen.
    let r = await receiver.copyBackup(copyRoot);
    assert.strictEqual(r.to, copyRoot);
    assert.strictEqual(r.photos, 2);
    assert.strictEqual(r.copied, 2);
    assert.ok(fs.existsSync(path.join(copyRoot, '2008', '12', 'IMG_0001.jpg')));
    assert.strictEqual(fs.readFileSync(path.join(copyRoot, 'PicJot Tags', '2008', '12', 'IMG_0001.jpg.json'), 'utf8'), '{"caption":"Christmas"}');
    assert.deepStrictEqual(
      JSON.parse(fs.readFileSync(path.join(copyRoot, '.photoapp', 'index.json'), 'utf8')).photos,
      JSON.parse(fs.readFileSync(path.join(to, '.photoapp', 'index.json'), 'utf8')).photos
    );
    assert.ok(fs.existsSync(path.join(copyRoot, '.photoapp', 'picjot-copy.json')));
    const page = (await getPage(pageUrl)).text;
    assert.match(page, /Copy of the Backup/);
    assert.doesNotMatch(page, /Keep a copy on another drive/);

    // Again: nothing new.
    r = await receiver.copyBackup(copyRoot);
    assert.strictEqual(r.copied, 0);

    // A tag file removed from the backup stays on the copy; a new photo is copied.
    fs.rmSync(path.join(to, 'PicJot Tags', '2008', '12', 'IMG_0001.jpg.json'));
    fs.writeFileSync(path.join(src, 'IMG_0003.jpg'), jpegWithDate('2010:01:01 09:00:00'));
    await receiver.importFolder(src);
    assert.match((await getPage(pageUrl)).text, /added since the backup was last copied/);
    r = await receiver.copyBackup(copyRoot);
    assert.strictEqual(r.photos, 3);
    assert.strictEqual(r.copied, 1);
    assert.ok(fs.existsSync(path.join(copyRoot, 'PicJot Tags', '2008', '12', 'IMG_0001.jpg.json')), 'nothing deleted from the copy');
  } finally {
    await receiver.stop();
  }
});
