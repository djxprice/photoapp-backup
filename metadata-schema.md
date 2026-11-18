# PicJot metadata file (sidecar) — schema v2

The **canonical definition** of PicJot's per-photo metadata file. Code that writes it: `buildSidecar` in `src/lib/sidecar.js` (keep the two in step). Readers: the PC backup tool (`pc/backup.js`), the app's backup to a USB stick (`src/services/stickBackup.js`), the PC's timeline page (`pc/timeline-page.js`, since 2026-10-22), and the future PC↔phone metadata sync. **Moments** (timeline entries without a photo) are a second kind of record in the same folders: see [Moments](#moments) below.

## Where the files live

- **On the phone:** one file per photo, named `<contentHash>.json`, all in the single folder the user granted (e.g. `DCIM/PicJot Tags`; the developer's was `DCIM/photoAppMetadada` until 2026-10-20). The folder also holds the backup receipts and tags-synced markers. Not next to the photo: Android's folder access (SAF) only grants one folder.
- **In a backup (the PC's, or a USB stick's since 2026-10-19):** copied into the backup's `PicJot Tags` folder, mirroring the month folders, as `<photo file name>.json` (e.g. `PicJot Tags/2026/07/20260729_152730.jpg.json` for `2026/07/20260729_152730.jpg`; the name is the Google Takeout convention), plus `"photoFile": "<photo file name>"`. **Until 2026-10-22 they were beside the photo** (`2026/07/20260729_152730.jpg.json`); the user moved them into one folder so the photo folders hold only photos and the notes are one folder to copy or delete. The next backup (PC) or stick backup moves old ones in, once. A RAW+JPEG pair (`IMG.jpg` + `IMG.dng`) gets one file each. Before 2026-10-15 the name dropped the photo's extension (`20260729_152730.json`), so such a pair overwrote each other's tags; the backup tool renames old files on its next run.
- The phone's SQLite database is the source of truth while the app is installed. These files are the durable, portable copy that outlives the app or the phone.

## When a file exists

A photo has a metadata file when the user expressed something about it (`needsSidecar` in `src/lib/session.js`):

- it has a **caption, tags or a note**, or
- it is marked **Notable** (called Important until 2026-10-20) or **Timeline** (even with no text). (Until 2026-10-19 also **Utility**.)

Photos that were only skipped, only marked Keep on Phone, or not marked at all, have no file. Deleting the photo from the device via the end-of-queue batch delete deletes its file. Free Up Space keeps the file (the photo is in a backup).

**Clearing everything from a photo** replaces its file with a **cleared record** (since 2026-10-15), so the PC's *Sync tags* removes its copy of the tags too:

```json
{ "version": 2, "hashAlgorithm": "md5", "hashSource": "original", "contentHash": "<md5>",
  "fileName": "20260729_152730.jpg", "cleared": true, "updatedAt": "2026-10-15T09:00:00.000Z" }
```

A cleared record has no caption, tags, note or significance. Tagging the photo again overwrites it with a regular record. Readers must **only** remove tags on an explicit `"cleared": true`. A missing file never means "cleared": the photo may have been deleted, or a listing may be incomplete.

## Fields

```json
{
  "version": 2,
  "hashAlgorithm": "md5",
  "hashSource": "original",
  "contentHash": "9f86d081884c7d659a2feaa0c55ad015",
  "fileName": "20260614_182231.jpg",
  "fileSize": 3874112,
  "relativePath": "DCIM/Camera",
  "creationTime": "2026-06-14T18:22:31.000Z",
  "timelineDate": null,
  "caption": "Sunset at the ridge",
  "tags": ["hiking", "summer"],
  "note": "First time up the north trail.",
  "significance": "notable",
  "skipped": false,
  "keepOnPhone": false,
  "visibility": "private",
  "createdAt": "2026-10-14T18:02:11.000Z",
  "updatedAt": "2026-10-14T18:05:40.000Z"
}
```

| Field | Type | Meaning |
|---|---|---|
| `version` | number | Schema version. Currently **2**. Readers should accept older versions (missing fields = defaults below). |
| `hashAlgorithm` | `"md5"` | Algorithm of `contentHash`. |
| `hashSource` | `"original"` \| `"redacted"` \| `null` | `original`: hashed from the unaltered file, so it matches `md5sum`/CertUtil on a PC copy. `redacted`: hashed while Android was blanking GPS bytes (no media-location access), so it will **not** match a PC copy. `null`: unknown (v1). |
| `contentHash` | 32-char lowercase hex | **The photo's identity.** MD5 of the file's bytes. Pairs this record with its photo anywhere, regardless of name or folder. |
| `fileName` | string | Original file name on the phone. A hint, never a key. |
| `fileSize` | number \| null | Bytes. Lets a reader shortlist candidates by size before hashing. |
| `relativePath` | string \| null | The photo's folder on the phone, relative to shared storage (e.g. `DCIM/Camera`, `Pictures/Messages`). With `fileName` + `fileSize` it lets a restore find candidates quickly, then confirm by hash. |
| `creationTime` | ISO 8601 UTC \| null | When the photo was taken: Android's date taken; when Android has none (it leaves it unset for an EXIF date without a time zone, e.g. a downloaded photo), the photo's own EXIF date (since 2026-10-20; read in the phone's time zone when it records none); with no EXIF date either, when the file was saved. |
| `undated` | `true` \| *absent* | Since 2026-10-22: `creationTime` is only when the file was saved (the photo has no date taken), so it isn't a real date: the timeline leaves the photo off unless `timelineDate` is set. |
| `monthOnly` | `true` \| *absent* | Since 2026-10-22: only the month of `creationTime` is known (an old photo from the PC, Step 26b): the day and time in it are made up (the 15th, noon). |
| `timelineDate` | `YYYY` \| `YYYY-MM` \| `YYYY-MM-DD` \| null | Where the photo belongs in time when the user set it (since 2026-10-22, the details sheet's 'Change Date', or the question asked when an undated photo is tagged): e.g. `"1987"` for a scan of a 1987 print. A year or a month is enough. **Readers use `timelineDate ?? creationTime`** (the timeline, Revisit Memories, Find). |
| `timelineMain` | `true` \| *absent* | Since 2026-10-22: the user chose this photo as its day's main photo on the timeline (if several say so, the latest `updatedAt` wins). A Moment spanning days uses it too. |
| `timelineMainWeek`, `timelineMainMonth` | `true` \| *absent* | Since 2026-10-23: the main photo of its week (Sunday to Saturday) or its month, chosen in the timeline's Week or Month view; each view's choice is its own, so a month's main photo leaves its days' alone. A week or month without its own choice takes one chosen in a finer view. |
| `caption` | string | The caption ("What's this moment?"), trimmed. |
| `tags` | string[] | Tags, trimmed, empty ones removed, in the user's spelling. |
| `note` | string | Free-text note. |
| `significance` | `"notable"` \| `"timeline"` \| *absent* | The photo's mark. `notable`: worth noting, more than most photos but not a timeline moment (written `"important"` until 2026-10-20: read that as `notable`). `timeline` (since 2026-10-19): one of the big moments, the photos the timeline is made of; it also counts as Notable everywhere (Revisit Memories, Free Up Space). **Absent: not marked** (since 2026-10-20 the field is left out; files written before said `"normal"`, and before 2026-10-19 maybe `"utility"`: read those, and any unknown value, as not marked). |
| `skipped` | boolean | The user marked the photo reviewed without tagging it (the **Skip** button). |
| `keepOnPhone` | boolean | The user marked the photo **Keep on phone**: the app's Free up space never deletes it from the phone, even once it's backed up. A phone-side wish; PC readers can ignore it. Missing = `false` (files written before 2026-10-19). |
| `visibility` | `"private"` \| `"family"` \| `"public"` | Who may see it on future shared timelines. Nested: private ⊂ family ⊂ public audiences. Defaults to `private`; the app has no selector yet. |
| `createdAt` | ISO 8601 UTC \| null | When the photo's metadata was first created. `null` for entries made before stamps existed. |
| `updatedAt` | ISO 8601 UTC \| null | When the user last changed caption, tags, note, significance, skipped, keepOnPhone, timelineDate or a main-photo choice (not bookkeeping). Used by PC↔phone sync to tell which side edited. |

## Moments

A **Moment** (since 2026-10-22, roadmap Step 26) is a timeline entry without a photo: *Moved to Denver*. With an end date it's an event over several days (*Iceland, March 17–24*) that gathers the Timeline photos dated within it, all of them or only those with `spanTag`. The rules are in `pc/lib/timeline.js`, shared by the phone and the PC.

```json
{
  "version": 2,
  "kind": "moment",
  "id": "3f2a9c41d07e4b5a9c2e8f61b0d3a7c5",
  "title": "Iceland",
  "date": "2024-03-17",
  "dateEnd": "2024-03-24",
  "spanTag": "iceland",
  "note": "",
  "tags": ["trip"],
  "visibility": "private",
  "createdAt": "2026-10-22T15:16:00.000Z",
  "updatedAt": "2026-10-22T15:16:00.000Z"
}
```

- `id`: 32 random hex characters. On the phone the file is `<id>.json` in the tag folder, so every backup carries it as it carries the photos' files; readers tell the two apart by `"kind": "moment"` (a Moment has no `contentHash`).
- `date`, `dateEnd`: `YYYY`, `YYYY-MM` or `YYYY-MM-DD`; `dateEnd` (or null) is after `date`. A span to the month or year takes in whole months or years.
- Deleting a Moment writes `{ "version": 2, "kind": "moment", "id", "cleared": true, "updatedAt" }`: readers delete their copy.
- **In a backup:** in the tag folder under its date, named for people looking: `PicJot Tags/2024/03/Moment - Iceland (3f2a9c).json` (a year-only date: `PicJot Tags/2024/…`). The backup's `.photoapp/index.json` keeps `moments: { <id>: <path> }`, so a new date or title moves the file instead of leaving a second one.

## Rules for readers

- Identify photos **only** by `contentHash` (after checking `hashAlgorithm`). Treat `hashSource: "redacted"` hashes as unmatched.
- Unknown extra fields: ignore. Missing fields: use the defaults (`significance` not marked, `timelineDate` null, `skipped` false, `keepOnPhone` false, `visibility` "private", stamps null).
- `"cleared": true` means the user removed all of this photo's tags: delete your copy of them; it carries no metadata of its own.
- Never write metadata into the image file itself.
- **Phone copies may have leftover bytes after the record.** Android's folder access doesn't truncate a file it overwrites, so before 2026-10-15 a shorter rewrite (e.g. a cleared record) kept the old file's tail. Read the **first complete JSON object** and ignore anything after it, as `parseLeadingJson` in `pc/lib/plan.js` does. The app now replaces files instead of overwriting them.

## History

- **Main photos by view (2026-10-23):** `timelineMainWeek` and `timelineMainMonth` are new (the timeline's Week and Month views). Schema still v2. (The timeline's Do Not Show list was briefly a tag file too, `"kind": "timeline-settings"`, the same day; it never left the test builds: the phone and the PC each keep their own list, outside the tag files.)

- **Timeline fields and Moments (2026-10-22, roadmap Step 26):** `timelineDate` is set by the app (a year, a month or a day), `timelineMain`, `undated` and `monthOnly` are new, and Moments are a second kind of record. Schema still v2: all optional, and older readers ignore what they don't know (an older PC tool counts a Moment's file as an unknown `.json`).

- **`important` renamed `notable` (2026-10-20, the user's call):** Notable is the tier below Timeline ("worth noting"). The app writes `"notable"`, rewrote every phone tag file saying `"important"` once (`withCurrentMark`, recorded as `marksNotable` in AsyncStorage; `updatedAt` untouched), and the next backups carry them over; `tools/update-marks.js` does it for what a backup folder holds beyond that. Readers keep reading `"important"` as `notable`. Schema still v2.
- **No `"normal"` (2026-10-20, the user's call):** "not marked" is the absence of `significance`; the app stopped writing `"normal"`, rewrote every tag file on the phone once without it (recorded as `noNormal`; `updatedAt` untouched), and the next PC and stick backups carried the cleaned files over; `tools/update-marks.js` (then `drop-normal.js`) cleans what a backup folder holds beyond that. Schema still v2: readers already treated a missing or unknown value as unmarked. Also from 2026-10-20: `creationTime` uses the photo's EXIF date when Android has no date taken.

- **`timeline` significance (2026-10-19):** a tier above `important`, replacing `utility` (which the user never used: 0 of 393 tag files). Schema still v2; the app writes an old Utility mark as `normal` when it next saves the photo.
- **`keepOnPhone` (2026-10-19):** added (schema still v2: an optional field; files are rewritten only when a photo is next saved). Setting it alone doesn't create a file: a photo that's only marked Keep on phone has none.
- **Cleared records (2026-10-15):** clearing a photo's tags writes `{ ..., "cleared": true, "updatedAt" }` instead of deleting the file (schema still v2; older readers that ignore the field see an empty record).
- **v2 (2026-10-13):** added `hashSource`, `relativePath`, `timelineDate`, `skipped`, `visibility`, `createdAt`. Files are written for Important/Utility marks even without text. On upgrade the app rewrites every existing file once (tracked as `sidecarSchema` in AsyncStorage).
- **v1 (2026-08-03):** `version`, `hashAlgorithm`, `contentHash`, `fileName`, `fileSize`, `creationTime`, `caption`, `tags`, `note`, `significance`; `updatedAt` added late in v1.
