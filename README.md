# PhotoApp: app download, guide and PC backup tool

**PhotoApp** is a local-first Android app for capturing the story behind your photos: a quick daily review of new photos with a caption, tags, a note and a significance (Utility / Normal / Important), plus "Revisit memories" to resurface them. No cloud: your photos and tags stay on your phone and your own PC.

This repository holds the **Android app download**, a **how-to guide**, and the **PC backup tool** (Windows; ⚠️ **requires [Node.js](https://nodejs.org)**, see [section 3](#3-pc-backup-tool-windows)).

---

## 1. Install the app (Android)

**[⬇ Download the app (preview build, ~94 MB)](https://expo.dev/artifacts/eas/jODD5SiQSXXt4cDZ7B20xc4nT5MAfA6Rf1xR1dg0UxU.apk)**, or open the [build page](https://expo.dev/accounts/djxprice/projects/photoapp/builds/bb7fffbb-e5a4-44b1-889a-abd043429f4a) on your phone (or scan its QR code from a PC). *Hosted by Expo; this link expires on 29 Oct 2026, and new builds get a new link here.*

1. Open the downloaded `.apk` on the phone. If asked, allow your browser to **install unknown apps**.
2. On a **Samsung**, if the install is blocked, turn off *Settings → Security and privacy → Auto Blocker* for the install (turn it back on afterwards).
3. Installing a newer build later over this one keeps your tags.

## 2. Using the app

### First launch

1. **Allow photo access.** PhotoApp needs it to show your new photos. Nothing is uploaded anywhere.
2. **"Back up your tags?" → Choose Folder.** Android opens a folder picker: create a **new folder inside `DCIM`** (e.g. `DCIM/PhotoApp`), then tap **Use this folder → Allow**. PhotoApp saves a small file per tagged photo there, so your tags survive a phone change. (You can set or change it later in Settings.)

### Daily review

PhotoApp shows your **newest untagged photos**, 20 at a time (change this in Settings). For each photo:

- **Caption:** type what the moment was ("What's this moment?").
- **Tags:** type a tag and press Enter or comma to add it; tap a suggestion to reuse one of your common tags; tap a tag to remove it. **Long-press a suggestion to hide it** from the list (photos keep the tag; Settings → Hidden tag suggestions brings it back).
- **Same as previous:** copies the caption, tags, note and significance from the previous photo. On the first photo of a new batch, it uses the last ones you entered.
- **Significance:** **Utility** (receipts, screenshots, reminders), **Normal**, or **Important** (the memories you'll want to find again). Important opens the note.
- **+ Add note:** anything worth remembering: who, why, what happened.

Then:

| Button | What it does |
|---|---|
| **→** (green, bottom right) | Saves and moves to the next photo. Swiping left/right on the photo also works. |
| **←** (blue) | Saves and goes back to the previous photo. |
| **Skip** (yellow) | Marks the photo as reviewed with nothing to add. It won't come back for review; to tag it later, find it in **Choose photos** (it shows a ✓). |
| 🗑 **Trash** | *Marks* the photo for deletion (tap **UNDO** within 5 seconds to take it back). Marked photos are deleted **together at the end**, after Android asks you to confirm. |
| **✓ Done** (top left) | Stop for now: shows what you've reviewed and what's left. **Done for now** then closes the app. Anything you haven't reviewed comes back next time. |

Everything saves as you go. At the end of a batch you can delete the marked photos, **continue with older photos**, load the previous day or week, pick photos yourself, or tap **Done for now** to close the app.

### Elsewhere

- **✦ (top bar): Revisit memories:** your photos, a few at a time; swipe through them.
  - **Edit** (top right) opens the same caption, tags, significance and note as the daily review. **Next** saves and moves on; **Done** saves and goes back to the memory.
  - **More** (on the last memory) shows the next photos you haven't seen yet. Once you've seen them all, it starts over.
- **Grid (top bar): Choose photos:** pick any photos to tag or edit; a ✓ means already reviewed.
- **⚙ Settings:**
  - **Photo folders:** which folders feed your review (Camera by default; tick others you use).
  - **Photos per session:** 10, 20 or 50.
  - **Revisit memories:** how many photos per visit (any number from 1 to 999); the order (**Oldest to Newest**, **Newest to Oldest** or **Random**); and which photos (**Important**, **Tagged**, which includes Important, or **All**, which includes untagged photos from your photo folders). Changing the order or which photos starts over.
  - **Tag backup:** the folder your tag files go to.
  - **PC backup:** your last backup, and how many photos' tags you've changed since (run **Sync tags** on the PC to copy them; clearing a photo's tags removes them on the PC too).
  - **Free up space:** only after a PC backup (below). Deletes photos from the phone that the PC backup has verified copies of, keeping the ones you choose (tagged / Utility / Important). Android asks to confirm.

## 3. PC backup tool (Windows)

**[⬇ Download the backup tool (zip)](https://github.com/djxprice/photoapp-backup/archive/refs/heads/main.zip)**

> ⚠️ **Node.js is required.** The backup tool runs on Node.js, which most PCs don't have yet. Install it first from **[nodejs.org](https://nodejs.org)**: download the **LTS** version and accept the default options. You only need to do this once. (If it's missing, the backup window says so.)

Backs up **all photos** from your phone to a folder or drive on your PC over USB, filed by month (`YYYY/MM/`), with PhotoApp's tags and notes saved beside each tagged photo (e.g. `IMG_1234.jpg` + `IMG_1234.jpg.json`). Every copy is verified by content hash, re-runs only copy what's new, and it **never deletes anything from your phone**. It leaves a small receipt on the phone so the app's *Free up space* knows what's safely on the PC.

**Requirements:** Windows 10/11 and [Node.js](https://nodejs.org) (LTS). No other installs.

**Use it:**

1. Unzip the download anywhere (e.g. `Documents\PhotoApp Backup`). If Windows warns that the files came from the internet, right-click the zip → *Properties* → tick *Unblock* before unzipping.
2. Plug in your phone by USB, **unlock it**, and choose **File transfer** in the USB notification.
3. Double-click **`Backup photos.cmd`**. The first time, pick your backup folder; it's remembered, and you can add a desktop shortcut. Later runs: press **Enter** to back up, **S** to sync tags only (a few seconds: copies tag changes made on the phone since the last backup), or **C** to choose a different folder.

The first backup copies everything (a few minutes for a few GB); after that, runs take seconds plus any new photos.

<details>
<summary>Command line and details</summary>

```
node backup.js --to "E:\Photos"              # back up from the phone
node backup.js --to "E:\Photos" --dry-run    # list what would be copied
node backup.js --to "E:\Photos" --from <dir> # organise an already-copied folder
node backup.js --to "E:\Photos" --tags-only  # sync PhotoApp's tags only
```

- Reads the phone's `DCIM`, `Pictures` and `Download` folders over the same USB connection File Explorer uses (MTP via `mtp.ps1`); photos only, no videos; no developer mode needed. PhotoApp's tag files are found wherever you keep them inside `DCIM`, `Pictures`, `Download` or `Documents`.
- Every run first re-checks the PC copies; any that are missing or changed are copied again and never counted as backed up.
- Tags flow phone → PC: edited tags replace the PC's `<photo>.json`; tags cleared in the app (it leaves a "cleared" tag file) delete it. A tag file that's simply missing never deletes anything. Sync tags (**S**) does only this. The app's Settings → PC backup shows how many photos' tags changed since the last backup or sync.
- Date comes from PhotoApp's metadata, then EXIF, then the filename, then the phone's file date. Photos with no date go to `undated/`.
- The same photo is never stored twice (even if renamed); different photos with the same name get a short hash suffix.
- Bookkeeping lives in `<backup folder>\.photoapp\` (index, pull log, receipts).
- Tests: `npm test` (Node's built-in test runner).
</details>

## Metadata format

Each tagged photo's metadata is a small JSON file; the format is documented in [`metadata-schema.md`](metadata-schema.md).

---

*The PhotoApp source code itself is private; this repository is generated from it.*
