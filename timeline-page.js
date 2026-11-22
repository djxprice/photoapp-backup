'use strict';
// The PC's timeline (roadmap Step 26): a page the receiver serves on this PC
// only (http://127.0.0.1:<page port>/timeline, from the tray's 'Open
// Timeline'). View-only (the user's call, 2026-10-22: all editing is on the
// phone, and reaches the PC with the next backup), apart from its own Do Not
// Show list (the user's call, 2026-10-23: the phone and the PC each have
// one; this one is kept in the receiver's settings). It reads the backup
// folder: the index, the tag files in "PicJot Tags" (beside the photos in a
// backup not moved yet) and the Moments, and lays them out with the rules the
// phone uses (lib/timeline.js), so both show the same timeline.
//
// Export (2026-11-22, the user's go-ahead; roadmap Step 26): a folder anyone
// can open in a browser, offline or put online, in Documents › PicJot
// Timelines: an exported timeline page (exportPage) with what's shown built
// in, and web-sized copies of its photos, which the page's browser makes
// (re-saving a picture also drops its location and other hidden data) and
// the receiver saves (/timeline/export/…).

const fs = require('fs');
const path = require('path');
const { readJson } = require('./lib/files');
const { sidecarPathFor, besideSidecarPathFor, baseName, parseLeadingJson } = require('./lib/plan');
const { buildTimelineView, photoWhen, parseWhen, firstDay, lastDay, isMomentRecord, markOf, GROUPS, cleanHideList, foldText } = require('./lib/timeline');
const { pageEntries } = require('./lib/timeline-view');
const TIMELINE_SCRIPT = require('./lib/timeline-bundle');
const { kindOf } = require('./lib/old');
const { rawPreview } = require('./lib/rawpreview');

const fromPosix = (p) => p.split('/').join(path.sep);

function readRecord(to, rel) {
  try {
    const parsed = parseLeadingJson(fs.readFileSync(path.join(to, fromPosix(rel)), 'utf8'));
    return parsed && parsed.value;
  } catch {
    return null;
  }
}

// The most used tags of the timeline's photos and Moments, for picking a
// Do Not Show term: [tag], in the last-seen spelling.
function topTags(photos, moments, limit = 24) {
  const counts = new Map(); // folded -> { tag, count }
  for (const item of [...photos, ...moments]) {
    for (const tag of item.tags) {
      const key = foldText(tag);
      if (!key) continue;
      const rec = counts.get(key) || { tag, count: 0 };
      rec.count += 1;
      rec.tag = tag;
      counts.set(key, rec);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([, rec]) => rec.tag);
}

// The backup's marked photos and its Moments, as the rules take them:
// { photos: [{ id, significance, …, path }], moments: [{ id, title, … }] }.
function readTimeline(to) {
  const index = readJson(path.join(to, '.photoapp', 'index.json'), { photos: {} });
  const photos = [];
  for (const [hash, e] of Object.entries(index.photos || {})) {
    if (!e || !e.tagged) continue;
    let rec = null;
    for (const rel of [sidecarPathFor(e.path), besideSidecarPathFor(e.path)]) {
      rec = readRecord(to, rel);
      if (rec) break;
    }
    if (!rec || rec.contentHash !== hash || rec.cleared === true || !markOf(rec.significance)) continue;
    photos.push({
      id: hash,
      significance: rec.significance,
      timelineDate: rec.timelineDate || null,
      creationTime: rec.creationTime || null,
      monthOnly: Boolean(rec.monthOnly),
      undated: Boolean(rec.undated),
      caption: rec.caption || '',
      note: rec.note || '',
      tags: Array.isArray(rec.tags) ? rec.tags : [],
      timelineMain: Boolean(rec.timelineMain),
      timelineMainWeek: Boolean(rec.timelineMainWeek),
      timelineMainMonth: Boolean(rec.timelineMainMonth),
      updatedAt: rec.updatedAt || null,
      path: e.path,
    });
  }
  const moments = [];
  for (const [id, rel] of Object.entries(index.moments || {})) {
    const rec = readRecord(to, rel);
    if (!isMomentRecord(rec) || rec.cleared === true) continue;
    moments.push({
      id,
      title: rec.title || '',
      note: rec.note || '',
      tags: Array.isArray(rec.tags) ? rec.tags : [],
      date: rec.date,
      dateEnd: rec.dateEnd || null,
      spanTag: rec.spanTag || null,
      updatedAt: rec.updatedAt || null,
    });
  }
  return { photos, moments };
}

// The timeline of the backup in `to`, as the page shows it: { entries,
// counts, group, search, hide, tags }. Each entry: { kind, key, year, date,
// title, note, tags, gap, photos: [{ hash, caption, note, tags, date, file,
// kind }] } (the main photo first). Notable photos too with
// `includeNotable`; `group` 'day', 'week' or 'month'; `search` words; `hide`
// this PC's Do Not Show list (the phone has its own, the user's call
// 2026-10-23). Returned `hide`: { terms, photos, moments }: the list and
// what it leaves off; `tags`: the most used, to pick from.
function timelineData(to, { includeNotable = false, group = 'day', search = '', hide = [] } = {}) {
  const { photos, moments } = readTimeline(to);
  const view = GROUPS.includes(group) ? group : 'day';
  const terms = cleanHideList(hide);
  const { entries, hidden } = buildTimelineView(photos, moments, { includeNotable, group: view, search, hide: terms });
  return {
    group: view,
    search: String(search || ''),
    hide: { terms, photos: hidden.photos, moments: hidden.moments },
    tags: topTags(photos, moments),
    entries: pageEntries(entries, (p) => ({ file: baseName(p.path), kind: kindOf(p.path) })),
    counts: {
      timeline: photos.filter((p) => markOf(p.significance) === 'timeline' && photoWhen(p)).length,
      notable: photos.filter((p) => markOf(p.significance) === 'notable' && photoWhen(p)).length,
      moments: moments.length,
    },
  };
}

const TYPES = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', raw: 'image/jpeg' };

// A photo of the backup for the page, by its hash (only photos in the index):
// the file, or for RAW the picture inside it. HEIC isn't shown by browsers on
// Windows: 415, the page says so.
async function sendTimelinePhoto(to, hash, res) {
  const index = readJson(path.join(to, '.photoapp', 'index.json'), { photos: {} });
  const e = /^[0-9a-f]{32}$/.test(String(hash || '')) && index.photos[hash];
  const file = e && path.join(to, fromPosix(e.path));
  if (!e || !fs.existsSync(file)) {
    res.writeHead(404);
    res.end();
    return;
  }
  const kind = kindOf(e.path);
  const headers = { 'content-type': TYPES[kind], 'cache-control': 'private, max-age=3600' };
  if (kind === 'heic' || !TYPES[kind]) {
    res.writeHead(415);
    res.end();
    return;
  }
  if (kind === 'raw') {
    const preview = rawPreview(fs.readFileSync(file));
    if (!preview) {
      res.writeHead(415);
      res.end();
      return;
    }
    res.writeHead(200, { ...headers, 'content-length': preview.length });
    res.end(preview);
    return;
  }
  res.writeHead(200, { ...headers, 'content-length': fs.statSync(file).size });
  await new Promise((resolve, reject) => {
    const s = fs.createReadStream(file);
    s.on('error', reject);
    res.on('finish', resolve);
    s.pipe(res);
  });
}

// ── Export ──────────────────────────────────────────────────────────────────
// What an export holds: what's shown (the view, Notable too, the search, this
// PC's Do Not Show list; decided 2026-10-23); `highlights`: only each entry's
// main photo; notes only with `notes` (they can be private; captions and tags
// always). Nothing left off is in it, the Do Not Show list itself neither,
// nor the photos' file names, folders or location. Resolves { html, folder,
// photos: [{ hash }] (the pictures to copy: not HEIC, which browsers on
// Windows can't read), counts: { photos, moments, heic } }.
const EXPORTABLE = new Set(Object.keys(TYPES));

function folderNameFor(title, now) {
  const clean = String(title || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  const p = (n) => String(n).padStart(2, '0');
  return `${(clean || 'Timeline').slice(0, 60)} ${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

// "YYYY-MM-DD" -> a day as the rules compare them (YYYYMMDD), or null.
function dayOf(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text || ''));
  return m ? Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]) : null;
}

// What an export takes (2026-11-22): what's shown (as timelineData), within
// the dates asked for (`dateFrom`, `dateTo`: "YYYY-MM-DD", either or both;
// the user's call: a range, everything up to a latest date, or everything
// from a date on), and with `highlights` only each entry's main photo.
// A photo dated only to a month or a year is in when any of it is; a Moment
// when any of its days is. Resolves { photos, moments } (the records).
function exportSelection(to, { includeNotable = false, group = 'month', search = '', hide = [], highlights = false, dateFrom = '', dateTo = '' } = {}) {
  const all = readTimeline(to);
  let from = dayOf(dateFrom);
  let until = dayOf(dateTo);
  if (from != null && until != null && from > until) [from, until] = [until, from];
  const within = (w, end) => Boolean(w) && (from == null || lastDay(end || w) >= from) && (until == null || firstDay(w) <= until);
  const photos = all.photos.filter((p) => within(photoWhen(p)));
  const moments = all.moments.filter((m) => {
    const w = parseWhen(m.date);
    const end = parseWhen(m.dateEnd);
    return within(w, w && end && firstDay(end) >= firstDay(w) ? end : null);
  });
  const view = GROUPS.includes(group) ? group : 'month';
  const { entries } = buildTimelineView(photos, moments, { includeNotable, group: view, search, hide: cleanHideList(hide) });
  const photoIds = new Set();
  const momentIds = new Set();
  for (const e of entries) {
    if (e.kind === 'moment') momentIds.add(e.moment.id);
    for (const p of highlights ? e.photos.slice(0, 1) : e.photos) photoIds.add(p.id);
  }
  return { photos: photos.filter((p) => photoIds.has(p.id)), moments: moments.filter((m) => momentIds.has(m.id)) };
}

// How much an export would hold, for its dialog: { photos, moments }.
function exportCounts(to, options = {}) {
  const { photos, moments } = exportSelection(to, options);
  return { photos: photos.length, moments: moments.length };
}

function timelineExport(to, { includeNotable = false, group = 'month', search = '', hide = [], notes = false, highlights = false, dateFrom = '', dateTo = '', title = '', now = new Date() } = {}) {
  const view = GROUPS.includes(group) ? group : 'month';
  const { photos: chosen, moments: chosenMoments } = exportSelection(to, { includeNotable, group: view, search, hide, highlights, dateFrom, dateTo });
  const heic = chosen.filter((p) => !EXPORTABLE.has(kindOf(p.path))).length;
  const name = String(title || '').trim().slice(0, 80) || 'Timeline';
  const data = {
    title: name,
    group: view,
    includeNotable: Boolean(includeNotable),
    photos: chosen.map((p) => ({
      id: p.id,
      significance: p.significance,
      timelineDate: p.timelineDate,
      creationTime: p.creationTime,
      monthOnly: p.monthOnly,
      undated: p.undated,
      caption: p.caption,
      note: notes ? p.note : '',
      tags: p.tags,
      timelineMain: p.timelineMain,
      timelineMainWeek: p.timelineMainWeek,
      timelineMainMonth: p.timelineMainMonth,
      updatedAt: p.updatedAt,
      img: EXPORTABLE.has(kindOf(p.path)),
    })),
    moments: chosenMoments.map((m) => ({ ...m, note: notes ? m.note : '' })),
  };
  return {
    html: exportPage(data),
    folder: folderNameFor(name, now),
    photos: data.photos.filter((p) => p.img).map((p) => ({ hash: p.id })),
    counts: { photos: data.photos.length, moments: data.moments.length, heic },
  };
}

// ── The pages ───────────────────────────────────────────────────────────────
// One look and one drawing script for both: the PC's page (mode 'pc': loads
// /timeline/data, Do Not Show, Export) and an exported timeline (mode
// 'export': its data built in, laid out in the browser by the same rules).

const STYLE = `*{box-sizing:border-box}body{margin:0;background:#111;color:#eee;font-family:system-ui,sans-serif;line-height:1.45}
header{position:sticky;top:0;z-index:5;display:flex;flex-wrap:wrap;gap:12px 18px;align-items:center;padding:14px 28px;background:rgba(17,17,17,.94);border-bottom:1px solid #232326}
h1{font-size:20px;margin:0}header .muted{flex:1}label{cursor:pointer;user-select:none}.muted{color:#999;font-size:14px}
.seg{display:flex;border:1px solid #3a3a3f;border-radius:999px;overflow:hidden}.seg button{background:none;border:0;color:#bbb;font:inherit;font-size:14px;font-weight:600;padding:5px 14px;cursor:pointer}
.seg button[aria-pressed="true"]{background:#f0b23c;color:#111}
#q{background:#1b1b1e;border:1px solid #3a3a3f;border-radius:999px;color:#eee;font:inherit;font-size:14px;padding:5px 14px;width:210px}
#hidden{max-width:1100px;margin:10px auto 18px;padding:0 70px 0 24px;color:#999;font-size:14px}#hidden[hidden]{display:none}
#hidden button{background:none;border:0;color:#f0b23c;font:inherit;font-weight:600;cursor:pointer;padding:0 0 0 6px}
.pill{background:#1b1b1e;border:1px solid #3a3a3f;border-radius:999px;color:#ddd;font:inherit;font-size:14px;font-weight:600;padding:5px 14px;cursor:pointer}
.pill.on{background:#f0b23c;border-color:#f0b23c;color:#111}
.dialog{position:fixed;inset:0;z-index:12;background:rgba(0,0,0,.7);display:flex;align-items:flex-start;justify-content:center;padding:70px 16px;overflow:auto}
.dialog[hidden]{display:none}.dialog .box{width:100%;max-width:560px;background:#161618;border-radius:16px;padding:22px}
.dialog h2{margin:0 0 6px;font-size:20px}.dialog p{color:#aaa;font-size:14px;margin:0 0 12px}.dialog h3{color:#999;font-size:13px;margin:16px 0 8px}
.chips{display:flex;flex-wrap:wrap;gap:8px}.chip{background:#232326;border:0;border-radius:999px;color:#eee;font:inherit;font-size:14px;font-weight:600;padding:5px 12px;cursor:pointer}
.chip.on{background:#f0b23c;color:#111}.chip .x{margin-left:6px}.chip .plus{color:#f0b23c;margin-right:4px}
.addrow{display:flex;gap:8px;margin-top:14px}.addrow input{flex:1;background:#1b1b1e;border:1px solid #3a3a3f;border-radius:999px;color:#eee;font:inherit;font-size:14px;padding:7px 14px}
.done{display:block;width:100%;margin-top:20px;background:#2d6a4f;border:0;border-radius:999px;color:#fff;font:inherit;font-size:15px;font-weight:700;padding:10px;cursor:pointer}
.done:disabled{opacity:.5;cursor:default}.done[hidden]{display:none}.link{display:block;margin:10px auto 0;background:none;border:0;color:#aaa;font:inherit;font-weight:600;cursor:pointer}
.addrow button{background:#2d6a4f;border:0;border-radius:999px;color:#fff;font:inherit;font-weight:700;padding:7px 18px;cursor:pointer}
.field{display:block;color:#ccc;font-size:14px;margin:14px 0 6px}.field input{display:block;width:100%;margin-top:6px;background:#1b1b1e;border:1px solid #3a3a3f;border-radius:10px;color:#eee;font:inherit;font-size:15px;padding:8px 12px}
.opt{display:block;color:#ddd;font-size:14px;margin:10px 0}.opt input{margin-right:8px}
.dates{display:flex;gap:12px}.dates .field{flex:1;margin-top:8px}.field input{color-scheme:dark}.dialog .hint{color:#888;font-size:13px;margin:0 0 8px}
#expMsg{color:#ddd;margin-top:14px}#expMsg a{color:#f0b23c}
main{position:relative;max-width:1100px;margin:0 auto;padding:12px 70px 90px 24px}
#line{position:absolute;left:0;top:0;width:100%;pointer-events:none;overflow:visible}
.year{position:relative;z-index:1;text-align:center;font-size:30px;font-weight:700;margin:40px 0 14px}.year span{background:#111;padding:0 14px}
.entry{position:relative;display:flex;margin:16px 0 4px}.entry.r{justify-content:flex-end}
.card{position:relative;z-index:1;width:calc(50% - 70px);background:#1b1b1e;border-radius:14px;overflow:hidden;cursor:pointer;transition:transform .12s}
.card:hover{transform:translateY(-2px);box-shadow:0 0 0 2px rgba(240,178,60,.45)}
.node{position:absolute;z-index:2;top:20px;width:18px;height:18px;border-radius:50%;background:#f0b23c;border:3px solid #111}
.entry.l .node{left:calc(50% - 40px)}.entry.r .node{left:calc(50% + 22px)}.entry.moment .node{background:#7fc79a}
.head{padding:10px 14px 8px}.date{color:#f0b23c;font-size:13px;font-weight:700}.moment .date{color:#7fc79a}
.title{font-size:17px;font-weight:600;margin-top:2px}.moment .title{font-size:19px;font-weight:700}
.pic{position:relative}.pic img,.nopic{display:block;width:100%;height:250px;object-fit:cover;background:#232326}
.nopic{display:flex;flex-direction:column;align-items:center;justify-content:center;color:#888;font-size:14px;text-align:center;padding:12px}
.more{position:absolute;right:10px;bottom:10px;background:rgba(0,0,0,.65);border-radius:999px;padding:2px 10px;font-size:13px;font-weight:700}
.note{color:#aaa;font-size:14px;padding:6px 14px 12px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.tags{color:#f0b23c;font-size:13px;padding:0 14px 12px}
.gap{position:relative;z-index:1;text-align:center;color:#777;font-style:italic;font-size:13px;margin:10px 0}.gap span{background:#111;padding:0 8px}
#years{position:fixed;right:10px;top:76px;bottom:16px;display:flex;flex-direction:column;justify-content:space-between;align-items:center;z-index:6;font-size:12px}
#years a{color:#888;text-decoration:none;font-weight:700}#years a:hover{color:#f0b23c}
#modal{position:fixed;inset:0;z-index:10;background:rgba(0,0,0,.9);overflow:auto;padding:28px 16px}
#modal[hidden]{display:none}.sheet{max-width:960px;margin:0 auto;background:#161618;border-radius:16px;padding:22px}
.sheet h2{margin:0 0 4px;font-size:22px}.sheet .photo{margin:22px 0 0}.sheet img{display:block;width:100%;max-height:82vh;object-fit:contain;background:#000;border-radius:10px}
.sheet .nopic{height:180px;border-radius:10px}.cap{font-size:17px;font-weight:600;margin-top:8px}.sheet .note{-webkit-line-clamp:unset;padding:4px 0}.sheet .tags{padding:2px 0}
.close{position:fixed;top:14px;right:22px;z-index:11;font-size:30px;line-height:1;background:none;border:0;color:#eee;cursor:pointer}
.empty{text-align:center;color:#aaa;margin:90px auto;max-width:520px}.empty h2{color:#eee}
.made{text-align:center;color:#777;font-size:13px;padding:0 0 28px}.made a{color:#f0b23c;text-decoration:none}
@media (max-width:700px){header{padding:12px 16px}#q{width:100%}main{padding:12px 16px 60px}#years{display:none}
.card{width:calc(100% - 34px)}.entry.l,.entry.r{justify-content:flex-end}.entry.l .node,.entry.r .node{left:4px}}`;

// The drawing, shared: render(), the line, opening an entry, Day / Week /
// Month and the search box. Each page defines pic(), countText(), emptyText(),
// photoLine(), renderHidden() and load().
const DRAW = `const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
let data = { entries: [], search: '' };
const tagText = (tags) => (tags && tags.length ? '<div class="tags">' + tags.map((t) => '#' + esc(t)).join('  ') + '</div>' : '');

function render() {
  const out = [];
  let year = null;
  let side = 0;
  const years = [];
  data.entries.forEach((e, i) => {
    if (e.year !== year) {
      year = e.year;
      years.push(year);
      out.push('<div class="year" id="y' + year + '"><span>' + year + '</span></div>');
    }
    const main = e.photos[0];
    out.push(
      '<div class="entry ' + (side++ % 2 ? 'r' : 'l') + (e.kind === 'moment' ? ' moment' : '') + '"><span class="node"></span>' +
        '<div class="card" data-i="' + i + '" tabindex="0" role="button">' +
        '<div class="head"><div class="date">' + esc(e.date) + '</div>' + (e.title ? '<div class="title">' + esc(e.title) + '</div>' : '') + '</div>' +
        (main ? '<div class="pic">' + pic(main) + (e.photos.length > 1 ? '<span class="more">+' + (e.photos.length - 1) + '</span>' : '') + '</div>' : '') +
        (e.note ? '<div class="note">' + esc(e.note) + '</div>' : '') +
        (e.kind === 'moment' ? tagText(e.tags) : '') +
        '</div></div>' +
        (e.gap ? '<div class="gap"><span>' + esc(e.gap) + '</span></div>' : '')
    );
  });
  $('#entries').innerHTML = out.length
    ? out.join('')
    : String(data.search || '').trim()
      ? '<div class="empty"><h2>No matches</h2><p>Nothing on the timeline has every word of “' + esc(String(data.search).trim()) + '” in its caption, tags or note.</p></div>'
      : emptyText();
  renderHidden();
  $('#years').innerHTML = years.length > 1 ? years.map((y, i) => '<a href="#y' + y + '">' + (years.length > 30 && i % 2 ? '·' : "'" + String(y).slice(2)) + '</a>').join('') : '';
  $('#count').textContent = countText();
  requestAnimationFrame(drawLine);
}

// Entries alternate sides, so each can start beside the one before it:
// pulled up by part of the previous card's height (never past its top, so
// the order still reads down the page). Not after a year heading.
function stagger() {
  let prev = null;
  const narrow = window.matchMedia('(max-width:700px)').matches;
  for (const el of document.querySelectorAll('#entries > *')) {
    if (el.classList.contains('year')) { prev = null; continue; }
    if (!el.classList.contains('entry')) continue;
    el.style.marginTop = '';
    if (prev && !narrow) {
      const h = prev.querySelector('.card').getBoundingClientRect().height;
      el.style.marginTop = -Math.max(0, Math.min(160, h - 80)) + 'px';
    }
    prev = el;
  }
}

// A smooth line through the entries' dots (Catmull-Rom as Béziers).
function drawLine() {
  stagger();
  const main = $('#tl');
  const box = main.getBoundingClientRect();
  const pts = [...document.querySelectorAll('.node')].map((n) => {
    const r = n.getBoundingClientRect();
    return [r.left + r.width / 2 - box.left, r.top + r.height / 2 - box.top];
  });
  const svg = $('#line');
  svg.setAttribute('height', main.scrollHeight);
  if (pts.length < 2) {
    svg.querySelector('path').setAttribute('d', '');
    return;
  }
  const p = [[pts[0][0], 0], ...pts, [pts[pts.length - 1][0], main.scrollHeight]];
  let d = 'M' + p[0][0] + ',' + p[0][1];
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 2] || p[i - 1], b = p[i - 1], c = p[i], n = p[i + 1] || c;
    d += ' C' + (b[0] + (c[0] - a[0]) / 6) + ',' + (b[1] + (c[1] - a[1]) / 6) + ' ' + (c[0] - (n[0] - b[0]) / 6) + ',' + (c[1] - (n[1] - b[1]) / 6) + ' ' + c[0] + ',' + c[1];
  }
  svg.querySelector('path').setAttribute('d', d);
}

function open(i) {
  const e = data.entries[i];
  if (!e) return;
  const head = '<div class="date">' + esc(e.date) + '</div>' + (e.kind === 'moment' ? '<h2>' + esc(e.title) + '</h2>' + (e.note ? '<div class="note">' + esc(e.note) + '</div>' : '') + tagText(e.tags) : '');
  const photos = e.photos
    .map((p) => '<div class="photo">' + pic(p, true) + (p.caption ? '<div class="cap">' + esc(p.caption) + '</div>' : '') + (p.note ? '<div class="note">' + esc(p.note) + '</div>' : '') + tagText(p.tags) + '<div class="muted">' + photoLine(p) + '</div></div>')
    .join('');
  $('#sheet').innerHTML = head + photos;
  $('#modal').hidden = false;
  $('#modal').scrollTop = 0;
}
const close = () => { $('#modal').hidden = true; };

$('#entries').addEventListener('click', (ev) => {
  const card = ev.target.closest('.card');
  if (card) open(Number(card.dataset.i));
});
$('#entries').addEventListener('keydown', (ev) => {
  const card = ev.target.closest('.card');
  if (card && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); open(Number(card.dataset.i)); }
});
$('#modal').addEventListener('click', (ev) => { if (ev.target.id === 'modal' || ev.target.classList.contains('close')) close(); });
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return;
  close();
  for (const d of document.querySelectorAll('.dialog')) d.hidden = true;
});
window.addEventListener('resize', () => requestAnimationFrame(drawLine));
document.addEventListener('load', (ev) => { if (ev.target.tagName === 'IMG') requestAnimationFrame(drawLine); }, true);
// A picture that can't be shown (missing, or a RAW with none inside).
document.addEventListener('error', (ev) => {
  const img = ev.target;
  if (img.tagName !== 'IMG') return;
  const d = document.createElement('div');
  d.className = 'nopic';
  d.textContent = missingText(img);
  img.replaceWith(d);
}, true);

// Day, Week or Month: remembered by the browser.
let group = DEFAULT_GROUP;
try { group = localStorage.getItem(GROUP_KEY) || DEFAULT_GROUP; } catch (e) {}
function showGroup() {
  for (const b of document.querySelectorAll('.seg button')) b.setAttribute('aria-pressed', String(b.dataset.g === group));
}
document.querySelector('.seg').addEventListener('click', (ev) => {
  const g = ev.target.dataset && ev.target.dataset.g;
  if (!g || g === group) return;
  group = g;
  try { localStorage.setItem(GROUP_KEY, group); } catch (e) {}
  showGroup();
  load();
});

// Search as you type (not remembered).
let typing = null;
$('#q').addEventListener('input', () => {
  clearTimeout(typing);
  typing = setTimeout(load, 250);
});
`;

const SEG = '<div class="seg" role="group" aria-label="Show by"><button data-g="day">Day</button><button data-g="week">Week</button><button data-g="month">Month</button></div>';
const SEARCH = '<input type="search" id="q" placeholder="Search captions, tags, notes" aria-label="Search the timeline">';
const BODY = `<nav id="years" aria-label="Years"></nav>
<main id="tl"><svg id="line" aria-hidden="true"><path fill="none" stroke="#3a3a3f" stroke-width="3"/></svg><div id="entries"></div></main>
<div id="modal" hidden><button class="close" aria-label="Close">×</button><div class="sheet" id="sheet"></div></div>`;

// Text safe inside a <script> element.
const scriptSafe = (s) => String(s).replace(/<\/(script)/gi, '<\\/$1').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// The PC's page: loads /timeline/data and draws it. Years down the right
// edge; a wavy line through the entries, which alternate left and right; a
// click opens an entry (its photos full size, with their notes). 'Do Not
// Show' edits this PC's list (POST /timeline/hide with the page's `token`);
// 'Export' makes a folder of what's shown.
function timelinePage(appName, token = '') {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Timeline · ${appName}</title><style>${STYLE}</style></head><body>
<header><h1>Your Timeline</h1><span class="muted" id="count"></span>
${SEG}
${SEARCH}
<label><input type="checkbox" id="notable"> Show Notable photos too</label>
<button class="pill" id="dnsOpen">Do Not Show</button>
<button class="pill" id="expOpen">Export</button></header>
<div id="hidden" hidden></div>
<div id="dns" class="dialog" hidden role="dialog" aria-label="Do Not Show"><div class="box">
<h2>Do Not Show</h2>
<p>Leave off photos and Moments with one of these words or tags in their caption, tags or note (whole words only: "art" doesn't hide "party"). This list is for this PC: the timeline on your phone has its own.</p>
<div class="chips" id="dnsList"></div><p id="dnsLeft"></p>
<form class="addrow" id="dnsAdd"><input id="dnsText" placeholder="Add a word or tag" autocomplete="off" aria-label="Add a word or tag to Do Not Show"><button>Add</button></form>
<h3 id="dnsTagsHead">Your Tags</h3><div class="chips" id="dnsTags"></div>
<button class="done" id="dnsDone">Done</button></div></div>
<div id="exp" class="dialog" hidden role="dialog" aria-label="Export this timeline"><div class="box">
<h2>Export This Timeline</h2>
<p>Makes a folder with this timeline and web-sized copies of its photos, in <b>Documents › PicJot Timelines</b>. It opens in any browser, even offline: share it on a USB stick or as a zip, or put it online. Location data is taken out of every photo.</p>
<p id="expWhat"></p>
<label class="field">Title <input id="expTitle" value="Timeline" maxlength="80" autocomplete="off"></label>
<div class="dates"><label class="field">From <input type="date" id="expFrom"></label><label class="field">To <input type="date" id="expTo"></label></div>
<p class="hint">Dates are optional: both for a range, only To for everything up to that date, or only From for everything from that date on.</p>
<label class="opt"><input type="checkbox" id="expNotes">Include notes <span class="muted">(captions and tags are always included)</span></label>
<label class="opt"><input type="checkbox" id="expHigh">Highlights only: one photo for each entry</label>
<p id="expMsg" aria-live="polite"></p>
<button class="done" id="expGo">Export</button>
<button class="done" id="expFolder" hidden>Open Folder</button>
<button class="link" id="expClose">Close</button></div></div>
${BODY}
<script>
const DEFAULT_GROUP = 'month';
const GROUP_KEY = 'picjotTimelineGroup';
${DRAW}
const pic = (p, big) =>
  p.kind === 'heic'
    ? '<div class="nopic">HEIC photo: browsers on Windows can\\'t show it<br><small>' + esc(p.file) + '</small></div>'
    : '<img ' + (big ? '' : 'loading="lazy" ') + 'src="/timeline/photo?hash=' + p.hash + '" alt="' + esc(p.caption || p.file) + '" data-file="' + esc(p.file) + '">';
const photoLine = (p) => esc(p.date) + ' · ' + esc(p.file);
const missingText = (img) => 'Not shown: ' + (img.dataset.file || '');
const countText = () => {
  const c = data.counts || {};
  return [plural(c.timeline || 0, 'Timeline photo'), plural(c.moments || 0, 'Moment')].join(' · ');
};
const emptyText = () => '<div class="empty"><h2>Your timeline is empty</h2><p>On your phone, mark photos \\'Timeline\\' when you review them, or add a Moment (Revisit Memories → Timeline). They appear here after the next backup.</p></div>';

// This PC's Do Not Show list (the phone has its own): the line under the
// header says what it leaves off; 'Do Not Show', or 'Change' on that line,
// opens it. Each change is saved by the PC program at once.
const TOKEN = ${JSON.stringify(token)};
const fold = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g, '');
const hidden = () => data.hide || { terms: [], photos: 0, moments: 0 };
const leftOff = (h) => [h.photos ? plural(h.photos, 'photo') : '', h.moments ? plural(h.moments, 'Moment') : ''].filter(Boolean).join(' and ');
function renderHidden() {
  const h = hidden();
  $('#dnsOpen').classList.toggle('on', h.terms.length > 0);
  $('#dnsOpen').textContent = h.terms.length ? 'Do Not Show (' + h.terms.length + ')' : 'Do Not Show';
  const box = $('#hidden');
  box.hidden = !h.terms.length;
  if (h.terms.length) {
    box.innerHTML = 'Not showing: ' + h.terms.map(esc).join(', ') + (leftOff(h) ? ' · ' + leftOff(h) : '') + '<button id="dnsChange">Change</button>';
  }
  if (!$('#dns').hidden) renderDns();
}
function renderDns() {
  const h = hidden();
  $('#dnsList').innerHTML = h.terms
    .map((t, i) => '<button class="chip on" data-del="' + i + '" aria-label="' + esc(t) + ', remove from Do Not Show">' + esc(t) + '<span class="x">×</span></button>')
    .join('');
  $('#dnsLeft').textContent = h.terms.length ? (leftOff(h) ? 'Not showing ' + leftOff(h) + '.' : 'Nothing on your timeline has these now.') : '';
  const inList = new Set(h.terms.map(fold));
  const offered = (data.tags || []).filter((t) => !inList.has(fold(t))).slice(0, 12);
  $('#dnsTagsHead').hidden = !offered.length;
  $('#dnsTags').innerHTML = offered
    .map((t) => '<button class="chip" data-add="' + esc(t) + '" aria-label="' + esc(t) + ', add to Do Not Show"><span class="plus">+</span>' + esc(t) + '</button>')
    .join('');
}
async function saveHide(list) {
  const r = await fetch('/timeline/hide', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ t: TOKEN, hide: list }) });
  if (!r.ok) {
    alert("The Do Not Show list couldn't be saved. Reload the page and try again.");
    return;
  }
  load();
}
const openDns = () => {
  renderDns();
  $('#dns').hidden = false;
  $('#dnsText').focus();
};
$('#dnsOpen').addEventListener('click', openDns);
$('#hidden').addEventListener('click', (ev) => { if (ev.target.id === 'dnsChange') openDns(); });
$('#dnsDone').addEventListener('click', () => { $('#dns').hidden = true; });
$('#dns').addEventListener('click', (ev) => {
  if (ev.target.id === 'dns') { $('#dns').hidden = true; return; }
  const b = ev.target.closest('button');
  if (!b) return;
  const terms = hidden().terms;
  if (b.dataset.del != null) saveHide(terms.filter((_, i) => i !== Number(b.dataset.del)));
  else if (b.dataset.add != null) saveHide([...terms, b.dataset.add]);
});
$('#dnsAdd').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const t = $('#dnsText').value.trim();
  if (!t) return;
  $('#dnsText').value = '';
  saveHide([...hidden().terms, t]);
});

// Export (2026-11-22): a folder with what's shown. The PC program makes the
// folder, in Documents › PicJot Timelines, with its page; this browser makes
// the photos' web-sized copies (re-saving a picture drops its location and
// other hidden data) and hands each to the PC program, which saves it.
// (First the browser saved the folder itself, where the user chose: it
// refused folders like Downloads, needed Edge or Chrome, and had the
// antivirus check every file as a download; the user's call the same day.)
const GUIDE = 'https://picjot.app/guides/timeline.html#share-your-timeline';
const expMsg = (html) => { $('#expMsg').innerHTML = html; };
// What the export will hold, in words, with the PC program's count for the
// dates and Highlights chosen (/timeline/export/count).
const niceDay = (v) => {
  const [y, m, d] = v.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
};
function datesText() {
  const f = $('#expFrom').value;
  const t = $('#expTo').value;
  if (f && t) return f <= t ? 'from ' + niceDay(f) + ' to ' + niceDay(t) : 'from ' + niceDay(t) + ' to ' + niceDay(f);
  if (f) return 'from ' + niceDay(f) + ' on';
  if (t) return 'up to ' + niceDay(t);
  return '';
}
let counting = 0;
async function updateWhat() {
  const how = [group.charAt(0).toUpperCase() + group.slice(1) + ' view'];
  if ($('#notable').checked) how.push('Notable photos too');
  if ($('#q').value.trim()) how.push('only what matches “' + esc($('#q').value.trim()) + '”');
  if (hidden().terms.length) how.push('without what Do Not Show leaves off');
  const dates = datesText();
  if (dates) how.push(dates);
  const params = new URLSearchParams({ group });
  if ($('#notable').checked) params.set('notable', '1');
  if ($('#q').value.trim()) params.set('q', $('#q').value.trim());
  if ($('#expHigh').checked) params.set('highlights', '1');
  if ($('#expFrom').value) params.set('from', $('#expFrom').value);
  if ($('#expTo').value) params.set('to', $('#expTo').value);
  const mine = ++counting;
  let c = null;
  try {
    const r = await fetch('/timeline/export/count?' + params, { cache: 'no-store' });
    if (r.ok) c = await r.json();
  } catch (e) {}
  if (mine !== counting) return;
  const what = c ? plural(c.photos, 'photo') + ' and ' + plural(c.moments, 'Moment') : 'what\\'s shown';
  $('#expWhat').innerHTML = 'It will hold ' + what + ': ' + how.join(', ') + '. Change the view, the search or the tick box first to export something else.';
}
for (const id of ['#expFrom', '#expTo', '#expHigh']) $(id).addEventListener('change', updateWhat);
$('#expOpen').addEventListener('click', () => {
  updateWhat();
  if (!running) {
    expMsg('');
    $('#expFolder').hidden = true;
  }
  $('#exp').hidden = false;
});
$('#expClose').addEventListener('click', () => { $('#exp').hidden = true; });
$('#exp').addEventListener('click', (ev) => { if (ev.target.id === 'exp') $('#exp').hidden = true; });
let running = false;
let lastExport = null;
const post = async (path, body) => {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ t: TOKEN, ...body }) });
  const got = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(got.error || 'HTTP ' + r.status);
  return got;
};
async function sendPicture(id, hash, size, blob) {
  const r = await fetch('/timeline/export/photo?id=' + encodeURIComponent(id) + '&hash=' + hash + '&size=' + size, {
    method: 'POST',
    headers: { 'content-type': 'image/jpeg', 'x-picjot-token': TOKEN },
    body: blob,
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
}
function jpeg(bmp, max, quality) {
  const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * s));
  c.height = Math.max(1, Math.round(bmp.height * s));
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  g.imageSmoothingQuality = 'high';
  g.drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('no picture'))), 'image/jpeg', quality));
}
// Both sizes made first and the picture let go, then both sent at once.
async function copyPhoto(id, hash) {
  const r = await fetch('/timeline/photo?hash=' + hash);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const bmp = await createImageBitmap(await r.blob(), { imageOrientation: 'from-image' });
  let big, little;
  try {
    big = await jpeg(bmp, 1600, 0.85);
    little = await jpeg(bmp, 800, 0.8);
  } finally {
    bmp.close();
  }
  await Promise.all([sendPicture(id, hash, 'full', big), sendPicture(id, hash, 'thumb', little)]);
}
// A few photos at once: the PC has cores to spare.
const AT_ONCE = 4;
$('#expGo').addEventListener('click', async () => {
  if (running) return;
  running = true;
  $('#expGo').disabled = true;
  $('#expFolder').hidden = true;
  try {
    expMsg('Getting the timeline ready…');
    const ex = await post('/timeline/export/start', {
      group,
      notable: $('#notable').checked,
      q: $('#q').value.trim(),
      notes: $('#expNotes').checked,
      highlights: $('#expHigh').checked,
      dateFrom: $('#expFrom').value,
      dateTo: $('#expTo').value,
      title: $('#expTitle').value.trim() || 'Timeline',
    });
    lastExport = ex.id;
    let failed = 0;
    let next = 0;
    let done = 0;
    const total = ex.photos.length;
    if (total) expMsg('Making web-sized copies of the photos: 0 of ' + total + '…');
    const worker = async () => {
      while (next < total) {
        const p = ex.photos[next++];
        try {
          await copyPhoto(ex.id, p.hash);
        } catch (e) {
          failed += 1;
        }
        done += 1;
        expMsg('Making web-sized copies of the photos: ' + done + ' of ' + total + '…');
      }
    };
    await Promise.all(Array.from({ length: Math.min(AT_ONCE, total) }, worker));
    await post('/timeline/export/done', { id: ex.id, failed });
    const c = ex.counts;
    expMsg(
      '<b>Exported</b> to ' + esc(ex.where.replace(/\\\\/g, ' › ')) + ': ' + plural(c.photos, 'photo') + ' and ' + plural(c.moments, 'Moment') + '.' +
        (c.heic ? ' ' + plural(c.heic, 'HEIC photo') + ' without ' + (c.heic === 1 ? 'its picture' : 'their pictures') + ': browsers on Windows can\\'t read them.' : '') +
        (failed ? ' ' + plural(failed, 'picture') + " couldn't be read, and show as not included." : '') +
        ' Open its <b>index.html</b> to see it; move or copy the folder anywhere. To share it or put it online: <a href="' + GUIDE + '" target="_blank" rel="noopener">the guide</a>.'
    );
    $('#expFolder').hidden = false;
  } catch (e) {
    expMsg('The export stopped: ' + esc(e.message || e) + '. Export again to start over.');
  } finally {
    running = false;
    $('#expGo').disabled = false;
  }
});
$('#expFolder').addEventListener('click', () => {
  if (lastExport) post('/timeline/export/open', { id: lastExport }).catch((e) => expMsg('The folder couldn\\'t be opened: ' + esc(e.message || e)));
});

let asked = 0;
async function load() {
  const notable = $('#notable').checked;
  try { localStorage.setItem('picjotTimelineNotable', notable ? '1' : '0'); } catch (e) {}
  const params = new URLSearchParams({ group });
  if (notable) params.set('notable', '1');
  if ($('#q').value.trim()) params.set('q', $('#q').value.trim());
  const mine = ++asked;
  const r = await fetch('/timeline/data?' + params, { cache: 'no-store' });
  const got = await r.json();
  if (mine !== asked) return; // a newer request is on its way
  data = got;
  if (!r.ok) {
    $('#entries').innerHTML = '<div class="empty"><h2>The timeline can\\'t be shown</h2><p>' + esc(data.error || r.status) + '</p></div>';
    return;
  }
  render();
}
try { $('#notable').checked = localStorage.getItem('picjotTimelineNotable') === '1'; } catch (e) {}
$('#notable').addEventListener('change', load);
showGroup();
load();
</script></body></html>`;
}

// An exported timeline: a page that needs nothing but its folder (its photos
// in photos/ and thumbs/), with what was shown built in and laid out by the
// same rules (lib/timeline-bundle.js). Keeps Day / Week / Month and the
// search; no Do Not Show (what it left off isn't in it) and no file names.
function exportPage(data) {
  const title = escHtml(data.title || 'Timeline');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="generator" content="PicJot"><meta name="robots" content="noindex"><title>${title}</title><style>${STYLE}</style></head><body>
<header><h1>${title}</h1><span class="muted" id="count"></span>
${SEG}
${SEARCH}</header>
${BODY}
<footer class="made">Made with <a href="https://picjot.app">PicJot</a></footer>
<script>${scriptSafe(TIMELINE_SCRIPT)}</script>
<script>
const DATA = ${scriptSafe(JSON.stringify(data))};
const DEFAULT_GROUP = DATA.group || 'month';
const GROUP_KEY = 'picjotExportGroup';
${DRAW}
const pic = (p, big) =>
  p.img
    ? '<img ' + (big ? '' : 'loading="lazy" ') + 'src="' + (big ? 'photos/' : 'thumbs/') + p.hash + '.jpg" alt="' + esc(p.caption || '') + '">'
    : '<div class="nopic">Picture not included</div>';
const photoLine = (p) => esc(p.date);
const missingText = () => 'Picture not included';
const countText = () => [plural(DATA.photos.length, 'photo'), plural(DATA.moments.length, 'Moment')].join(' · ');
const emptyText = () => '<div class="empty"><h2>Nothing here yet</h2></div>';
const renderHidden = () => {};
function load() {
  const search = $('#q').value.trim();
  data = { entries: PicJotTimeline.exportedView(DATA, { group, search }), search };
  render();
}
showGroup();
load();
</script></body></html>`;
}

module.exports = { timelineData, sendTimelinePhoto, timelinePage, timelineExport, exportCounts, exportPage };
