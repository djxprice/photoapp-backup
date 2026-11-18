'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { takeoutJsonFor, readTakeout } = require('../lib/takeout');

test("finds a photo's Takeout .json, whatever Takeout named it", () => {
  const jsons = new Set([
    'IMG_1.jpg.json',
    'IMG_2.jpg.supplemental-metadata.json',
    'IMG_3.jpg.supplemental-metad.json',
    'IMG_4.jpg(1).json',
    'IMG_5.jpg.supplemental-metadata(2).json',
    'Screenshot_2019-07-14-15-22-10-123_com.exam.json',
    'metadata.json',
  ]);
  assert.equal(takeoutJsonFor('IMG_1.jpg', jsons), 'IMG_1.jpg.json');
  assert.equal(takeoutJsonFor('IMG_2.jpg', jsons), 'IMG_2.jpg.supplemental-metadata.json');
  assert.equal(takeoutJsonFor('IMG_3.jpg', jsons), 'IMG_3.jpg.supplemental-metad.json');
  assert.equal(takeoutJsonFor('IMG_4(1).jpg', jsons), 'IMG_4.jpg(1).json');
  assert.equal(takeoutJsonFor('IMG_5(2).jpg', jsons), 'IMG_5.jpg.supplemental-metadata(2).json');
  assert.equal(takeoutJsonFor('IMG_1-edited.jpg', jsons), 'IMG_1.jpg.json');
  assert.equal(
    takeoutJsonFor('Screenshot_2019-07-14-15-22-10-123_com.example.app.png', jsons),
    'Screenshot_2019-07-14-15-22-10-123_com.exam.json'
  );
  assert.equal(takeoutJsonFor('IMG_9.jpg', jsons), null);
  assert.equal(takeoutJsonFor('IMG_4.jpg', jsons), null, 'the (1) json belongs to IMG_4(1).jpg');
});

test("reads a Takeout .json: when taken (UTC) and the user's description", () => {
  assert.deepEqual(
    readTakeout(JSON.stringify({ title: 'IMG_1.jpg', description: ' Grandma at the lake ', photoTakenTime: { timestamp: '1247584930' } })),
    { takenTime: '2009-07-14T15:22:10.000Z', description: 'Grandma at the lake' }
  );
  assert.deepEqual(readTakeout(JSON.stringify({ title: 'x.jpg', description: '' })), { takenTime: null, description: null });
  assert.equal(readTakeout('{"albumData": {}}'), null, 'not a photo record');
  assert.equal(readTakeout('not json'), null);
});
