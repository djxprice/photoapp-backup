'use strict';
// Synthetic JPEGs for tests: no image data, just the structure the code reads.

const seg = (marker, body) => {
  const len = Buffer.alloc(2);
  len.writeUInt16BE(body.length + 2);
  return Buffer.concat([Buffer.from([0xff, marker]), len, body]);
};

// A structurally complete JPEG: SOI, APP1 (optionally holding a thumbnail
// JPEG), a frame header of type `sof`, a scan with a stuffed FF and a restart
// marker in its data, EOI. `size` pads the scan data.
function jpeg({ sof = 0xc0, size = 100, inner = null } = {}) {
  const data = Buffer.alloc(size, 0x11);
  data[5] = 0xff;
  data[6] = 0x00;
  data[9] = 0xff;
  data[10] = 0xd3;
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe1, Buffer.concat([Buffer.from('Exif\0\0'), inner || Buffer.alloc(0)])),
    seg(sof, Buffer.alloc(9, 1)),
    seg(0xda, Buffer.alloc(6, 2)),
    data,
    Buffer.from([0xff, 0xd9]),
  ]);
}

// A JPEG whose EXIF says it was taken at `original` ("YYYY:MM:DD HH:MM:SS"):
// IFD0 -> Exif IFD -> DateTimeOriginal, little-endian.
function jpegWithDate(original) {
  const u16 = (v) => [v & 0xff, v >> 8];
  const u32 = (v) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, v >>> 24];
  const exifIfd = 8 + 2 + 12 + 4;
  const data = exifIfd + 2 + 12 + 4;
  const tiff = [
    0x49, 0x49, ...u16(42), ...u32(8),
    ...u16(1), ...u16(0x8769), ...u16(4), ...u32(1), ...u32(exifIfd), ...u32(0),
    ...u16(1), ...u16(0x9003), ...u16(2), ...u32(20), ...u32(data), ...u32(0),
    ...Buffer.from(`${original}\0`, 'latin1'),
  ];
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe1, Buffer.concat([Buffer.from('Exif\0\0'), Buffer.from(tiff)])),
    seg(0xc0, Buffer.alloc(9, 1)),
    seg(0xda, Buffer.alloc(6, 2)),
    Buffer.alloc(50, 0x11),
    Buffer.from([0xff, 0xd9]),
  ]);
}

module.exports = { jpeg, jpegWithDate };
