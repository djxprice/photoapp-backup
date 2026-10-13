# PhotoApp metadata file (sidecar) — schema v2

The **canonical definition** of PhotoApp's per-photo metadata file. Code that writes it: `buildSidecar` in `src/lib/sidecar.js` (keep the two in step). Readers: the PC backup tool (`pc/backup.js`), and the future timeline web app and PC↔phone metadata sync.

## Where the files live

- **On the phone:** one file per photo, named `<contentHash>.json`, all in the single folder the user granted (e.g. `DCIM/photoAppMetadada`). Not next to the photo: Android's folder access (SAF) only grants one folder.
- **On the PC backup:** copied beside the photo as `<photo name>.json` (e.g. `2026/07/20260729_152730.json`), plus `"photoFile": "<photo name>"`.
- The phone's SQLite database is the source of truth while the app is installed. These files are the durable, portable copy that outlives the app or the phone.

## When a file exists

A photo has a metadata file when the user expressed something about it (`needsSidecar` in `src/lib/session.js`):

- it has a **caption, tags or a note**, or
- it is marked **Important** or **Utility** (even with no text).

Photos that were only skipped, or only left at Normal, have no file. Clearing everything from a photo deletes its file, as does deleting the photo from the device via the end-of-queue batch delete. Free up space keeps the file (the photo is on the PC).

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
| `significance` | `"utility"` \| `"normal"` \| `"important"` | How meaningful the photo is. Drives Revery scoring and the timeline (Important). |
| `skipped` | boolean | The user marked the photo reviewed without tagging it. |
| `visibility` | `"private"` \| `"family"` \| `"public"` | Who may see it on future shared timelines. Nested: private ⊂ family ⊂ public audiences. Defaults to `private`; the app has no selector yet. |
| `createdAt` | ISO 8601 UTC \| null | When the photo's metadata was first created. `null` for entries made before stamps existed. |
| `updatedAt` | ISO 8601 UTC \| null | When the user last changed caption, tags, note, significance or skipped (not bookkeeping). Used by PC↔phone sync to tell which side edited. |

## Rules for readers

- Identify photos **only** by `contentHash` (after checking `hashAlgorithm`). Treat `hashSource: "redacted"` hashes as unmatched.
- Unknown extra fields: ignore. Missing fields: use the defaults (`timelineDate` null, `skipped` false, `visibility` "private", stamps null).
- Never write metadata into the image file itself.

## History

- **v2 (2026-10-13):** added `hashSource`, `relativePath`, `timelineDate`, `skipped`, `visibility`, `createdAt`. Files are written for Important/Utility marks even without text. On upgrade the app rewrites every existing file once (tracked as `sidecarSchema` in AsyncStorage).
- **v1 (2026-08-03):** `version`, `hashAlgorithm`, `contentHash`, `fileName`, `fileSize`, `creationTime`, `caption`, `tags`, `note`, `significance`; `updatedAt` added late in v1.
