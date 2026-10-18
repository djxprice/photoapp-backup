'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const https = require('https');
const tls = require('tls');

const { createCertificate, spkiSha256 } = require('../lib/cert');

test('creates a well-formed, self-signed certificate', () => {
  const c = createCertificate({ now: new Date('2026-10-17T12:00:00Z') });
  const x = new crypto.X509Certificate(c.certPem);
  assert.match(x.subject, /CN=PicJot Receiver/);
  assert.strictEqual(x.subject, x.issuer);
  assert.ok(x.verify(x.publicKey), 'signed by its own key');
  assert.ok(x.checkPrivateKey(crypto.createPrivateKey(c.keyPem)), 'key matches');
  assert.strictEqual(x.ca, false);
  assert.ok(new Date(x.validTo) > new Date('2055-01-01'), 'valid for decades (GeneralizedTime after 2049)');
  assert.ok(new Date(x.validFrom) < new Date('2026-10-17T12:00:00Z'));
  assert.strictEqual(spkiSha256(x.publicKey), c.spkiSha256);
});

test('each certificate has its own key', () => {
  assert.notStrictEqual(createCertificate().spkiSha256, createCertificate().spkiSha256);
});

// The phone's check: accept the server only if its public key matches the pin
// from the QR code, whatever the certificate's name or issuer.
function pinnedGet(port, pin) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      {
        host: '127.0.0.1',
        port,
        path: '/',
        agent: false, // no keep-alive: each request gets its own connection
        rejectUnauthorized: false, // self-signed: trust comes from the pin
        checkServerIdentity: () => undefined,
      },
      (res) => {
        const peer = res.socket.getPeerX509Certificate();
        if (spkiSha256(peer.publicKey) !== pin) {
          res.destroy();
          reject(new Error('pin mismatch'));
          return;
        }
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve(body));
      }
    );
    req.on('error', reject);
  });
}

test('serves HTTPS with it, and a pinned client accepts only that key', async () => {
  const c = createCertificate();
  const server = https.createServer({ key: c.keyPem, cert: c.certPem, minVersion: 'TLSv1.2' }, (req, res) =>
    res.end('hello')
  );
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    assert.strictEqual(await pinnedGet(port, c.spkiSha256), 'hello');
    await assert.rejects(pinnedGet(port, createCertificate().spkiSha256), /pin mismatch/);
    // A normal client (no pin, default trust) refuses the self-signed certificate.
    await assert.rejects(
      new Promise((resolve, reject) => {
        const s = tls.connect({ host: '127.0.0.1', port, servername: 'localhost' }, () => {
          s.destroy();
          resolve();
        });
        s.on('error', reject);
      }),
      /self[- ]signed/i
    );
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
