'use strict';
const test = require('node:test');
const assert = require('node:assert');
const dgram = require('dgram');

const {
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
} = require('../lib/mdns');

const info = { pcId: 'Ab_c-12345678', port: 47823 };
const ifs = [
  { address: '192.168.1.20', netmask: '255.255.255.0' },
  { address: '172.20.48.1', netmask: '255.255.240.0' }, // e.g. a virtual adapter
];
const fromPhone = { address: '192.168.1.57', port: MDNS_PORT };

test('names: encode, decode, compression pointers', () => {
  const n = encodeName('_picjot._tcp.local');
  assert.deepStrictEqual(decodeName(n, 0), { name: '_picjot._tcp.local', end: n.length });
  // "x" followed by a pointer back to offset 0.
  const buf = Buffer.concat([n, Buffer.from([1, 0x78, 0xc0, 0x00])]);
  assert.deepStrictEqual(decodeName(buf, n.length), { name: 'x._picjot._tcp.local', end: buf.length });
  assert.throws(() => decodeName(Buffer.from([0xc0, 0x00]), 0), /too long/, 'a pointer loop');
  assert.throws(() => encodeName('a'.repeat(64) + '.local'), /bad DNS label/);
});

test('names for a PC id are DNS-safe', () => {
  const { instance, host } = serviceNames('Ab_c-12345678');
  assert.strictEqual(instance, `PicJot-Abxc-12345678.${SERVICE_TYPE}`);
  assert.strictEqual(host, 'picjot-abxc-12345678.local');
});

test('a PTR query for the service gets the PTR, with SRV, TXT and A records', () => {
  const r = answerFor([{ name: SERVICE_TYPE, type: TYPE.PTR }], { ...info, addresses: ['192.168.1.20'] });
  const msg = parseMessage(Buffer.concat([Buffer.from([0, 0, 0x84, 0, 0, 0, 0, r.answers.length, 0, 0, 0, r.additionals.length]), ...r.answers, ...r.additionals]));
  const { instance, host } = serviceNames(info.pcId);
  const byType = Object.fromEntries(msg.records.map((x) => [x.type, x]));
  assert.strictEqual(byType[TYPE.PTR].data, instance);
  assert.deepStrictEqual(byType[TYPE.SRV].data, { port: 47823, target: host });
  assert.deepStrictEqual(byType[TYPE.TXT].data, { id: info.pcId, v: '1' });
  assert.strictEqual(byType[TYPE.A].data, '192.168.1.20');
  assert.ok(byType[TYPE.SRV].flush && !byType[TYPE.PTR].flush, 'cache-flush on unique records only');
  assert.strictEqual(byType[TYPE.PTR].ttl, 120);
});

test('only questions about this receiver are answered', () => {
  assert.strictEqual(answerFor([{ name: '_googlecast._tcp.local', type: TYPE.PTR }], { ...info, addresses: ['192.168.1.20'] }), null);
  assert.strictEqual(answerFor([{ name: 'PicJot-other._picjot._tcp.local', type: TYPE.SRV }], { ...info, addresses: [] }), null);
  const { instance, host } = serviceNames(info.pcId);
  const srv = answerFor([{ name: instance.toUpperCase(), type: TYPE.SRV }], { ...info, addresses: ['10.0.0.2'] });
  assert.strictEqual(srv.answers.length, 1, 'names match regardless of case');
  const a = answerFor([{ name: host, type: TYPE.A }], { ...info, addresses: ['10.0.0.2', '10.0.0.3'] });
  assert.strictEqual(a.answers.length, 2);
});

test('multicast replies: one per network, each naming only that network\'s address', () => {
  const msg = parseMessage(buildQuery(SERVICE_TYPE, TYPE.PTR));
  const out = repliesTo(msg, fromPhone, info, ifs);
  assert.strictEqual(out.length, 2);
  for (const [n, r] of out.entries()) {
    assert.strictEqual(r.address, MDNS_ADDRESS);
    assert.strictEqual(r.port, MDNS_PORT);
    assert.strictEqual(r.iface, ifs[n].address);
    const a = parseMessage(r.data).records.filter((x) => x.type === TYPE.A).map((x) => x.data);
    assert.deepStrictEqual(a, [ifs[n].address]);
  }
  assert.deepStrictEqual(repliesTo(parseMessage(buildQuery('_ipp._tcp.local', TYPE.PTR)), fromPhone, info, ifs), []);
});

test('a unicast-response question also gets a direct reply with the nearby address', () => {
  const msg = parseMessage(buildQuery(SERVICE_TYPE, TYPE.PTR, { unicast: true }));
  const out = repliesTo(msg, fromPhone, info, ifs);
  const direct = out.find((r) => r.address === fromPhone.address);
  assert.ok(direct);
  const a = parseMessage(direct.data).records.filter((x) => x.type === TYPE.A).map((x) => x.data);
  assert.deepStrictEqual(a, ['192.168.1.20'], 'the address on the phone\'s network');
});

test('a plain DNS query to the mDNS address gets a plain reply: same id, the question, no cache-flush', () => {
  const msg = parseMessage(buildQuery(SERVICE_TYPE, TYPE.PTR, { id: 4242 }));
  const out = repliesTo(msg, { address: '192.168.1.57', port: 53001 }, info, ifs);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].port, 53001);
  const reply = parseMessage(out[0].data);
  assert.strictEqual(reply.id, 4242);
  assert.ok(reply.response);
  assert.strictEqual(reply.questions[0].name, SERVICE_TYPE);
  assert.ok(reply.records.every((x) => !x.flush));
});

test('responses and malformed packets are ignored', () => {
  const r = answerFor([{ name: SERVICE_TYPE, type: TYPE.PTR }], { ...info, addresses: ['192.168.1.20'] });
  const response = parseMessage(Buffer.concat([Buffer.from([0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 0]), r.answers[0]]));
  assert.deepStrictEqual(repliesTo(response, fromPhone, info, ifs), []);
  assert.throws(() => parseMessage(Buffer.from([1, 2, 3])));
  assert.throws(() => parseMessage(Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 5, 0x61])));
});

// The real thing, over the network stack: a plain DNS query sent to the mDNS
// address from this PC is answered directly. Skipped without a home network.
test('the responder answers on this PC', { skip: lanInterfaces().length === 0 && 'no home network' }, async () => {
  const responder = createResponder({ pcId: 'TestPc123456', port: 40000 + Math.floor(Math.random() * 1000) });
  const client = dgram.createSocket('udp4');
  try {
    await new Promise((resolve) => client.bind(0, resolve));
    const reply = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no answer within 3 s')), 3000);
      client.on('message', (buf) => {
        const msg = parseMessage(buf);
        if (msg.id === 777) {
          clearTimeout(t);
          resolve(msg);
        }
      });
    });
    // Wait for the responder to bind, then ask (twice, in case the first was early).
    await new Promise((r) => setTimeout(r, 300));
    const q = buildQuery(SERVICE_TYPE, TYPE.PTR, { id: 777 });
    client.send(q, MDNS_PORT, MDNS_ADDRESS);
    setTimeout(() => client.send(q, MDNS_PORT, MDNS_ADDRESS), 800).unref();
    const msg = await reply;
    const txt = msg.records.find((x) => x.type === TYPE.TXT);
    assert.strictEqual(txt.data.id, 'TestPc123456');
  } finally {
    client.close();
    await responder.close();
  }
});
