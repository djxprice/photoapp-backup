'use strict';
const test = require('node:test');
const assert = require('node:assert');

const {
  parseWhen,
  inSpan,
  whenText,
  whenLabel,
  spanLabel,
  photoWhen,
  pickMain,
  gapLabel,
  buildTimeline,
  entryYear,
  isMomentRecord,
  safeName,
  momentPathFor,
} = require('../lib/timeline');

const local = (y, m, d, h = 12) => new Date(y, m - 1, d, h).getTime();

test('reads dates: a year, a month, a day, a time; refuses impossible ones', () => {
  assert.deepStrictEqual(parseWhen('2012'), { y: 2012, m: null, d: null, precision: 'year' });
  assert.deepStrictEqual(parseWhen('2012-06'), { y: 2012, m: 6, d: null, precision: 'month' });
  assert.deepStrictEqual(parseWhen('2012-06-23'), { y: 2012, m: 6, d: 23, precision: 'day' });
  assert.deepStrictEqual(parseWhen(local(2012, 6, 23, 23)), { y: 2012, m: 6, d: 23, precision: 'day' }, 'local time');
  assert.deepStrictEqual(parseWhen(new Date(local(2012, 6, 23)).toISOString()), { y: 2012, m: 6, d: 23, precision: 'day' });
  for (const bad of ['2013-02-30', '2012-13', '12', '', null, undefined, 'soon']) assert.strictEqual(parseWhen(bad), null, String(bad));
  assert.strictEqual(whenText(parseWhen('2012-06')), '2012-06');
  assert.strictEqual(whenText(parseWhen(local(2012, 6, 3))), '2012-06-03');
});

test('labels dates and spans', () => {
  assert.strictEqual(whenLabel(parseWhen('2012-06-23')), 'June 23, 2012');
  assert.strictEqual(whenLabel(parseWhen('2012-06')), 'June 2012');
  assert.strictEqual(whenLabel(parseWhen('2012')), '2012');
  const s = (a, b) => spanLabel(parseWhen(a), parseWhen(b));
  assert.strictEqual(s('2012-06-03', '2012-06-10'), 'June 3–10, 2012');
  assert.strictEqual(s('2012-06-28', '2012-07-03'), 'June 28 – July 3, 2012');
  assert.strictEqual(s('2012-12-30', '2013-01-02'), 'December 30, 2012 – January 2, 2013');
  assert.strictEqual(s('2012-06', '2012-08'), 'June – August 2012');
  assert.strictEqual(s('2012-06-03', '2012-06-03'), 'June 3, 2012');
  assert.strictEqual(spanLabel(parseWhen('2012-06-03'), null), 'June 3, 2012');
});

test("a photo's date: its timeline date, else when taken; month-only; undated ones have none", () => {
  const taken = local(2026, 10, 1);
  assert.strictEqual(whenText(photoWhen({ creationTime: taken })), '2026-10-01');
  assert.strictEqual(whenText(photoWhen({ creationTime: taken, timelineDate: '1987-07' })), '1987-07', 'a scanned print');
  assert.strictEqual(whenText(photoWhen({ creationTime: local(2009, 7, 15), monthOnly: true })), '2009-07');
  assert.strictEqual(photoWhen({ creationTime: taken, undated: true }), null, 'only the time it was saved');
  assert.strictEqual(whenText(photoWhen({ creationTime: taken, undated: true, timelineDate: '1990' })), '1990');
  assert.strictEqual(photoWhen({}), null);
});

test("a day's main photo: the one chosen (the newest choice), else Timeline, a note, a caption; ties to the earliest", () => {
  const a = { id: 'a', significance: 'timeline', creationTime: local(2012, 6, 23, 9) };
  const b = { id: 'b', significance: 'timeline', note: 'the view', creationTime: local(2012, 6, 23, 10) };
  const c = { id: 'c', significance: 'notable', note: 'x', caption: 'y', creationTime: local(2012, 6, 23, 8) };
  const d = { id: 'd', significance: 'timeline', creationTime: local(2012, 6, 23, 7) };
  assert.strictEqual(pickMain([a, b, c]).id, 'b', 'a note beats a caption-less Timeline photo; Timeline beats Notable');
  assert.strictEqual(pickMain([a, d]).id, 'd', 'a tie: the earliest');
  const chosenOld = { ...a, timelineMain: true, updatedAt: '2026-10-01T00:00:00Z' };
  const chosenNew = { ...d, timelineMain: true, updatedAt: '2026-10-02T00:00:00Z' };
  assert.strictEqual(pickMain([chosenOld, b, chosenNew]).id, 'd');
});

test('a span takes in whole days, months or years', () => {
  const w = parseWhen;
  assert.ok(inSpan(w('2012-06-10'), w('2012-06-03'), w('2012-06-10')));
  assert.ok(!inSpan(w('2012-06-11'), w('2012-06-03'), w('2012-06-10')));
  assert.ok(inSpan(w('2012-08-31'), w('2012-06'), w('2012-08')));
  assert.ok(inSpan(w('2013-12-31'), w('2012'), w('2013')));
  assert.ok(!inSpan(w('2012-06'), w('2012-06'), w('2012-08')), 'only day-dated photos join');
});

test('gaps: none under six months, then months, then years', () => {
  const g = (a, b) => gapLabel(parseWhen(a), parseWhen(b));
  assert.strictEqual(g('2012-01-01', '2012-05-30'), null);
  assert.strictEqual(g('2012-01-01', '2012-09-01'), '8 months');
  assert.strictEqual(g('2012-01-01', '2013-03-01'), '1 year');
  assert.strictEqual(g('2010-06', '2013-01-01'), '2 years');
});

test('the timeline: Timeline photos by day, newest first, Notable on request, undated left off', () => {
  const p = (id, y, m, d, extra = {}) => ({ id, significance: 'timeline', creationTime: local(y, m, d), ...extra });
  const photos = [
    p('a', 2012, 6, 23),
    p('b', 2012, 6, 23, { caption: 'Summit', creationTime: local(2012, 6, 23, 15) }),
    p('c', 2014, 5, 11),
    p('n', 2014, 5, 11, { significance: 'notable' }),
    p('t', 2013, 1, 1, { significance: null, caption: 'tagged only' }),
    p('u', 2013, 1, 1, { undated: true }),
    p('m', 2012, 6, 15, { monthOnly: true }),
    p('s', 2026, 10, 1, { timelineDate: '1987' }),
  ];
  const t = buildTimeline(photos, []);
  assert.deepStrictEqual(t.map((e) => e.key), ['2014-05-11', '2012-06-23', '2012-06', '1987']);
  assert.strictEqual(t[1].main.id, 'b', 'the captioned one leads the day');
  assert.deepStrictEqual(t[1].photos.map((x) => x.id), ['b', 'a']);
  assert.deepStrictEqual(t[0].photos.map((x) => x.id), ['c'], 'Notable left out');
  assert.deepStrictEqual(t.map((e) => e.gap), ['1 year', null, '25 years', null]);
  assert.strictEqual(entryYear(t[3]), 1987);
  const withNotable = buildTimeline(photos, [], { includeNotable: true });
  assert.deepStrictEqual(withNotable[0].photos.map((x) => x.id), ['c', 'n']);
});

test('Moments: on their date, above photos of the same day; one with an end date gathers its photos', () => {
  const p = (id, y, m, d, extra = {}) => ({ id, significance: 'timeline', creationTime: local(y, m, d), tags: [], ...extra });
  const photos = [
    p('rome', 2012, 6, 4, { tags: ['Italy'] }),
    p('venice', 2012, 6, 9, { tags: ['italy'], note: 'gondola' }),
    p('home', 2012, 6, 5, { tags: ['home'] }),
    p('after', 2012, 6, 11, { tags: ['italy'] }),
    p('denver', 2015, 8, 21),
  ];
  const moments = [
    { id: 'a'.repeat(32), title: 'Italy', date: '2012-06-03', dateEnd: '2012-06-10', spanTag: 'italy' },
    { id: 'b'.repeat(32), title: 'Moved to Denver', date: '2015-08-21' },
    { id: 'c'.repeat(32), title: 'Started at Acme', date: '2014' },
  ];
  const t = buildTimeline(photos, moments);
  assert.deepStrictEqual(
    t.map((e) => e.key),
    [`moment:${'b'.repeat(32)}`, '2015-08-21', `moment:${'c'.repeat(32)}`, '2012-06-11', `moment:${'a'.repeat(32)}`, '2012-06-05']
  );
  const italy = t[4];
  assert.deepStrictEqual(italy.photos.map((x) => x.id), ['venice', 'rome'], 'its tagged photos, the noted one first');
  assert.strictEqual(italy.main.id, 'venice');
  assert.strictEqual(spanLabel(italy.when, italy.end), 'June 3–10, 2012');
  assert.strictEqual(t[0].main, null, 'a Moment without photos');
  const untagged = buildTimeline(photos, [{ ...moments[0], spanTag: '' }]);
  assert.deepStrictEqual(untagged.find((e) => e.kind === 'moment').photos.map((x) => x.id).sort(), ['home', 'rome', 'venice']);
  const summer = buildTimeline(photos, [{ id: 'e'.repeat(32), title: 'Summer', date: '2012-06', dateEnd: '2012-07' }]);
  assert.deepStrictEqual(summer.map((e) => e.key), ['2015-08-21', `moment:${'e'.repeat(32)}`], 'a span to the month takes in whole months');
  assert.strictEqual(summer[1].photos.length, 4);
  const backwards = buildTimeline([], [{ id: 'd'.repeat(32), title: 'x', date: '2012-06-10', dateEnd: '2012-06-01' }]);
  assert.strictEqual(backwards[0].end, null, 'an end before the start is ignored');
});

test("a Moment's record and its file in a backup", () => {
  const id = '3f2a9c'.padEnd(32, '0');
  assert.ok(isMomentRecord({ kind: 'moment', id }));
  assert.ok(!isMomentRecord({ kind: 'moment', id: 'x' }));
  assert.ok(!isMomentRecord({ contentHash: id }));
  assert.strictEqual(momentPathFor({ id, title: 'Moved to Denver', date: '2015-08-21' }), 'PicJot Tags/2015/08/Moment - Moved to Denver (3f2a9c).json');
  assert.strictEqual(momentPathFor({ id, title: 'Started: "Acme"?', date: '2014' }), 'PicJot Tags/2014/Moment - Started Acme (3f2a9c).json');
  assert.strictEqual(safeName('  a/b\\c.. '), 'a b c');
  assert.strictEqual(safeName('x'.repeat(80)).length, 60);
  assert.strictEqual(safeName('???'), 'Moment');
});

const {
  buildTimelineView,
  entryLabel,
  MAIN_FIELD,
  cleanHideList,
  hasTerm,
  wordsOf,
} = require('../lib/timeline');

test('Week and Month views: a card per week (Sunday to Saturday) or month; Moments stay their own', () => {
  const p = (id, y, m, d, extra = {}) => ({ id, significance: 'timeline', creationTime: local(y, m, d), tags: [], ...extra });
  const photos = [
    p('fri', 2026, 10, 23),
    p('sun', 2026, 10, 18, { caption: 'Pumpkins' }),
    p('sat', 2026, 10, 17),
    p('oct1', 2026, 10, 1),
    p('nye', 2025, 12, 31),
    p('ny', 2026, 1, 1),
    p('jul4', 1987, 7, 4),
    p('print', 2026, 3, 3, { timelineDate: '1987-07' }),
    p('old', 2026, 3, 3, { timelineDate: '1980' }),
  ];
  const moved = `moment:${'a'.repeat(32)}`;
  const moments = [{ id: 'a'.repeat(32), title: 'Moved', date: '2026-10-20' }];

  const week = buildTimeline(photos, moments, { group: 'week' });
  assert.deepStrictEqual(week.map((e) => e.key), [
    'week:2026-10-18', moved, 'week:2026-10-11', 'week:2026-09-27', 'week:2025-12-28', 'week:1987-06-28', '1987-07', '1980',
  ]);
  assert.deepStrictEqual(week.map(entryLabel), [
    'October 18–24, 2026',
    'October 20, 2026',
    'October 11–17, 2026',
    'September 27 – October 3, 2026',
    'December 28, 2025 – January 3, 2026',
    'June 28 – July 4, 1987',
    'July 1987',
    '1980',
  ]);
  assert.deepStrictEqual(week[0].photos.map((x) => x.id), ['sun', 'fri'], 'the captioned one leads');
  assert.strictEqual(entryYear(week[4]), 2026, "a week across New Year: its newest photo's year");
  assert.deepStrictEqual(week.map((e) => e.level), ['week', 'day', 'week', 'week', 'week', 'week', 'day', 'day']);

  const month = buildTimeline(photos, moments, { group: 'month' });
  assert.deepStrictEqual(month.map((e) => e.key), ['month:2026-10', moved, 'month:2026-01', 'month:2025-12', 'month:1987-07', '1980']);
  assert.deepStrictEqual(month.map(entryLabel), ['October 2026', 'October 20, 2026', 'January 2026', 'December 2025', 'July 1987', '1980']);
  assert.deepStrictEqual(month[0].photos.map((x) => x.id), ['sun', 'oct1', 'sat', 'fri']);
  assert.deepStrictEqual(month[4].photos.map((x) => x.id).sort(), ['jul4', 'print'], 'a month-dated photo joins its month');
  assert.deepStrictEqual(month.map((e) => e.gap), [null, '9 months', null, '38 years', '7 years', null]);

  assert.deepStrictEqual(buildTimeline(photos, moments, { group: 'year' }), buildTimeline(photos, moments), 'an unknown view is the Day view');
});

test("Make Main Photo belongs to its view: a month's choice leaves its days' alone", () => {
  const p = (id, d, extra = {}) => ({ id, significance: 'timeline', creationTime: local(2026, 10, d), ...extra });
  const photos = [
    p('a', 5, { timelineMain: true, updatedAt: '2026-10-20T00:00:00Z' }),
    p('b', 5),
    p('c', 6, { note: 'the best' }),
    p('d', 20, { timelineMain: true, updatedAt: '2026-10-21T00:00:00Z' }),
    p('e', 20, { timelineMainMonth: true, updatedAt: '2026-10-01T00:00:00Z' }),
  ];
  const mains = (group) => Object.fromEntries(buildTimeline(photos, [], { group }).map((e) => [e.key, e.main.id]));
  assert.deepStrictEqual(mains('day'), { '2026-10-20': 'd', '2026-10-06': 'c', '2026-10-05': 'a' });
  assert.deepStrictEqual(mains('month'), { 'month:2026-10': 'e' }, "the month's own choice, though older than a day's");
  assert.deepStrictEqual(mains('week'), { 'week:2026-10-18': 'd', 'week:2026-10-04': 'a' }, "no week's choice: its days' choices");
  const weekChosen = [photos[0], { ...photos[1], timelineMainWeek: true }, photos[2]];
  assert.strictEqual(pickMain(weekChosen, 'month').id, 'b', "a month: its weeks' choices before its days'");
  assert.strictEqual(pickMain(weekChosen, 'week').id, 'b');
  assert.strictEqual(pickMain(weekChosen).id, 'a', 'the Day view as before');
  assert.deepStrictEqual(MAIN_FIELD, { day: 'timelineMain', week: 'timelineMainWeek', month: 'timelineMainMonth' });
});

test('Search: every word, in captions, tags and notes; a card keeps only its matching photos', () => {
  const p = (id, d, extra = {}) => ({ id, significance: 'timeline', creationTime: local(2019, 12, d), tags: [], ...extra });
  const photos = [
    p('tree', 24, { caption: 'The Christmas tree', tags: ['Family'] }),
    p('cafe', 24, { note: 'Lunch at the Café' }),
    p('beach', 26, { tags: ['beaches', 'family'] }),
  ];
  const trip = `moment:${'a'.repeat(32)}`;
  const job = `moment:${'b'.repeat(32)}`;
  const moments = [
    { id: 'a'.repeat(32), title: 'Family trip', date: '2019-12-25', dateEnd: '2019-12-27', tags: [] },
    { id: 'b'.repeat(32), title: 'New job', note: '', date: '2019-11-01', tags: ['work'] },
  ];
  const find = (search, group) =>
    buildTimeline(photos, moments, { search, group }).map((e) => [e.key, e.photos.map((x) => x.id).join(',')]);
  assert.deepStrictEqual(find(''), [[trip, 'beach'], ['2019-12-24', 'cafe,tree'], [job, '']]);
  assert.deepStrictEqual(find('family'), [[trip, 'beach'], ['2019-12-24', 'tree']], 'a card keeps only its matches');
  assert.deepStrictEqual(find('#FAMILY tree'), [['2019-12-24', 'tree']], 'every word; # and case ignored');
  assert.deepStrictEqual(find('cafe'), [['2019-12-24', 'cafe']], 'accents ignored; a Moment with no match is left off');
  assert.deepStrictEqual(find('beach'), [[trip, 'beach']], 'part of a word; a Moment shows its matching photos');
  assert.deepStrictEqual(find('trip'), [[trip, 'beach']], 'a Moment whose own text matches keeps all its photos');
  assert.deepStrictEqual(find('christmas 2019'), [['2019-12-24', 'tree']], 'a year matches the date');
  assert.deepStrictEqual(find('christmas 2018'), []);
  assert.deepStrictEqual(find('work'), [[job, '']], "a Moment's tags");
  assert.deepStrictEqual(find('family', 'month'), [[trip, 'beach'], ['month:2019-12', 'tree']]);
});

test('Do Not Show: whole words, tags and notes; a hidden Moment takes its photos; it wins over Search', () => {
  const p = (id, d, extra = {}) => ({ id, significance: 'timeline', creationTime: local(2019, 6, d), tags: [], ...extra });
  const photos = [
    p('party', 1, { caption: 'Birthday party' }),
    p('art', 2, { caption: 'Art fair', tags: ['Family'] }),
    p('work', 3, { tags: ['Work trip'] }),
    p('ny', 4, { note: 'Trip to New York!' }),
    p('york', 5, { caption: 'York Minster' }),
    p('inspan', 10),
    p('cafe', 14, { caption: 'Café du Monde' }),
  ];
  const moments = [
    { id: 'a'.repeat(32), title: 'Job interview', note: 'for work', date: '2019-06-09', dateEnd: '2019-06-11', tags: [] },
    { id: 'b'.repeat(32), title: 'Graduation', date: '2019-06-20', tags: [] },
  ];
  const shown = (opts) => {
    const v = buildTimelineView(photos, moments, opts);
    return { shown: v.entries.flatMap((e) => (e.kind === 'moment' ? [e.moment.title] : e.photos.map((x) => x.id))), hidden: v.hidden };
  };
  const all = ['Graduation', 'cafe', 'Job interview', 'york', 'ny', 'work', 'art', 'party'];
  const without = (...ids) => all.filter((x) => !ids.includes(x));
  assert.deepStrictEqual(shown({}), { shown: all, hidden: { photos: 0, moments: 0 } });
  assert.deepStrictEqual(shown({ hide: ['art'] }).shown, without('art'), '"art" is not in "party"');
  assert.deepStrictEqual(
    shown({ hide: ['WORK'] }),
    { shown: without('Job interview', 'work'), hidden: { photos: 2, moments: 1 } },
    'a tag, and a Moment with the photos it gathers'
  );
  assert.deepStrictEqual(shown({ hide: ['new york'] }).shown, without('ny'), 'a phrase: whole words in a row');
  assert.deepStrictEqual(shown({ hide: ['York'] }).shown, without('ny', 'york'));
  assert.deepStrictEqual(shown({ hide: ['cafe', '#family'] }).shown, without('cafe', 'art'), 'accents and # ignored');
  assert.deepStrictEqual(shown({ hide: ['family'], search: 'fair' }).shown, [], 'Do Not Show wins over Search');
});

test('the Do Not Show list: kept clean; whole words in a row', () => {
  assert.deepStrictEqual(cleanHideList(['  #Work ', 'work', 'WORK', '', null, 'New   York', 'café', 'cafe', '#']), ['Work', 'New York', 'café']);
  assert.deepStrictEqual(cleanHideList('work'), []);
  assert.deepStrictEqual(wordsOf("Mom's party, 2019!"), ['mom', 's', 'party', '2019']);
  assert.ok(hasTerm(['Trip to New York!'], [['new', 'york']]));
  assert.ok(!hasTerm(['New and old York'], [['new', 'york']]));
  assert.ok(!hasTerm(['anything'], []));
});
