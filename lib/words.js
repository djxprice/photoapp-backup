'use strict';
// Words shared by the PC tool and the app (src/lib/wifiBackup.js,
// src/lib/stickBackup.js import this too, like plan.js): no Node modules.

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// The tag part of a backup's result, so a backup that copied no new photos
// still says what it did with the phone's tags (the user's request,
// 2026-10-20). `updated`: photos whose tag file was written or rewritten in
// the backup; `removed`: photos whose tags were cleared on the phone and so
// removed from the backup; `where`: "the PC", "the stick".
function tagsText({ updated = 0, removed = 0 } = {}, where = 'the PC') {
  if (!updated && !removed) return `Tags on ${where} already up to date.`;
  const parts = [];
  if (updated) parts.push(`updated for ${plural(updated, 'photo')}`);
  if (removed) parts.push(`removed for ${plural(removed, 'photo')} (cleared on the phone)`);
  return `Tags on ${where} ${parts.join(', ')}.`;
}

module.exports = { plural, tagsText };
