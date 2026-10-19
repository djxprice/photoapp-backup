'use strict';
/*
  A small Multicast DNS (mDNS / DNS-SD) responder, so the phone can find the
  Wi-Fi receiver when the PC's network address has changed (roadmap Step 33
  stage 2; docs/wifi-backup.md). It answers only for PicJot's own service,
  "_picjot._tcp.local": the receiver's port, its addresses and its PC id.
  The phone (Android's NSD) still checks the certificate it pinned at pairing
  before sending anything, so an answer from another device can't divert a
  backup. No dependencies: Node's dgram.
*/
const dgram = require('dgram');
const os = require('os');

const MDNS_ADDRESS = '224.0.0.251';
const MDNS_PORT = 5353;
const SERVICE_TYPE = '_picjot._tcp.local';
const TYPE = { A: 1, PTR: 12, TXT: 16, SRV: 33, ANY: 255 };
const CLASS_IN = 1;
const CACHE_FLUSH = 0x8000;
const TTL = 120;

// ── Wire format ─────────────────────────────────────────────────────────────
function encodeName(name) {
  const parts = [];
  for (const label of name.replace(/\.$/, '').split('.')) {
    const b = Buffer.from(label, 'utf8');
    if (!b.length || b.length > 63) throw new Error(`bad DNS label in "${name}"`);
    parts.push(Buffer.from([b.length]), b);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

// The name at `offset` (following compression pointers) -> { name, end },
// `end` being where the name ends in its original position.
function decodeName(buf, offset) {
  const labels = [];
  let pos = offset;
  let end = -1;
  for (let steps = 0; steps < 128; steps++) {
    if (pos >= buf.length) throw new Error('truncated name');
    const len = buf[pos];
    if (len === 0) return { name: labels.join('.'), end: end < 0 ? pos + 1 : end };
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length) throw new Error('truncated pointer');
      if (end < 0) end = pos + 2;
      pos = ((len & 0x3f) << 8) | buf[pos + 1];
      continue;
    }
    if (len & 0xc0) throw new Error('bad label');
    if (pos + 1 + len > buf.length) throw new Error('truncated label');
    labels.push(buf.toString('utf8', pos + 1, pos + 1 + len));
    pos += 1 + len;
  }
  throw new Error('name too long');
}

const u16 = (n) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
};

function record(name, type, rdata, { flush = false, ttl = TTL } = {}) {
  const head = Buffer.alloc(10);
  head.writeUInt16BE(type, 0);
  head.writeUInt16BE(CLASS_IN | (flush ? CACHE_FLUSH : 0), 2);
  head.writeUInt32BE(ttl, 4);
  head.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([encodeName(name), head, rdata]);
}

const srvData = (port, target) => Buffer.concat([u16(0), u16(0), u16(port), encodeName(target)]);
const txtData = (pairs) =>
  Buffer.concat(
    Object.entries(pairs).map(([k, v]) => {
      const s = Buffer.from(`${k}=${v}`, 'utf8');
      return Buffer.concat([Buffer.from([s.length]), s]);
    })
  );
const ipv4 = (addr) => Buffer.from(addr.split('.').map(Number));

// A message -> { id, response, questions: [{ name, type, klass, unicast }],
// records: [{ name, type, ttl, flush, data }] } (answers and additionals;
// data decoded for A, PTR, SRV and TXT). Throws on malformed input.
function parseMessage(buf) {
  if (buf.length < 12) throw new Error('too short');
  const id = buf.readUInt16BE(0);
  const flags = buf.readUInt16BE(2);
  const counts = [4, 6, 8, 10].map((o) => buf.readUInt16BE(o));
  let pos = 12;
  const questions = [];
  for (let i = 0; i < counts[0]; i++) {
    const { name, end } = decodeName(buf, pos);
    if (end + 4 > buf.length) throw new Error('truncated question');
    const klass = buf.readUInt16BE(end + 2);
    questions.push({ name, type: buf.readUInt16BE(end), klass: klass & 0x7fff, unicast: Boolean(klass & 0x8000) });
    pos = end + 4;
  }
  const records = [];
  const total = counts[1] + counts[2] + counts[3];
  for (let i = 0; i < total; i++) {
    const { name, end } = decodeName(buf, pos);
    if (end + 10 > buf.length) throw new Error('truncated record');
    const type = buf.readUInt16BE(end);
    const klass = buf.readUInt16BE(end + 2);
    const ttl = buf.readUInt32BE(end + 4);
    const len = buf.readUInt16BE(end + 8);
    const start = end + 10;
    if (start + len > buf.length) throw new Error('truncated data');
    let data = buf.subarray(start, start + len);
    if (type === TYPE.A && len === 4) data = [...data].join('.');
    else if (type === TYPE.PTR) data = decodeName(buf, start).name;
    else if (type === TYPE.SRV) data = { port: buf.readUInt16BE(start + 4), target: decodeName(buf, start + 6).name };
    else if (type === TYPE.TXT) {
      const pairs = {};
      for (let p = start; p < start + len; ) {
        const s = buf.toString('utf8', p + 1, p + 1 + buf[p]);
        const eq = s.indexOf('=');
        if (s) pairs[eq < 0 ? s : s.slice(0, eq)] = eq < 0 ? '' : s.slice(eq + 1);
        p += 1 + buf[p];
      }
      data = pairs;
    }
    records.push({ name, type, ttl, flush: Boolean(klass & CACHE_FLUSH), data });
    pos = start + len;
  }
  return { id, response: Boolean(flags & 0x8000), questions, records };
}

// A query (for tests and checks from this PC).
function buildQuery(name, type, { id = 0, unicast = false } = {}) {
  const h = Buffer.alloc(12);
  h.writeUInt16BE(id, 0);
  h.writeUInt16BE(1, 4);
  return Buffer.concat([h, encodeName(name), u16(type), u16(CLASS_IN | (unicast ? 0x8000 : 0))]);
}

function buildPacket({ id = 0, questions = [], answers, additionals = [] }) {
  const h = Buffer.alloc(12);
  h.writeUInt16BE(id, 0);
  h.writeUInt16BE(0x8400, 2); // a response, authoritative
  h.writeUInt16BE(questions.length, 4);
  h.writeUInt16BE(answers.length, 6);
  h.writeUInt16BE(additionals.length, 10);
  const qs = questions.map((q) => Buffer.concat([encodeName(q.name), u16(q.type), u16(q.klass)]));
  return Buffer.concat([h, ...qs, ...answers, ...additionals]);
}

// ── What this PC answers ────────────────────────────────────────────────────
// The service instance and host names for a PC id (ASCII, DNS-safe).
function serviceNames(pcId) {
  const label = String(pcId).replace(/[^A-Za-z0-9-]/g, 'x');
  return { instance: `PicJot-${label}.${SERVICE_TYPE}`, host: `picjot-${label.toLowerCase()}.local` };
}

// The records answering `questions` for { pcId, port, addresses }, as
// { answers, additionals } (arrays of encoded records), or null when none of
// the questions is about this receiver. `legacy`: a plain unicast DNS reply,
// which must not set the cache-flush bit.
function answerFor(questions, { pcId, port, addresses }, { ttl = TTL, legacy = false } = {}) {
  const { instance, host } = serviceNames(pcId);
  const flush = !legacy;
  const make = {
    ptr: () => [record(SERVICE_TYPE, TYPE.PTR, encodeName(instance), { ttl })],
    srv: () => [record(instance, TYPE.SRV, srvData(port, host), { flush, ttl })],
    txt: () => [record(instance, TYPE.TXT, txtData({ id: pcId, v: '1' }), { flush, ttl })],
    a: () => addresses.map((addr) => record(host, TYPE.A, ipv4(addr), { flush, ttl })),
  };
  const answers = new Set();
  const extra = new Set();
  const asks = (q, type) => q.type === type || q.type === TYPE.ANY;
  for (const q of questions) {
    const name = q.name.toLowerCase();
    if (name === SERVICE_TYPE && asks(q, TYPE.PTR)) {
      answers.add('ptr');
      ['srv', 'txt', 'a'].forEach((k) => extra.add(k));
    } else if (name === instance.toLowerCase()) {
      if (asks(q, TYPE.SRV)) answers.add('srv');
      if (asks(q, TYPE.TXT)) answers.add('txt');
      extra.add('a');
    } else if (name === host && asks(q, TYPE.A)) {
      answers.add('a');
    }
  }
  if (!answers.size) return null;
  const list = (keys) => [...keys].flatMap((k) => make[k]());
  const out = { answers: list(answers), additionals: list([...extra].filter((k) => !answers.has(k))) };
  return out.answers.length ? out : null;
}

const toInt = (addr) => addr.split('.').reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
const sameSubnet = (a, b, mask) => ((toInt(a) & toInt(mask)) >>> 0) === ((toInt(b) & toInt(mask)) >>> 0);

// The replies to one received message, as [{ data, address, port, iface }]
// (iface: the local address to send a multicast reply from). Each multicast
// reply goes out on one network and names only that network's address, so a
// phone never gets an address it can't reach (e.g. a virtual adapter's).
function repliesTo(msg, rinfo, info, interfaces) {
  if (msg.response || !msg.questions.length) return [];
  if (!answerFor(msg.questions, { ...info, addresses: ['0.0.0.0'] })) return [];
  const out = [];
  const legacy = rinfo.port !== MDNS_PORT; // a plain DNS query sent to the mDNS address
  if (legacy || msg.questions.some((q) => q.unicast)) {
    const near = interfaces.filter((i) => sameSubnet(i.address, rinfo.address, i.netmask));
    const addresses = (near.length ? near : interfaces).map((i) => i.address);
    const r = answerFor(msg.questions, { ...info, addresses }, legacy ? { ttl: 10, legacy: true } : {});
    if (r) {
      out.push({
        data: buildPacket({ id: legacy ? msg.id : 0, questions: legacy ? msg.questions : [], ...r }),
        address: rinfo.address,
        port: rinfo.port,
      });
    }
    if (legacy) return out;
  }
  for (const i of interfaces) {
    const r = answerFor(msg.questions, { ...info, addresses: [i.address] });
    if (r) out.push({ data: buildPacket(r), address: MDNS_ADDRESS, port: MDNS_PORT, iface: i.address });
  }
  return out;
}

// This PC's home-network IPv4 interfaces: [{ address, netmask }].
function lanInterfaces() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family !== 'IPv4' || i.internal) continue;
      const [x, y] = i.address.split('.').map(Number);
      if (x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168)) {
        out.push({ address: i.address, netmask: i.netmask });
      }
    }
  }
  return out;
}

// ── The responder ───────────────────────────────────────────────────────────
// Answers queries for this receiver on every home network, announces it when
// it starts and when the PC's addresses change (checked every refreshMs), and
// says goodbye when closed. Problems are logged, never thrown: discovery is a
// convenience, the saved addresses still work without it.
function createResponder({ pcId, port, log = () => {}, interfaces = lanInterfaces, refreshMs = 30000 }) {
  let sock = null;
  let joinedKey = '';
  let timer = null;
  const info = () => ({ pcId, port: typeof port === 'function' ? port() : port });
  const keyOf = (ifs) => ifs.map((i) => i.address).sort().join(',');

  // Sent one after another, so each multicast reply leaves on its own network.
  function sendAll(s, list, done = () => {}) {
    const next = (n) => {
      if (n >= list.length) return done();
      const item = list[n];
      try {
        if (item.iface) s.setMulticastInterface(item.iface);
        s.send(item.data, item.port, item.address, () => next(n + 1));
      } catch {
        next(n + 1);
      }
      return undefined;
    };
    next(0);
  }

  function announcements(ttl) {
    const q = [{ name: SERVICE_TYPE, type: TYPE.PTR }];
    return interfaces()
      .map((i) => {
        const r = answerFor(q, { ...info(), addresses: [i.address] }, { ttl });
        return r && { data: buildPacket(r), address: MDNS_ADDRESS, port: MDNS_PORT, iface: i.address };
      })
      .filter(Boolean);
  }

  function open() {
    const ifs = interfaces();
    joinedKey = keyOf(ifs);
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    s.on('error', (e) => log(`Network discovery problem: ${e.message}`));
    s.on('message', (buf, rinfo) => {
      let msg;
      try {
        msg = parseMessage(buf);
      } catch {
        return;
      }
      const replies = repliesTo(msg, rinfo, info(), interfaces());
      if (replies.length) sendAll(s, replies);
    });
    s.bind(MDNS_PORT, () => {
      for (const i of ifs) {
        try {
          s.addMembership(MDNS_ADDRESS, i.address);
        } catch (e) {
          log(`Network discovery: couldn't listen on ${i.address} (${e.message})`);
        }
      }
      try {
        s.setMulticastTTL(255);
        s.setMulticastLoopback(true);
      } catch {
        // defaults are fine
      }
      sendAll(s, announcements(TTL));
      setTimeout(() => sock === s && sendAll(s, announcements(TTL)), 1000).unref();
    });
    sock = s;
  }

  // goodbye: first tell the network the service is gone (TTL 0).
  function closeSocket(s, goodbye, done) {
    if (!s) return done();
    const close = () => {
      try {
        s.close(() => done());
      } catch {
        done();
      }
    };
    if (goodbye) sendAll(s, announcements(0), close);
    else close();
    return undefined;
  }

  open();
  timer = setInterval(() => {
    const now = interfaces();
    if (keyOf(now) === joinedKey) return;
    log(`This PC's network address is now ${now.map((i) => i.address).join(', ') || 'none'}.`);
    const old = sock;
    sock = null;
    closeSocket(old, false, open);
  }, refreshMs);
  timer.unref();

  return {
    close: () =>
      new Promise((resolve) => {
        clearInterval(timer);
        const s = sock;
        sock = null;
        closeSocket(s, true, resolve);
      }),
  };
}

module.exports = {
  SERVICE_TYPE,
  TYPE,
  MDNS_ADDRESS,
  MDNS_PORT,
  encodeName,
  decodeName,
  parseMessage,
  buildQuery,
  serviceNames,
  answerFor,
  repliesTo,
  lanInterfaces,
  createResponder,
};
