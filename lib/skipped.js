'use strict';
// The skipped list ("skipped.json", docs/metadata-schema.md): the rules for
// merging two of them, shared by the app and the PC. A list is never simply
// replaced (2026-11-24): after a reinstall the app has no skips yet, and an
// empty list would wipe the real one. Pure.

const SKIP_LIST_TYPE = 'photoapp-skipped';
const HEX32 = /^[0-9a-f]{32}$/;

const isSkipList = (value) =>
  Boolean(value && typeof value === 'object' && value.type === SKIP_LIST_TYPE && Array.isArray(value.photos));

const usable = (p) => Boolean(p && HEX32.test(String(p.contentHash || '')));
const byHash = (a, b) => (a.contentHash < b.contentHash ? -1 : a.contentHash > b.contentHash ? 1 : 0);

// The list to keep: `own`, the newer list, and whatever `existing` lists that
// isn't its writer's to remove. Each photo carries `by`, the install that
// listed it. One listed by this install (`by`) and not in `own` was unskipped
// there, and goes; one listed by another install (before a reinstall, another
// phone) stays, unless `knows(hash)`: the app has that photo, not skipped.
function mergeSkipLists(existing, own, { by = own.by, knows = () => false } = {}) {
  const photos = new Map();
  for (const p of own.photos) if (usable(p)) photos.set(p.contentHash, { ...p, by: p.by || by });
  for (const p of isSkipList(existing) ? existing.photos : []) {
    if (!usable(p) || photos.has(p.contentHash) || p.by === by || knows(p.contentHash)) continue;
    photos.set(p.contentHash, p);
  }
  return { ...own, by, photos: [...photos.values()].sort(byHash) };
}

module.exports = { SKIP_LIST_TYPE, isSkipList, mergeSkipLists };
