'use strict';
// The timeline's rules (roadmap Step 26), shared by the phone (Revisit
// Memories → Timeline) and the PC's timeline page, so both show the same
// entries: which photos, their dates, the order, each day's main photo, and
// Moments (entries without a photo; with an end date, an event spanning days
// that gathers that range's photos). Pure: no filesystem, no Node modules
// (the app imports it, as it does plan.js).
//
// Dates ("when") are { y, m, d, precision }: precision 'day', 'month' or
// 'year' (m and d null when unknown). A photo's date is its timelineDate if
// set ("YYYY", "YYYY-MM" or "YYYY-MM-DD": e.g. a scan of a 1987 print), else
// when it was taken (local time); an old photo with only a month is
// month-precise; a photo with no date at all (`undated`) isn't on the
// timeline.

const { TAG_FOLDER } = require('./plan');

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const DATE_TEXT = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;

function valid(y, m, d) {
  if (!(y >= 1800 && y <= 2200)) return false;
  if (m == null) return d == null;
  if (!(m >= 1 && m <= 12)) return false;
  if (d == null) return true;
  return d >= 1 && d <= new Date(y, m, 0).getDate();
}

// "2012", "2012-06", "2012-06-23", an ISO time ("2012-06-23T17:30:00Z") or
// milliseconds -> a when, or null. Times are read in local time.
function parseWhen(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'string') {
    const m = DATE_TEXT.exec(value.trim());
    if (m) {
      const y = Number(m[1]);
      const mo = m[2] ? Number(m[2]) : null;
      const d = m[3] ? Number(m[3]) : null;
      if (!valid(y, mo, d)) return null;
      return { y, m: mo, d, precision: d ? 'day' : mo ? 'month' : 'year' };
    }
  }
  // Otherwise only a full ISO time ("2012-06-23T17:30:00Z") or milliseconds:
  // Date.parse would take "12" for December 2001.
  if (typeof value === 'string' && !/^\d{4}-\d{2}-\d{2}T/.test(value.trim())) return null;
  const t = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(t)) return null;
  const date = new Date(t);
  const y = date.getFullYear();
  if (!valid(y, 1, null)) return null;
  return { y, m: date.getMonth() + 1, d: date.getDate(), precision: 'day' };
}

// A when as stored: "YYYY", "YYYY-MM" or "YYYY-MM-DD".
function whenText(w) {
  if (!w) return null;
  const two = (n) => String(n).padStart(2, '0');
  if (w.precision === 'year') return String(w.y);
  if (w.precision === 'month') return `${w.y}-${two(w.m)}`;
  return `${w.y}-${two(w.m)}-${two(w.d)}`;
}

// For ordering: a day sorts within its month, a month-only date before the
// month's days, a year-only one before the year's months.
const sortKey = (w) => w.y * 10000 + (w.m || 0) * 100 + (w.d || 0);

// The first and last day a date covers ("June 2012": June 1 to 30), as
// sort keys: what a span's start and end take in.
const firstDay = (w) => w.y * 10000 + (w.m || 1) * 100 + (w.d || 1);
const lastDay = (w) => w.y * 10000 + (w.m || 12) * 100 + (w.d || new Date(w.y, w.m || 12, 0).getDate());

// Is a day-dated `when` within a span from `start` to `end` (whens)?
const inSpan = (when, start, end) =>
  Boolean(when && start && end && when.precision === 'day') &&
  sortKey(when) >= firstDay(start) &&
  sortKey(when) <= lastDay(end);

// "June 23, 2012", "June 2012", "2012".
function whenLabel(w) {
  if (!w) return '';
  if (w.precision === 'year') return String(w.y);
  if (w.precision === 'month') return `${MONTHS[w.m - 1]} ${w.y}`;
  return `${MONTHS[w.m - 1]} ${w.d}, ${w.y}`;
}

// A span: "June 3–10, 2012", "June 28 – July 3, 2012",
// "December 30, 2012 – January 2, 2013", or a single label when start and
// end are the same.
function spanLabel(start, end) {
  if (!end || whenText(start) === whenText(end)) return whenLabel(start);
  if (start.precision === 'day' && end.precision === 'day' && start.y === end.y) {
    if (start.m === end.m) return `${MONTHS[start.m - 1]} ${start.d}–${end.d}, ${start.y}`;
    return `${MONTHS[start.m - 1]} ${start.d} – ${MONTHS[end.m - 1]} ${end.d}, ${start.y}`;
  }
  if (start.precision === 'month' && end.precision === 'month' && start.y === end.y) {
    return `${MONTHS[start.m - 1]} – ${MONTHS[end.m - 1]} ${start.y}`;
  }
  return `${whenLabel(start)} – ${whenLabel(end)}`;
}

// 'notable' or 'timeline' (an old 'important' is notable), else null.
function markOf(s) {
  if (s === 'notable' || s === 'important') return 'notable';
  return s === 'timeline' ? 'timeline' : null;
}

// A photo's date on the timeline, or null (undated, or no usable date).
function photoWhen(p) {
  if (!p) return null;
  const set = parseWhen(p.timelineDate);
  if (set) return set;
  if (p.undated) return null;
  const taken = parseWhen(p.creationTime);
  if (!taken) return null;
  return p.monthOnly ? { y: taken.y, m: taken.m, d: null, precision: 'month' } : taken;
}

const lowerTags = (tags) => (Array.isArray(tags) ? tags : []).map((t) => String(t).toLowerCase());
const hasText = (s) => typeof s === 'string' && s.trim().length > 0;
const timeOf = (v) => {
  const t = typeof v === 'number' ? v : Date.parse(v || '');
  return Number.isFinite(t) ? t : Infinity;
};

// Higher is a better main photo: Timeline over Notable, then a note, then a
// caption. No randomness, so a day's main photo never changes by itself.
function photoScore(p) {
  return (markOf(p.significance) === 'timeline' ? 5 : 2) + (hasText(p.note) ? 3 : 0) + (hasText(p.caption) ? 1 : 0);
}

// 'Make Main Photo' is made in a view: a day's (a span's too), a week's or a
// month's, each its own field, so choosing a month's main photo leaves its
// days' alone.
const MAIN_FIELD = { day: 'timelineMain', week: 'timelineMainWeek', month: 'timelineMainMonth' };
// Where a group without its own choice looks next: a finer view's choices.
const MAIN_FALLBACK = { day: [], week: ['timelineMain'], month: ['timelineMainWeek', 'timelineMain'] };

const bestScored = (photos) =>
  [...photos].sort(
    (a, b) =>
      photoScore(b) - photoScore(a) ||
      timeOf(a.creationTime) - timeOf(b.creationTime) ||
      String(a.id).localeCompare(String(b.id))
  )[0];

// The photo the user chose for this group in its view (the newest choice
// wins), else the best scored of those chosen in a finer view (a month: its
// weeks', then its days'), else the best scored; ties go to the earliest
// taken, then the id.
function pickMain(photos, level = 'day') {
  const own = MAIN_FIELD[level] || MAIN_FIELD.day;
  const chosen = photos.filter((p) => p[own]);
  if (chosen.length) {
    return chosen.reduce((a, b) => (String(b.updatedAt || '') > String(a.updatedAt || '') ? b : a));
  }
  for (const field of MAIN_FALLBACK[level] || []) {
    const finer = photos.filter((p) => p[field]);
    if (finer.length) return bestScored(finer);
  }
  return bestScored(photos);
}

// The main photo first, then the others in the order taken.
function orderGroup(photos, level = 'day') {
  const main = pickMain(photos, level);
  const rest = photos
    .filter((p) => p !== main)
    .sort((a, b) => timeOf(a.creationTime) - timeOf(b.creationTime) || String(a.id).localeCompare(String(b.id)));
  return { main, photos: [main, ...rest] };
}

// Whole months between two dates (the newer minus the older).
const monthsBetween = (older, newer) => (newer.y - older.y) * 12 + ((newer.m || 1) - (older.m || 1));

// The gap shown between an entry and the next older one: "2 years",
// "8 months", or null for less than six months.
function gapLabel(older, newer) {
  const months = monthsBetween(older, newer);
  if (months >= 24) return `${Math.floor(months / 12)} years`;
  if (months >= 12) return '1 year';
  if (months >= 6) return `${months} months`;
  return null;
}

// ── Search and Do Not Show ──

// Lower case with accents removed, so "Café" matches "cafe".
function foldText(s) {
  const lower = String(s || '').toLowerCase();
  try {
    return lower.normalize('NFD').replace(/[̀-ͯ]/g, '');
  } catch {
    return lower;
  }
}

// "  Beach #Mum " -> ['beach', 'mum']: a leading # is dropped, so "#mum"
// finds the tag mum.
function queryWords(query) {
  return foldText(query)
    .split(/\s+/)
    .map((w) => w.replace(/^#+/, ''))
    .filter(Boolean);
}

// A text's whole words, folded: spaces and punctuation separate them
// ("Mom's party, 2019!" -> mom, s, party, 2019); letters of any alphabet stay.
const WORD_GAP = /[\s.,;:!?¡¿"'`´‘’“”«»()[\]{}<>/\\|@#$%^&*+=~_–—…-]+/;
const wordsOf = (text) => foldText(text).split(WORD_GAP).filter(Boolean);

const tagList = (tags) => (Array.isArray(tags) ? tags : String(tags || '').split(',')).map((t) => String(t).trim()).filter(Boolean);

// The Do Not Show list as kept: trimmed, without a leading #, no repeats
// (any case or accents), in the order added.
function cleanHideList(list) {
  const out = [];
  const seen = new Set();
  for (const t of Array.isArray(list) ? list : []) {
    const clean = String(t == null ? '' : t).replace(/^\s*#+/, '').replace(/\s+/g, ' ').trim();
    const key = wordsOf(clean).join(' ');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

// Is one of `terms` (each a list of words) in one of the texts, as whole
// words in a row? "art" isn't in "party"; "new york" is in "Trip to New
// York!". Each text is looked at on its own (a caption, a note, one tag).
function hasTerm(texts, terms) {
  if (!terms.length) return false;
  for (const text of texts) {
    const words = wordsOf(text);
    for (const term of terms) {
      for (let i = 0; i + term.length <= words.length; i++) {
        if (term.every((t, j) => words[i + j] === t)) return true;
      }
    }
  }
  return false;
}

// Does the text hold every search word (anywhere, so "beach" also finds
// "beaches")? A word that is a year (1800–2199) also matches a date within
// `years` ([first, last]), so "christmas 2019" works. As Find (src/lib/find.js).
function matchesWords(texts, words, years) {
  if (!words.length) return true;
  const text = foldText(texts.join(' '));
  return words.every((w) => text.includes(w) || (/^(18|19|20|21)\d\d$/.test(w) && years && Number(w) >= years[0] && Number(w) <= years[1]));
}

const photoTexts = (p) => [p.caption, p.note, ...tagList(p.tags)];
const momentTexts = (m) => [m.title, m.note, ...tagList(m.tags)];

// ── The timeline ──

const GROUPS = ['day', 'week', 'month'];

// The Sunday a week starts on and its Saturday, as whens.
function weekOf(w) {
  const at = new Date(w.y, w.m - 1, w.d);
  const start = new Date(w.y, w.m - 1, w.d - at.getDay());
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
  const when = (d) => ({ y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate(), precision: 'day' });
  return { start: when(start), end: when(end) };
}

// Which card a photo's date goes on in a view: { key, kind, when, end }.
// A week takes day-dated photos, a month day- and month-dated ones; others
// keep a card of their own date, as in the Day view.
function groupOf(when, group) {
  if (group === 'week' && when.precision === 'day') {
    const { start, end } = weekOf(when);
    return { key: `week:${whenText(start)}`, kind: 'week', when: start, end };
  }
  if (group === 'month' && when.precision !== 'year') {
    const month = { y: when.y, m: when.m, d: null, precision: 'month' };
    return { key: `month:${whenText(month)}`, kind: 'month', when: month, end: null };
  }
  return { key: whenText(when), kind: 'day', when, end: null };
}

// The timeline as shown, newest first. `photos`: [{ id, significance,
// timelineDate, creationTime, monthOnly, undated, caption, note, tags,
// timelineMain, timelineMainWeek, timelineMainMonth, updatedAt, ... }]
// (anything else is passed through); `moments`: [{ id, title, note, tags,
// date, dateEnd, spanTag, ... }]. Timeline photos are on it, Notable ones
// too with `includeNotable`. Options:
//   group    'day' | 'week' | 'month': what a card holds
//   search   words a photo or Moment must all hold (caption, tags, note; a
//            Moment's title, note, tags); a card keeps only its matching
//            photos, a Moment whose own text matches keeps all of its
//   hide     the Do Not Show list (the phone and the PC each have their
//            own): anything with one of its terms (whole words) is left
//            off, a Moment with all the photos it gathers; it wins over
//            search.
// Returns { entries, hidden: { photos, moments } } (what Do Not Show left
// off, before any search). Entries:
//   { kind: 'day', key, when, main, photos, gap, year, level }  one date
//   { kind: 'week' | 'month', key, when, end, ... }              a week or month
//   { kind: 'moment', key, when, end, moment, main, photos, ... }
// A Moment with an end date takes the photos dated within it (only those
// tagged `spanTag`, if it has one); `main` is null for a Moment without
// photos. `gap` is the label for the gap to the next (older) entry, or null;
// `year` the year it's listed under; `level` the view its main photo is
// chosen in ('day' for a Moment: it's the same in every view).
function buildTimelineView(photos, moments, { includeNotable = false, group = 'day', search = '', hide = [] } = {}) {
  const view = GROUPS.includes(group) ? group : 'day';
  const words = queryWords(search);
  const terms = cleanHideList(hide).map(wordsOf);
  const hidden = { photos: 0, moments: 0 };

  const onIt = (photos || [])
    .map((p) => ({ p, when: photoWhen(p) }))
    .filter(({ p, when }) => when && (markOf(p.significance) === 'timeline' || (includeNotable && markOf(p.significance))));

  const ms = (moments || [])
    .map((m) => {
      const when = parseWhen(m.date);
      let end = parseWhen(m.dateEnd);
      if (when && end && sortKey(end) < sortKey(when)) end = null;
      return when ? { m, when, end, photos: [], hidden: hasTerm(momentTexts(m), terms) } : null;
    })
    .filter(Boolean);
  // A day photo inside a span joins it (a span to the month or year takes
  // in whole months or years); when spans overlap, the one that started
  // latest (the more specific one) takes it. A hidden span's photos are
  // hidden with it.
  const spans = ms
    .filter((x) => x.end)
    .map((x) => ({ x, from: firstDay(x.when), to: lastDay(x.end) }))
    .sort((a, b) => b.from - a.from);

  const loose = [];
  for (const item of onIt) {
    const { p, when } = item;
    let span = null;
    if (when.precision === 'day') {
      const tags = lowerTags(p.tags);
      span = spans.find(
        (s) => inSpan(when, s.x.when, s.x.end) && (!hasText(s.x.m.spanTag) || tags.includes(s.x.m.spanTag.trim().toLowerCase()))
      );
    }
    if ((span && span.x.hidden) || hasTerm(photoTexts(p), terms)) {
      hidden.photos += 1;
      continue;
    }
    if (span) span.x.photos.push(item);
    else loose.push(item);
  }
  hidden.moments = ms.filter((x) => x.hidden).length;

  const photoMatches = ({ p, when }) => matchesWords(photoTexts(p), words, [when.y, when.y]);
  const groups = new Map();
  for (const item of loose) {
    if (!photoMatches(item)) continue;
    const g = groupOf(item.when, view);
    if (!groups.has(g.key)) groups.set(g.key, { ...g, items: [] });
    groups.get(g.key).items.push(item);
  }

  const entries = [];
  for (const g of groups.values()) {
    const level = g.kind === 'day' ? 'day' : g.kind;
    const { main, photos: ordered } = orderGroup(g.items.map((it) => it.p), level);
    const keys = g.items.map((it) => sortKey(it.when));
    const first = g.items[keys.indexOf(Math.min(...keys))].when;
    const last = g.items[keys.indexOf(Math.max(...keys))].when;
    entries.push({ kind: g.kind, key: g.key, when: g.when, ...(g.end ? { end: g.end } : {}), main, photos: ordered, first, last, level, rank: 1 });
  }
  for (const x of ms) {
    if (x.hidden) continue;
    let items = x.photos;
    if (words.length && !matchesWords(momentTexts(x.m), words, [x.when.y, (x.end || x.when).y])) {
      items = items.filter(photoMatches);
      if (!items.length) continue;
    }
    const ordered = items.length ? orderGroup(items.map((it) => it.p)) : { main: null, photos: [] };
    entries.push({
      kind: 'moment',
      key: `moment:${x.m.id}`,
      when: x.when,
      end: x.end,
      moment: x.m,
      main: ordered.main,
      photos: ordered.photos,
      // A span sits where it ended.
      first: x.when,
      last: x.end || x.when,
      level: 'day',
      rank: 0,
    });
  }
  entries.sort((a, b) => sortKey(b.last) - sortKey(a.last) || a.rank - b.rank || String(a.key).localeCompare(String(b.key)));
  return {
    entries: entries.map((e, i) => {
      const older = entries[i + 1];
      const { first, last, rank, ...rest } = e;
      return { ...rest, year: last.y, gap: older ? gapLabel(older.last, first) : null };
    }),
    hidden,
  };
}

// The entries alone (see buildTimelineView).
const buildTimeline = (photos, moments, options) => buildTimelineView(photos, moments, options).entries;

// The year an entry is listed under (a span: the year it ended; a week or a
// month: its newest photo's).
const entryYear = (e) => (e.year != null ? e.year : (e.end || e.when).y);

// An entry's date as shown: "June 23, 2012", "June 2012", "June 3–9, 2012"
// (a week), a Moment's span.
const entryLabel = (e) => (e.kind === 'moment' || e.kind === 'week' ? spanLabel(e.when, e.end) : whenLabel(e.when));

// ── Moments: records and file names ──
// A Moment is kept like a photo's tag file, named "<id>.json" with a random
// 32-hex id (so every way tag files travel carries it), the record saying
// kind "moment". In a backup it goes in the tag folder under its date:
// "PicJot Tags/2015/08/Moment - Moved to Denver (3f2a9c).json".
const MOMENT_ID = /^[0-9a-f]{32}$/;
const isMomentRecord = (rec) => Boolean(rec && rec.kind === 'moment' && MOMENT_ID.test(String(rec.id || '')));

// A name Windows, FAT32 and Android all accept: no \ / : * ? " < > | or
// control characters, no trailing dots or spaces, at most 60 characters.
function safeName(s) {
  const clean = String(s || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .replace(/[. ]+$/, '');
  return clean || 'Moment';
}

// Where a Moment's file goes in a backup ("/"-separated).
function momentPathFor(rec, tagFolder = TAG_FOLDER) {
  const w = parseWhen(rec.date);
  const two = (n) => String(n).padStart(2, '0');
  const dir = !w ? 'undated' : w.precision === 'year' ? `${w.y}` : `${w.y}/${two(w.m)}`;
  return `${tagFolder}/${dir}/Moment - ${safeName(rec.title)} (${String(rec.id).slice(0, 6)}).json`;
}

module.exports = {
  MONTHS,
  inSpan,
  parseWhen,
  whenText,
  whenLabel,
  spanLabel,
  markOf,
  photoWhen,
  photoScore,
  pickMain,
  MAIN_FIELD,
  gapLabel,
  GROUPS,
  weekOf,
  buildTimeline,
  buildTimelineView,
  entryYear,
  entryLabel,
  foldText,
  queryWords,
  wordsOf,
  cleanHideList,
  hasTerm,
  matchesWords,
  MOMENT_ID,
  isMomentRecord,
  safeName,
  momentPathFor,
};
