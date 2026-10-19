# PicJot metadata file (sidecar) — schema v2

The **canonical definition** of PicJot's per-photo metadata file. Code that writes it: `buildSidecar` in `src/lib/sidecar.js` (keep the two in step). Readers: the PC backup tool (`pc/backup.js`), and the future timeline web app and PC↔phone metadata sync.

## Where the files live

- **On the phone:** one file per photo, named `<contentHash>.json`, all in the single folder the user granted (e.g. `DCIM/photoAppMetadada`). Not next to the photo: Android's folder access (SAF) only grants one folder.
- **On the PC backup:** copied beside the photo as `<photo file name>.json` (e.g. `2026/07/20260729_152730.jpg.json`, the Google Takeout convention), plus `"photoFile": "<photo file name>"`. A RAW+JPEG pair (`IMG.jpg` + `IMG.dng`) gets one file each. Before 2026-10-15 the name dropped the photo's extension (`20260729_152730.json`), so such a pair overwrote each other's tags; the backup tool renames old files on its next run.
- The phone's SQLite database is the source of truth while the app is installed. These files are the durable, portable copy that outlives the app or the phone.

## When a file exists

A photo has a metadata file when the user expressed something about it (`needsSidecar` in `src/lib/session.js`):

- it has a **caption, tags or a note**, or
- it is marked **Important** or **Timeline** (even with no text). (Until 2026-10-19 also **Utility**.)

Photos that were only skipped, or only left at Normal, have no file. Deleting the photo from the device via the end-of-queue batch delete deletes its file. Free up space keeps the file (the photo is on the PC).

**Clearing everything from a photo** replaces its file with a **cleared record** (since 2026-10-15), so the PC's *Sync tags* removes its copy of the tags too:

```json
{ "version": 2, "hashAlgorithm": "md5", "hashSource": "original", "contentHash": "<md5>",
  "fileName": "20260729_152730.jpg", "cleared": true, "updatedAt": "2026-10-15T09:00:00.000Z" }
```

A cleared record has no caption, tags, note or significance. Tagging the photo again overwrites it with a normal record. Readers must **only** remove tags on an explicit `"cleared": true`. A missing file never means "cleared": the photo may have been deleted, or a listing may be incomplete.

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
  "significance": "important",
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
| `creationTime` | ISO 8601 UTC \| null | When the photo was taken (the phone's media date). |
| `timelineDate` | `YYYY-MM-DD` \| ISO \| null | User override for where the photo belongs in time (e.g. a scan of a 1987 print). **Readers use `timelineDate ?? creationTime`.** Not set by the app yet. |
| `caption` | string | The caption ("What's this moment?"), trimmed. |
| `tags` | string[] | Tags, trimmed, empty ones removed, in the user's spelling. |
| `note` | string | Free-text note. |
| `significance` | `"normal"` \| `"important"` \| `"timeline"` | How meaningful the photo is. `important`: a memory worth revisiting. `timeline` (since 2026-10-19): one of the big moments, the photos the timeline is made of; it also counts as Important everywhere (Revisit memories, Free up space). Files written before 2026-10-19 may say `"utility"`: read it, and any unknown value, as `normal`. |
| `skipped` | boolean | The user marked the photo reviewed without tagging it (the **Skip** button). |
| `keepOnPhone` | boolean | The user marked the photo **Keep on phone**: the app's Free up space never deletes it from the phone, even once it's backed up. A phone-side wish; PC readers can ignore it. Missing = `false` (files written before 2026-10-19). |
| `visibility` | `"private"` \| `"family"` \| `"public"` | Who may see it on future shared timelines. Nested: private ⊂ family ⊂ public audiences. Defaults to `private`; the app has no selector yet. |
| `createdAt` | ISO 8601 UTC \| null | When the photo's metadata was first created. `null` for entries made before stamps existed. |
| `updatedAt` | ISO 8601 UTC \| null | When the user last changed caption, tags, note, significance, skipped or keepOnPhone (not bookkeeping). Used by PC↔phone sync to tell which side edited. |

## Rules for readers

- Identify photos **only** by `contentHash` (after checking `hashAlgorithm`). Treat `hashSource: "redacted"` hashes as unmatched.
- Unknown extra fields: ignore. Missing fields: use the defaults (`timelineDate` null, `skipped` false, `keepOnPhone` false, `visibility` "private", stamps null).
- `"cleared": true` means the user removed all of this photo's tags: delete your copy of them; it carries no metadata of its own.
- Never write metadata into the image file itself.
- **Phone copies may have leftover bytes after the record.** Android's folder access doesn't truncate a file it overwrites, so before 2026-10-15 a shorter rewrite (e.g. a cleared record) kept the old file's tail. Read the **first complete JSON object** and ignore anything after it, as `parseLeadingJson` in `pc/lib/plan.js` does. The app now replaces files instead of overwriting them.

## History

- **`timeline` significance (2026-10-19):** a tier above `important`, replacing `utility` (which the user never used: 0 of 393 tag files). Schema still v2; the app writes an old Utility mark as `normal` when it next saves the photo.
- **`keepOnPhone` (2026-10-19):** added (schema still v2: an optional field; files are rewritten only when a photo is next saved). Setting it alone doesn't create a file: a photo that's only marked Keep on phone has none.
- **Cleared records (2026-10-15):** clearing a photo's tags writes `{ ..., "cleared": true, "updatedAt" }` instead of deleting the file (schema still v2; older readers that ignore the field see an empty record).
- **v2 (2026-10-13):** added `hashSource`, `relativePath`, `timelineDate`, `skipped`, `visibility`, `createdAt`. Files are written for Important/Utility marks even without text. On upgrade the app rewrites every existing file once (tracked as `sidecarSchema` in AsyncStorage).
- **v1 (2026-08-03):** `version`, `hashAlgorithm`, `contentHash`, `fileName`, `fileSize`, `creationTime`, `caption`, `tags`, `note`, `significance`; `updatedAt` added late in v1.
