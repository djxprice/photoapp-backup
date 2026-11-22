'use strict';
// Exporting the timeline (2026-11-22): what goes into the folder's page, and
// that it lays the timeline out as the PC's page does.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const { timelineData, timelinePage, timelineExport, exportCounts } = require('../timeline-page');
const { browserScript } = require('../lib/timeline-bundle-make');

function backupWith(files) {
  const to = fs.mkdtempSync(path.join(os.tmpdir(), 'picjot-tlx-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(to, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return to;
}

const H = (c) => c.repeat(32);
const tag = (hash, extra) => ({ version: 2, hashAlgorithm: 'md5', contentHash: hash, caption: '', tags: [], note: '', ...extra });
const MOMENT = '3f2a9c'.padEnd(32, '0');
const TRIP = '7b7b7b'.padEnd(32, '0');

const backup = () =>
  backupWith({
    '.photoapp/index.json': {
      version: 1,
      photos: {
        [H('a')]: { path: '2012/06/a.jpg', size: 1, tagged: true },
        [H('b')]: { path: '2012/06/b.NEF', size: 1, tagged: true },
        [H('c')]: { path: '2014/05/c.jpg', size: 1, tagged: true },
        [H('d')]: { path: '2014/05/d.jpg', size: 1, tagged: true },
        [H('e')]: { path: '2016/07/e.HEIC', size: 1, tagged: true },
        [H('f')]: { path: '2016/07/f.jpg', size: 1, tagged: true },
        [H('9')]: { path: '2016/07/g.jpg', size: 1, tagged: true },
      },
      moments: {
        [MOMENT]: 'PicJot Tags/2015/08/Moment - Moved to Denver (3f2a9c).json',
        [TRIP]: 'PicJot Tags/2016/07/Moment - Lake trip (7b7b7b).json',
      },
    },
    'PicJot Tags/2012/06/a.jpg.json': tag(H('a'), { significance: 'timeline', caption: 'Summit', note: 'Private thoughts', tags: ['hiking'], creationTime: '2012-06-23T18:00:00.000Z' }),
    'PicJot Tags/2012/06/b.NEF.json': tag(H('b'), { significance: 'timeline', creationTime: '2012-06-23T19:00:00.000Z', timelineMain: true }),
    'PicJot Tags/2014/05/c.jpg.json': tag(H('c'), { significance: 'timeline', caption: 'Low tide', tags: ['beach'], creationTime: '2014-05-11T18:00:00.000Z' }),
    'PicJot Tags/2014/05/d.jpg.json': tag(H('d'), { significance: 'notable', caption: 'Sandcastle', creationTime: '2014-05-11T19:00:00.000Z' }),
    'PicJot Tags/2016/07/e.HEIC.json': tag(H('e'), { significance: 'timeline', caption: 'Pier', creationTime: '2016-07-02T18:00:00.000Z' }),
    'PicJot Tags/2016/07/f.jpg.json': tag(H('f'), { significance: 'timeline', caption: 'Canoe', tags: ['lake'], creationTime: '2016-07-03T18:00:00.000Z' }),
    'PicJot Tags/2016/07/g.jpg.json': tag(H('9'), { significance: 'timeline', caption: 'Campfire', tags: ['private'], creationTime: '2016-07-04T18:00:00.000Z' }),
    'PicJot Tags/2015/08/Moment - Moved to Denver (3f2a9c).json': { version: 2, kind: 'moment', id: MOMENT, title: 'Moved to Denver', date: '2015-08-21', note: 'A new start', tags: ['home'] },
    'PicJot Tags/2016/07/Moment - Lake trip (7b7b7b).json': { version: 2, kind: 'moment', id: TRIP, title: 'Lake trip', date: '2016-07-01', dateEnd: '2016-07-10' },
  });

// The data and scripts built into an exported page.
function partsOf(html) {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const data = JSON.parse(/^const DATA = (.*);$/m.exec(scripts[1])[1]);
  return { scripts, data };
}

// The exported page's own layout code, as its browser runs it.
function exportedViewOf(html) {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(partsOf(html).scripts[0], ctx);
  return ctx.PicJotTimeline.exportedView;
}

// Plain values (arrays made in the page's sandbox have its own prototypes).
const shape = (entries) => JSON.parse(JSON.stringify(entries.map((e) => [e.kind, e.date, e.title, e.photos.map((p) => p.hash)])));

test('the browser copy of the timeline rules is current', () => {
  assert.strictEqual(require('../lib/timeline-bundle'), browserScript(), 'run: node pc/lib/timeline-bundle-make.js');
});

test("an export holds what's shown: the search, Notable too and Do Not Show decide; nothing else gets in", () => {
  const to = backup();
  const all = timelineExport(to, { group: 'day', now: new Date(2026, 10, 22) });
  const { data } = partsOf(all.html);
  assert.deepStrictEqual(data.photos.map((p) => p.id).sort(), [H('9'), H('a'), H('b'), H('c'), H('e'), H('f')]);
  assert.deepStrictEqual(data.moments.map((m) => m.title).sort(), ['Lake trip', 'Moved to Denver']);
  assert.strictEqual(all.folder, 'Timeline 2026-11-22');
  assert.deepStrictEqual(all.counts, { photos: 6, moments: 2, heic: 1 });
  // HEIC: in the timeline without its picture (browsers on Windows can't read it).
  assert.ok(!all.photos.some((p) => p.hash === H('e')));
  assert.strictEqual(data.photos.find((p) => p.id === H('e')).img, false);
  assert.strictEqual(data.photos.find((p) => p.id === H('b')).img, true, 'RAW: its preview is copied');

  // Notable too; the search; this PC's Do Not Show list (not itself in the export).
  const notable = partsOf(timelineExport(to, { includeNotable: true }).html).data;
  assert.ok(notable.photos.some((p) => p.id === H('d')));
  const beach = partsOf(timelineExport(to, { search: 'beach' }).html).data;
  assert.deepStrictEqual(beach.photos.map((p) => p.id), [H('c')]);
  assert.deepStrictEqual(beach.moments, []);
  const hidden = timelineExport(to, { hide: ['private'] });
  assert.ok(!partsOf(hidden.html).data.photos.some((p) => p.id === H('9')));
  assert.doesNotMatch(hidden.html, /private/);
});

test('notes only when asked; never file names, folders or the backup', () => {
  const to = backup();
  const without = timelineExport(to, {});
  assert.doesNotMatch(without.html, /Private thoughts|A new start/);
  assert.ok(partsOf(without.html).data.photos.every((p) => p.note === ''));
  const withNotes = timelineExport(to, { notes: true });
  assert.match(withNotes.html, /Private thoughts/);
  assert.match(withNotes.html, /A new start/);
  for (const html of [without.html, withNotes.html]) {
    // The data and the page around it (the rules' own code is the same for everyone).
    const visible = html.replace(/<script>[\s\S]*?<\/script>/g, '');
    for (const text of [visible, partsOf(html).scripts[1]]) {
      assert.doesNotMatch(text, /a\.jpg|b\.NEF|e\.HEIC|2012\/06|PicJot Tags|\.photoapp|"path"/);
    }
    assert.match(html, /Made with <a href="https:\/\/picjot\.app">PicJot<\/a>/);
    assert.match(html, /<meta name="robots" content="noindex">/, 'search engines are asked not to list it');
  }
});

test('dates: a range, everything up to a latest date, or everything from a date on', () => {
  const to = backup();
  const ids = (ex) => partsOf(ex.html).data.photos.map((p) => p.id).sort();
  const titles = (ex) => partsOf(ex.html).data.moments.map((m) => m.title).sort();
  const from = timelineExport(to, { dateFrom: '2014-01-01' });
  assert.deepStrictEqual(ids(from), [H('9'), H('c'), H('e'), H('f')]);
  assert.deepStrictEqual(titles(from), ['Lake trip', 'Moved to Denver']);
  const until = timelineExport(to, { dateTo: '2014-12-31' });
  assert.deepStrictEqual(ids(until), [H('a'), H('b'), H('c')]);
  assert.deepStrictEqual(titles(until), []);
  // The lake trip (July 1–10, 2016) overlaps the range, and brings only its photo inside it.
  const range = timelineExport(to, { dateFrom: '2015-01-01', dateTo: '2016-07-02' });
  assert.deepStrictEqual(ids(range), [H('e')]);
  assert.deepStrictEqual(titles(range), ['Lake trip', 'Moved to Denver']);
  assert.deepStrictEqual(ids(timelineExport(to, { dateFrom: '2016-07-02', dateTo: '2015-01-01' })), [H('e')], 'either way round');
  assert.deepStrictEqual(exportCounts(to, { dateFrom: '2015-01-01', dateTo: '2016-07-02' }), { photos: 1, moments: 2 });
  assert.deepStrictEqual(exportCounts(to, { dateFrom: 'not a date' }), exportCounts(to, {}), 'a date that isn’t one limits nothing');

  // A photo dated only to a year is in when any of its year is.
  const year = backupWith({
    '.photoapp/index.json': { version: 1, photos: { [H('y')]: { path: '2015/01/y.jpg', size: 1, tagged: true } } },
    'PicJot Tags/2015/01/y.jpg.json': tag(H('y'), { significance: 'timeline', timelineDate: '2015', creationTime: '2026-01-10T18:00:00.000Z' }),
  });
  assert.deepStrictEqual(exportCounts(year, { dateFrom: '2015-06-01', dateTo: '2015-06-30' }), { photos: 1, moments: 0 });
  assert.deepStrictEqual(exportCounts(year, { dateFrom: '2016-01-01' }), { photos: 0, moments: 0 });
});

test('Highlights: only each entry’s main photo, in the view exported', () => {
  const to = backup();
  const day = partsOf(timelineExport(to, { group: 'day', highlights: true }).html).data;
  // June 23, 2012 keeps its chosen main photo (b), not a.
  assert.ok(day.photos.some((p) => p.id === H('b')));
  assert.ok(!day.photos.some((p) => p.id === H('a')));
  // The lake trip (a Moment over July 1–10, 2016) keeps one of its three.
  assert.strictEqual(day.photos.filter((p) => [H('e'), H('f'), H('9')].includes(p.id)).length, 1);
});

test('a title of its own, safe in the page and as a folder name', () => {
  const to = backup();
  const ex = timelineExport(to, { title: 'Hiking <with> "Marni": 2012/2016?', now: new Date(2026, 10, 22) });
  assert.match(ex.html, /<title>Hiking &lt;with&gt; &quot;Marni&quot;: 2012\/2016\?<\/title>/);
  assert.strictEqual(ex.folder, 'Hiking with Marni 2012 2016 2026-11-22');
});

test('both pages’ scripts are valid JavaScript', () => {
  const to = backup();
  for (const html of [timelinePage('PicJot', 'tok'), timelineExport(to, { notes: true }).html]) {
    for (const [, src] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
      assert.doesNotThrow(() => new vm.Script(src), src.slice(0, 80));
    }
  }
});

test("the exported page lays it out as the PC's page does, in every view and with a search", () => {
  const to = backup();
  for (const group of ['day', 'week', 'month']) {
    for (const includeNotable of [false, true]) {
      const ex = timelineExport(to, { group, includeNotable, hide: ['private'] });
      const view = exportedViewOf(ex.html);
      const { data } = partsOf(ex.html);
      // As exported, and switched to the other views on the exported page.
      for (const g of ['day', 'week', 'month']) {
        const pc = timelineData(to, { group: g, includeNotable, hide: ['private'] });
        assert.deepStrictEqual(shape(view(data, { group: g })), shape(pc.entries), `${group} export, ${g} view, notable ${includeNotable}`);
      }
      const found = timelineData(to, { group, includeNotable, hide: ['private'], search: 'lake' });
      assert.deepStrictEqual(shape(view(data, { group, search: 'lake' })), shape(found.entries));
    }
  }
});
