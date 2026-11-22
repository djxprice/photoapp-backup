'use strict';
// A timeline as its pages draw it (2026-11-22): the shared rules' entries
// (lib/timeline.js) in the form the PC's timeline page and an exported
// timeline use. Runs in Node (the PC page's data) and in the browser (an
// exported timeline, which has no PC behind it: lib/timeline-bundle.js
// carries this file and lib/timeline.js into its page). Pure, no Node APIs.

const { buildTimelineView, entryYear, entryLabel, whenLabel, photoWhen } = require('./timeline');

// Entries as the pages draw them: { kind, key, year, date, title, note, tags,
// gap, photos: [{ hash, caption, note, tags, date, ...more(p) }] } (the main
// photo first). `more(p)`: what a page adds to each photo (the PC page: its
// file name and kind; an export: whether its picture is in the folder).
function pageEntries(entries, more = () => ({})) {
  return entries.map((e) => ({
    kind: e.kind,
    key: e.key,
    year: entryYear(e),
    date: entryLabel(e),
    title: e.kind === 'moment' ? e.moment.title : (e.main && e.main.caption) || '',
    note: e.kind === 'moment' ? e.moment.note : (e.main && e.main.note) || '',
    tags: e.kind === 'moment' ? e.moment.tags : [],
    gap: e.gap,
    photos: e.photos.map((p) => ({
      hash: p.id,
      caption: p.caption,
      note: p.note,
      tags: p.tags,
      date: whenLabel(photoWhen(p)),
      ...more(p),
    })),
  }));
}

// An exported timeline's view, in the browser: `data` is what the export
// holds ({ includeNotable, photos, moments }: only what was shown when it was
// exported, so no Do Not Show list); `group` and `search` are the viewer's.
function exportedView(data, { group = 'day', search = '' } = {}) {
  const { entries } = buildTimelineView(data.photos || [], data.moments || [], {
    includeNotable: Boolean(data.includeNotable),
    group,
    search,
  });
  return pageEntries(entries, (p) => ({ img: Boolean(p.img) }));
}

module.exports = { pageEntries, exportedView };
