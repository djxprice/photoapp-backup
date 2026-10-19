# PicJot: app download, guide and PC backup tool

*Take a Pic, Jot a note*

**PicJot** (formerly PhotoApp) is a local-first Android app for capturing the story behind your photos: a quick daily review of new photos with a caption, tags and a note, marking the ones that matter **Important** or **Timeline**, plus "Revisit memories" to resurface them. No cloud: your photos and tags stay on your phone and your own PC.

This repository holds the **Android app download**, a **how-to guide**, and the **PC backup tool** (Windows; ⚠️ **requires [Node.js](https://nodejs.org)**, see [section 3](#3-pc-backup-tool-windows)).

---

## 1. Install the app (Android)

**[⬇ Download the app (~41 MB)](https://github.com/djxprice/photoapp-backup/releases/latest/download/PicJot.apk)**: open this page on your phone and tap the link. *It always downloads the newest version; earlier ones are on the [releases page](https://github.com/djxprice/photoapp-backup/releases). For 64-bit Android phones, which is almost every phone from the last several years.*

1. Open the downloaded `.apk` on the phone. If asked, allow your browser to **install unknown apps**.
2. On a **Samsung**, if the install is blocked, turn off *Settings → Security and privacy → Auto Blocker* for the install (turn it back on afterwards).
3. Installing a newer build later over this one keeps your tags.

## 2. Using the app

### First launch

1. **Welcome.** Three short pages explain the daily review. On the last one, **Choose tag folder** opens Android's folder picker: create a **new folder inside `DCIM`** (e.g. `DCIM/PicJot`), then tap **Use this folder → Allow**. PicJot saves a small file per tagged photo there, so your tags survive a phone change. (**Later** skips this; you can set it any time in Settings.)
2. **Allow photo access.** PicJot needs it to show your new photos. Nothing is uploaded anywhere.

### Daily review

PicJot shows your **newest untagged photos**, 20 at a time (change this in Settings). For each photo:

- **Caption:** type what the moment was ("What's this moment?").
- **Tags:** type a tag and press Enter or comma to add it; tap a suggestion to reuse one of your common tags; tap a tag to remove it. **Long-press a suggestion to hide it** from the list (photos keep the tag; Settings → Hidden tag suggestions brings it back).
- **Same as previous:** copies the caption, tags, note and mark (Important or Timeline) from the previous photo. On the first photo of a new batch, it uses the last ones you entered.
- **Important** or **Timeline:** tap one to mark the photo, tap it again to clear it. **Important** is for the memories you'll want to find again; **Timeline** for the big moments (they'll make up your timeline, and count as Important everywhere). A photo with neither is Normal. Marking a photo opens the note.
- **+ Jot a note:** anything worth remembering: who, why, what happened.
- **Keep on phone** (next to Important and Timeline): tap it for photos you want to keep on the phone (to show people, or to have with you): **Free up space** never deletes them, even once they're backed up.

The photo shows when it was taken (e.g. "Yesterday · 3:42 PM"; photos saved from messages or the web that have no date taken say when they were saved). Tap it for the photo's **details**: the date and time, file name and folder, size, camera and settings, its GPS position as coordinates (if it has one) with **Open in Maps** (opens your map app at that spot; the position is only sent when you tap it), and whether it's in your PC backup.

Then:

| Button | What it does |
|---|---|
| **→** (green, bottom right) | Saves and moves to the next photo. Swiping left/right on the photo also works. |
| **←** | Saves and goes back to the previous photo. |
| **Skip** | Marks the photo as reviewed with nothing to add and takes it out of this batch. It won't come back for review. To take a skip back, tap the mustard **⏭ N** badge (top left) and untick the photo: it returns to your review. |
| 🗑 **Trash** | *Marks* the photo for deletion. Marked photos are deleted **together at the end**, after Android asks you to confirm. Tap the red **🗑 N** badge (top left) to delete them now, or **Review photos** to see them (newest first) and untick any you want to keep; that's also how you take one back. |
| **✓ Done** (top left) | Stop for now: shows what you've reviewed and what's left. **Done for now** then closes the app. Anything you haven't reviewed comes back next time. |

Everything saves as you go. At the end of a batch you can delete the marked photos, **continue with older photos**, load the previous day or week, pick photos yourself, or tap **Done for now** to close the app.

### Elsewhere

- **✦** (top bar): **Revisit memories**: your photos, a few at a time, with the date and time taken; swipe through them. **ⓘ** (top right) shows the photo's details.
  - **Edit** (top right) opens the same caption, tags, significance and note as the daily review. **Next** saves and moves on; **←** saves and goes back to the memory.
  - **More** (on the last memory) shows the next photos you haven't seen yet. Once you've seen them all, it starts over.
  - **Find** (top right) searches all your tagged and Important photos. Type words from a caption, tag or note (a year such as 2025 works too), or tap a tag, a year and then a month; each shows how many photos it would give. Tap a photo to see the results full screen, then swipe through them. **←** goes back to the list, and again to your memories.
- **Grid** (top bar): **Choose photos**: pick any photos to tag or edit, grouped by day (newest first), each thumbnail showing the whole photo. Badges, one per corner: a mustard ⏭ skipped (top-left), a red bin marked for deletion (top-right), a green tick tagged (bottom-left), a blue laptop backed up to your PC (bottom-right).
- **⚙ Settings** (top bar). Changes save as you make them; **←** goes back.
  - **Backup:**
    - **Back up over Wi-Fi:** pair once with your PC (scan the QR code that **PicJot Receiver** shows on the PC), then tap **Back up now** whenever the PC is on: the receiver runs in the background there. Same result as the USB backup: only photos the PC doesn't have are sent, each is checked on the PC, your tags go too, and the receipt Free up space needs comes back. Keep PicJot open while it runs (the screen stays on); **Stop** keeps what was sent. If the PC's network address changes, PicJot finds it again by itself.
    - **Free up space:** only after a PC backup (below). It shows your last backup and how many photos' tags you've changed since (run **Sync tags** on the PC to copy them; clearing a photo's tags removes them on the PC too). It deletes photos from the phone that the PC backup has verified copies of, keeping the ones you choose: photos you **haven't reviewed yet** and **Important** ones, Timeline included (both on by default), or all tagged photos. Photos marked **Keep on phone** always stay, and photos taken after the last backup are never touched. **Review N photos** then shows exactly which photos would be deleted; untick any to keep (they're marked Keep on phone, so they aren't offered again), then **Delete** (Android asks to confirm). Deleted photos skip Samsung's Trash: your PC copy is the backup.
    - **Tag folder:** the folder your tag files go to (**Change** to pick another).
  - **Daily review:**
    - **Photos per session:** 10, 20 or 50.
    - **Photo folders** (its own page): which folders feed your review (Camera by default; tick others like Expert RAW if you use them).
    - **Daily reminder:** a notification every day at a time you choose (7:00 PM unless you change it). Optionally skipped on days you've already opened PicJot. Android asks to allow notifications the first time you switch it on.
  - **Revisit memories:** how many photos per visit (any number from 1 to 999); the order (**Oldest to Newest**, **Newest to Oldest** or **Random**); and which photos (**Important**, which includes Timeline, **Tagged**, which includes both, or **All**, which includes untagged photos from your photo folders). And **Each visit**: **Continue** picks up where the last visit left off (no repeats until you've seen them all; changing the order or which photos starts over), **Start fresh** starts from the beginning every time, and **Random** starts each visit at a random point in the order and carries on from there.
  - **Hidden tag suggestions** (only when you've hidden some): **Show** puts one back in the suggestions.
  - **About:** the version, and a link to this guide.

## 3. PC backup tool (Windows)

**[⬇ Download the backup tool (zip)](https://github.com/djxprice/photoapp-backup/archive/refs/heads/main.zip)**

> ⚠️ **Node.js is required.** The backup tool runs on Node.js, which most PCs don't have yet. Install it first from **[nodejs.org](https://nodejs.org)**: download the **LTS** version and accept the default options. You only need to do this once. (If it's missing, the backup window says so.)

Backs up **all photos** from your phone to a folder or drive on your PC over USB or Wi-Fi, filed by month (`YYYY/MM/`), with PicJot's tags and notes saved beside each tagged photo (e.g. `IMG_1234.jpg` + `IMG_1234.jpg.json`). Every copy is verified by content hash, re-runs only copy what's new, and it **never deletes anything from your phone**. It leaves a small receipt on the phone so the app's *Free up space* knows what's safely on the PC.

**Requirements:** Windows 10/11 and [Node.js](https://nodejs.org) (LTS). No other installs.

**Use it:**

1. Unzip the download anywhere (e.g. `Documents\PicJot Backup`). If Windows warns that the files came from the internet, right-click the zip → *Properties* → tick *Unblock* before unzipping.
2. Plug in your phone by USB, **unlock it**, and choose **File transfer** in the USB notification.
3. Double-click **`Backup photos.cmd`**. The first time, pick your backup folder; it's remembered, and you can add a desktop shortcut. Later runs: press **Enter** to back up, **S** to sync tags only (a few seconds: copies tag changes made on the phone since the last backup), or **C** to choose a different folder.

The first backup copies everything (a few minutes for a few GB); after that, runs take seconds plus any new photos.

**Over Wi-Fi instead (no cable):**

1. Double-click **`PicJot Receiver.cmd`** (in the same folder). The first time it sets itself up (a few seconds) and asks for the backup folder if you haven't chosen one with the USB backup. Then **PicJot Receiver runs in the background**, with an icon by the clock (click **^** if you don't see it), and **starts with Windows** from then on. A page with a QR code opens.
2. The first time, Windows asks whether to allow Node.js: allow it on **private networks**. If Windows has your home network set to *Public*, switch it to *Private* (Settings → Network & internet → your connection → Network profile type).
3. In PicJot: **Settings → Backup → Back up over Wi-Fi → Pair with PC**, and scan the code (once; the phone remembers the PC). Pairing the same phone again later replaces its earlier pairing.
4. Tap **Back up now** whenever the PC is on. A notification on the PC says when a backup has finished, and the PC doesn't go to sleep while one runs.

**The icon by the clock:** click it to see the receiver's page (the last backup, paired phones, recent activity; **Forget** unpairs a phone you no longer use, e.g. a lost one). Right-click it to **pair a phone**, **change the backup folder**, turn **Start with Windows** off or on, or **quit**.

The connection is encrypted with the PC's own certificate, which the phone checks; only paired phones are accepted, and only on your home network. A backup that's interrupted carries on where it stopped next time. If the backup drive is unplugged, the phone says so.

<details>
<summary>Command line and details</summary>

```
node backup.js --to "E:\Photos"              # back up from the phone
node backup.js --to "E:\Photos" --dry-run    # list what would be copied
node backup.js --to "E:\Photos" --from <dir> # organise an already-copied folder
node backup.js --to "E:\Photos" --tags-only  # sync PicJot's tags only
```

- Reads the phone's `DCIM`, `Pictures` and `Download` folders over the same USB connection File Explorer uses (MTP via `mtp.ps1`); photos only, no videos; no developer mode needed. PicJot's tag files are found wherever you keep them inside `DCIM`, `Pictures`, `Download` or `Documents`.
- Every run first re-checks the PC copies; any that are missing or changed are copied again and never counted as backed up.
- Tags flow phone → PC: edited tags replace the PC's `<photo>.json`; tags cleared in the app (it leaves a "cleared" tag file) delete it. A tag file that's simply missing never deletes anything. Sync tags (**S**) does only this. The app's Settings → PC backup shows how many photos' tags changed since the last backup or sync.
- Date comes from PicJot's metadata, then EXIF, then the filename, then the phone's file date. Photos with no date go to `undated/`.
- The same photo is never stored twice (even if renamed); different photos with the same name get a short hash suffix.
- Bookkeeping lives in `<backup folder>\.photoapp\` (index, pull log, receipts).
- Tests: `npm test` (Node's built-in test runner).
</details>

## Metadata format

Each tagged photo's metadata is a small JSON file; the format is documented in [`metadata-schema.md`](metadata-schema.md).

---

*The PicJot source code itself is private; this repository is generated from it.*
