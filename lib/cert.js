'use strict';
/*
  A self-signed certificate for the Wi-Fi receiver, made with Node's crypto
  alone (no dependencies): an EC P-256 key and a minimal X.509 v3 certificate,
  DER-encoded by hand and signed with ECDSA-SHA256.

  The phone never trusts it the usual way. It pins the certificate's public
  key: the SHA-256 of its SubjectPublicKeyInfo (`spkiSha256`, base64), which
  it learns from the pairing QR code. So the certificate only needs to be
  well-formed; names and dates matter little (it's valid for 30 years).
*/
const crypto = require('crypto');

// ── Minimal DER encoding ───────────────────────────────────────────────────
function len(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag, body) => Buffer.concat([Buffer.from([tag]), len(body.length), body]);
const seq = (...items) => tlv(0x30, Buffer.concat(items));
const set = (...items) => tlv(0x31, Buffer.concat(items));
const explicit = (n, body) => tlv(0xa0 + n, body);
const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
const bitString = (bytes) => tlv(0x03, Buffer.concat([Buffer.from([0]), bytes]));
const octetString = (bytes) => tlv(0x04, bytes);
const bool = (v) => tlv(0x01, Buffer.from([v ? 0xff : 0]));

// A non-negative INTEGER from bytes (a leading 0 keeps it positive).
function integer(bytes) {
  let b = Buffer.from(bytes);
  while (b.length > 1 && b[0] === 0 && b[1] < 0x80) b = b.subarray(1);
  if (b[0] >= 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}

function oid(dotted) {
  const parts = dotted.split('.').map(Number);
  const out = [parts[0] * 40 + parts[1]];
  for (const p of parts.slice(2)) {
    const chunk = [p & 0x7f];
    for (let v = p >> 7; v > 0; v >>= 7) chunk.unshift((v & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

// UTCTime before 2050, GeneralizedTime from 2050 (RFC 5280).
function time(date) {
  const iso = date.toISOString(); // 2026-10-17T12:34:56.789Z
  const digits = iso.slice(0, 19).replace(/[-:T]/g, ''); // 20261017123456
  return date.getUTCFullYear() < 2050
    ? tlv(0x17, Buffer.from(`${digits.slice(2)}Z`, 'ascii'))
    : tlv(0x18, Buffer.from(`${digits}Z`, 'ascii'));
}

const ECDSA_SHA256 = '1.2.840.10045.4.3.2';
const COMMON_NAME = '2.5.4.3';
const BASIC_CONSTRAINTS = '2.5.29.19';

const name = (cn) => seq(set(seq(oid(COMMON_NAME), utf8(cn))));

// PEM text for DER bytes.
function pem(label, der) {
  const b64 = der.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '');
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

// The pin the phone checks: SHA-256 of the DER SubjectPublicKeyInfo, base64.
function spkiSha256(publicKey) {
  const key =
    publicKey instanceof crypto.KeyObject && publicKey.type === 'public'
      ? publicKey
      : crypto.createPublicKey(publicKey);
  const spki = key.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(spki).digest('base64');
}

// A new key and self-signed certificate:
// { keyPem, certPem, spkiSha256, notAfter }.
function createCertificate({ commonName = 'PicJot Receiver', now = new Date(), years = 30 } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const notBefore = new Date(now.getTime() - 24 * 60 * 60 * 1000); // a day of clock slack
  const notAfter = new Date(now);
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + years);
  const serial = crypto.randomBytes(16);
  serial[0] &= 0x7f; // positive

  const tbs = seq(
    explicit(0, integer([2])), // v3
    integer(serial),
    seq(oid(ECDSA_SHA256)),
    name(commonName),
    seq(time(notBefore), time(notAfter)),
    name(commonName),
    spki,
    explicit(3, seq(seq(oid(BASIC_CONSTRAINTS), bool(true), octetString(seq())))) // not a CA
  );
  const signature = crypto.sign('sha256', tbs, privateKey); // DER ECDSA signature
  const cert = seq(tbs, seq(oid(ECDSA_SHA256)), bitString(signature));

  return {
    keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    certPem: pem('CERTIFICATE', cert),
    spkiSha256: crypto.createHash('sha256').update(spki).digest('base64'),
    notAfter: notAfter.toISOString(),
  };
}

module.exports = { createCertificate, spkiSha256 };
