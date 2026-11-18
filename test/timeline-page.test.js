'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { timelineData, timelinePage } = require('../timeline-page');

function backupWith(files) {
  const to = fs.mkdtempSync(path.join(os.tmpdir(), 'picjot-tl-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(to, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return to;
}

const H = (c) => c.repeat(32);
const tag = (hash, extra) => ({ version: 2, hashAlgorithm: 'md5', contentHash: hash, caption: '', tags: [], note: '', ...extra });

test("the PC's timeline: from the backup's tag files and Moments, by the shared rules", () => {
  const moment = '3f2a9c'.padEnd(32, '0');
  const to = backupWith({
    '.photoapp/index.json': {
      version: 1,
      photos: {
        [H('a')]: { path: '2012/06/a.jpg', size: 1, tagged: true },
        [H('b')]: { path: '2012/06/b.NEF', size: 1, tagged: true },
        [H('c')]: { path: '2014/05/c.jpg', size: 1, tagged: true },
        [H('d')]: { path: '2014/05/d.jpg', size: 1, tagged: true },
        [H('e')]: { path: '2026/01/e.jpg', size: 1, tagged: true },
        [H('f')]: { path: '2015/02/f.jpg', size: 1 },
      },
      moments: { [moment]: 'PicJot Tags/2015/08/Moment - Moved to Denver (3f2a9c).json' },
    },
    'PicJot Tags/2012/06/a.jpg.json': tag(H('a'), { significance: 'timeline', caption: 'Summit', creationTime: '2012-06-23T18:00:00.000Z' }),
    'PicJot Tags/2012/06/b.NEF.json': tag(H('b'), { significance: 'timeline', creationTime: '2012-06-23T19:00:00.000Z', timelineMain: true }),
    // Beside its photo: a backup whose tag files haven't moved yet.
    '2014/05/c.jpg.json': tag(H('c'), { significance: 'timeline', caption: 'Low tide', creationTime: '2014-05-11T18:00:00.000Z' }),
    'PicJot Tags/2014/05/d.jpg.json': tag(H('d'), { significance: 'notable', creationTime: '2014-05-11T19:00:00.000Z' }),
    'PicJot Tags/2026/01/e.jpg.json': tag(H('e'), { significance: 'timeline', creationTime: '2026-01-10T18:00:00.000Z', timelineDate: '1987' }),
    'PicJot Tags/2015/08/Moment - Moved to Denver (3f2a9c).json': { version: 2, kind: 'moment', id: moment, title: 'Moved to Denver', date: '2015-08-21', note: 'A new start', tags: ['home'] },
  });
  const t = timelineData(to);
  assert.deepStrictEqual(
    t.entries.map((e) => [e.kind, e.date, e.title]),
    [
      ['moment', 'August 21, 2015', 'Moved to Denver'],
      ['day', 'May 11, 2014', 'Low tide'],
      ['day', 'June 23, 2012', ''],
      ['day', '1987', ''],
    ]
  );
  const june = t.entries[2];
  assert.deepStrictEqual(june.photos.map((p) => [p.file, p.kind]), [['b.NEF', 'raw'], ['a.jpg', 'jpeg']], 'the chosen main photo first');
  assert.strictEqual(t.entries[0].note, 'A new start');
  assert.deepStrictEqual(t.entries[0].tags, ['home']);
  assert.deepStrictEqual(t.counts, { timeline: 4, notable: 1, moments: 1 });
  assert.strictEqual(t.entries[1].gap, '1 year');
  const withNotable = timelineData(to, { includeNotable: true });
  assert.strictEqual(withNotable.entries[1].photos.length, 2);
  assert.match(timelinePage('PicJot'), /<title>Timeline · PicJot<\/title>/);
});

test('an empty or missing backup gives an empty timeline', () => {
  const to = backupWith({});
  assert.deepStrictEqual(timelineData(to), {
    group: 'day',
    search: '',
    hide: { terms: [], photos: 0, moments: 0 },
    tags: [],
    entries: [],
    counts: { timeline: 0, notable: 0, moments: 0 },
  });
});

test("Week / Month, Search, and this PC's Do Not Show list, with the timeline's tags to pick from", () => {
  const to = backupWith({
    '.photoapp/index.json': {
      version: 1,
      photos: {
        [H('a')]: { path: '2026/10/a.jpg', size: 1, tagged: true },
        [H('b')]: { path: '2026/10/b.jpg', size: 1, tagged: true },
        [H('c')]: { path: '2026/10/c.jpg', size: 1, tagged: true },
      },
    },
    'PicJot Tags/2026/10/a.jpg.json': tag(H('a'), { significance: 'timeline', caption: 'Pumpkins', tags: ['family', 'fall'], creationTime: '2026-10-18T18:00:00.000Z' }),
    'PicJot Tags/2026/10/b.jpg.json': tag(H('b'), { significance: 'timeline', tags: ['Family'], creationTime: '2026-10-23T18:00:00.000Z', timelineMainMonth: true }),
    'PicJot Tags/2026/10/c.jpg.json': tag(H('c'), { significance: 'timeline', tags: ['Work'], creationTime: '2026-10-05T18:00:00.000Z' }),
  });
  const files = (t) => t.entries.map((e) => [e.date, e.photos.map((p) => p.file).join(',')]);
  const all = timelineData(to, { group: 'month' });
  assert.deepStrictEqual(files(all), [['October 2026', 'b.jpg,c.jpg,a.jpg']], "the month's chosen main photo first");
  assert.deepStrictEqual(all.tags, ['Family', 'fall', 'Work'], 'most used first, any case counted together');
  assert.deepStrictEqual(files(timelineData(to, { group: 'week', hide: ['work'] })), [['October 18–24, 2026', 'a.jpg,b.jpg']]);
  const month = timelineData(to, { group: 'month', hide: ['#work', 'WORK'] });
  assert.deepStrictEqual(files(month), [['October 2026', 'b.jpg,a.jpg']]);
  assert.deepStrictEqual(month.hide, { terms: ['work'], photos: 1, moments: 0 });
  assert.deepStrictEqual(files(timelineData(to, { group: 'month', search: 'pumpkin', hide: ['work'] })), [['October 2026', 'a.jpg']]);
  assert.strictEqual(timelineData(to, { group: 'fortnight' }).group, 'day');
});
