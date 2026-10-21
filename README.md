# PicJot: app download, guide and PC backup tool

*Take a Pic, Jot a note*

**PicJot** (formerly PhotoApp) is a local-first Android app for capturing the story behind your photos: a quick daily review of new photos with a caption, tags and a note, marking the ones that matter **Notable** or **Timeline**, plus 'Revisit Memories' to resurface them. No cloud: your photos and tags stay on your phone, your own PC, or a USB stick.

This repository holds the **Android app download**, a **how-to guide**, and the **PC backup tool**: PicJot WiFi Backup Manager for Windows, a one-file installer (see [section 3](#3-pc-backup-windows)). No PC? The app can also **back up to a USB stick** plugged into the phone ('Settings → Backup').

---

## 1. Install the app (Android)

**[⬇ Download the app (~66 MB)](https://github.com/djxprice/photoapp-backup/releases/latest/download/PicJot.apk)**: open this page on your phone and tap the link. *It always downloads the newest version; earlier ones are on the [releases page](https://github.com/djxprice/photoapp-backup/releases). For Android 11 or newer (Settings → About phone shows the version), on a 64-bit phone, which is almost every phone from the last several years.*

1. Open the downloaded `.apk` on the phone. If asked, allow your browser to **install unknown apps**.
2. On a **Samsung**, if the install is blocked, turn off *Settings → Security and privacy → Auto Blocker* for the install (turn it back on afterwards).
3. Installing a newer build later over this one keeps your tags.

## 2. Using the app

### First launch

1. **Welcome.** Three short pages explain the daily review. On the last one, **Choose Tag Folder** opens Android's folder picker: create a **new folder inside `DCIM`** called **PicJot Tags**, then tap **Use this folder → Allow**. PicJot saves a small file per tagged photo there, so your tags survive a phone change. (**Later** skips this; you can set it any time in Settings.)
2. **Allow photo access.** PicJot needs it to show your new photos. Nothing is uploaded anywhere.

### Daily review

PicJot shows your **newest untagged photos**, 20 at a time (change this in Settings). For each photo:

- **Same as Previous** (top right, above the caption): copies the caption, tags, note and mark (Notable or Timeline) from the previous photo, for a series of similar photos. On the first photo of a new batch, it uses the last ones you entered.
- **Caption:** type what the moment was ("What's this moment?").
- **Tags:** type a tag and press Enter or comma to add it; tap a suggestion to reuse one of your common tags; tap a tag to remove it. **Long-press a suggestion to hide it** from the list (photos keep the tag; 'Settings → Hidden Tag Suggestions' brings it back).
- **Notable** or **Timeline:** tap one to mark the photo, tap it again to clear it. **Notable** is for photos worth noting: more than most, but not a timeline moment; **Timeline** for the big moments (they'll make up your timeline, and count as Notable everywhere). A photo with neither simply isn't marked. Marking a photo opens the note. (Notable was called Important until October 2026.)
- **+ Jot a Note:** anything worth remembering: who, why, what happened.
- **Keep on Phone** (next to Notable and Timeline): tap it for photos you want to keep on the phone (to show people, or to have with you): **Free Up Space** never deletes them, even once they're backed up.

The photo shows when it was taken (e.g. "Yesterday · 3:42 PM"). When Android has no date for it (often a downloaded photo), PicJot uses the camera's date stored in the photo; one with no date at all (e.g. a saved web image) says when it was saved. Tap it for the photo's **details**: the date and time, file name and folder, size, camera and settings, its GPS position as coordinates (if it has one) with **Open in Maps** (opens your map app at that spot; the position is only sent when you tap it), and whether it's in your PC backup.

Then:

| Button | What it does |
|---|---|
| **→** (green, bottom right) | Saves and moves to the next photo. Swiping left/right on the photo also works. |
| **←** | Saves and goes back to the previous photo. |
| **Skip** | Marks the photo as reviewed with nothing to add and takes it out of this batch. It won't come back for review. To take a skip back, tap the mustard **⏭ N** badge (top left) and untick the photo: it returns to your review. |
| 🗑 **Trash** | *Marks* the photo for deletion. Marked photos are deleted **together at the end**, after Android asks you to confirm; if some aren't in your PC or USB stick backup yet, PicJot says so first (**Delete Anyway** or **Keep Marked**). Tap the red **🗑 N** badge (top left) to delete them now, or **Review Photos** to see them (newest first) and untick any you want to keep; that's also how you take one back. |
| **✓ Done** (top left) | Stop for now: shows what you've reviewed and what's left. **Done for Now** then closes the app. Anything you haven't reviewed comes back next time. |

Everything saves as you go. At the end of a batch you can delete the marked photos, **Continue with Older Photos**, load the **Previous Day** or **Previous Week**, **Choose Photos** yourself, or tap **Done for Now** to close the app.

### Elsewhere

- **✦** (top bar): **Revisit Memories**: your photos, a few at a time, with the date and time taken; swipe through them. **ⓘ** (top right) shows the photo's details.
  - **Edit** (top right) opens the same caption, tags, significance and note as the daily review. **Next** saves and moves on; **←** saves and goes back to the memory.
  - **More** (on the last memory) shows the next photos you haven't seen yet. Once you've seen them all, it starts over.
  - **Find** (top right) searches all your tagged and Notable photos. Type words from a caption, tag or note (a year such as 2025 works too), or tap a tag, a year and then a month; each shows how many photos it would give. Tap a photo to see the results full screen, then swipe through them. **←** goes back to the list, and again to your memories.
- **Grid** (top bar): **Choose Photos**: pick any photos to tag or edit, grouped by day (newest first), each thumbnail showing the whole photo. Badges, one per corner: a mustard ⏭ skipped (top-left), a red bin marked for deletion (top-right), a green tick tagged (bottom-left), a blue laptop backed up to your PC (bottom-right).
- **⚙ Settings** (top bar). Changes save as you make them; **←** goes back.
  - **Backup:**
    - **Back Up over Wi-Fi:** pair once with your PC (scan the QR code that **PicJot WiFi Backup Manager** shows on the PC), then tap **Back Up Now** whenever the PC is on: it runs in the background there. Settings shows the PC and its backup folder (e.g. *My PC > E:\Photos*). Same result as the USB backup: only photos the PC doesn't have are sent, each is checked on the PC, your tags go too, and the receipt 'Free Up Space' needs comes back. Keep PicJot open while it runs (the screen stays on); **Stop** keeps what was sent. If the PC's network address changes, PicJot finds it again by itself.
    - **Back Up to a USB Stick:** no computer needed. Plug a USB-C stick into the phone (or a stick with an adapter), tap **Choose a Folder**, and in Android's folder picker open the menu (☰), tap the stick, create a folder (e.g. *PicJot Backup*) and tap **Use this folder → Allow**; PicJot shows it as e.g. *Lexar > PicJot Backup*. Then tap **Back Up Now**: only photos not on the stick yet are copied, each is read back from the stick and checked before it counts, and your tags go too. The stick gets the same folders as the PC backup (by year, then month), so you can also open it on a computer. Keep PicJot open and the stick plugged in while it runs (the screen stays on); if the stick comes out, the next backup carries on where it stopped. Sticks come formatted FAT32 or exFAT; both are fine. A stick is one copy: keep it somewhere safe, away from the phone, or back up to your PC as well.
    - **Free Up Space:** only after a backup: to your PC (below) or to a USB stick. It shows your last backup and how many photos' tags you've changed since (run **Sync Tags Only** on the PC to copy them; clearing a photo's tags removes them on the PC too). At the top it names the backup it checks against: your PC's backup folder, or the USB stick's name and folder, with the last backup date; with both (the stick plugged in), choose **Either Backup**, **Your PC**, **USB Stick** or **Both Backups** (only photos with a copy in each). It deletes photos from the phone that a backup has verified copies of, keeping the ones you choose: **Keep Photos You Haven't Reviewed** and **Keep Notable Photos**, Timeline included (both on by default), or **Keep Tagged Photos**. Photos marked **Keep on Phone** always stay, and photos taken after the last backup are never touched. **Review N Photos** then shows exactly which photos would be deleted; untick any to keep (they're marked 'Keep on Phone', so they aren't offered again), then **Delete** (Android asks to confirm). Photos backed up only to a USB stick count while it's plugged in, and their copies on the stick are read and checked once more just before deleting (every copy, if you chose USB Stick or Both Backups): if any doesn't match, nothing is deleted. Deleted photos skip the phone's Trash: your backup is the copy.
    - **Tag Folder:** the folder your tag files go to (**Change** to pick another: PicJot offers to move your tag files and backup receipts into it, checking each one, and removes the old folder once it's empty).
  - **Daily Review:**
    - **Photos per Session:** 10, 20 or 50.
    - **Photo Folders** (its own page): which folders feed your review (Camera by default; tick others like Expert RAW if you use them).
    - **Daily Reminder:** a notification every day at a time you choose (**Reminder Time**: 7:00 PM unless you change it). **Skip If I've Opened PicJot That Day** skips it on days you've already opened PicJot. Android asks to allow notifications the first time you switch it on.
  - **Revisit Memories:** **Photos per Visit** (any number from 1 to 999); **Order** (**Oldest to Newest**, **Newest to Oldest** or **Random**); **Show**, which photos (**Notable**, which includes Timeline, **Tagged**, which includes both, or **All**, which includes untagged photos from your photo folders). And **Each Visit**: **Continue** picks up where the last visit left off (no repeats until you've seen them all; changing 'Order' or 'Show' starts over), **Start Fresh** starts from the beginning every time, and **Random** starts each visit at a random point in the order and carries on from there.
  - **Hidden Tag Suggestions** (only when you've hidden some): **Show** puts one back in the suggestions.
  - **About:** the version, and a link to this guide.

## 3. PC backup (Windows)

**[⬇ Download PicJot WiFi Backup Manager (installer, about 23 MB)](https://github.com/djxprice/photoapp-backup/releases/latest/download/PicJotSetup.exe)** for Windows 10 and 11. Nothing else to install.

Backs up **all photos** from your phone to a folder or drive on your PC over your home Wi-Fi, filed by month (`YYYY/MM/`), with PicJot's tags and notes saved beside each tagged photo (e.g. `IMG_1234.jpg` + `IMG_1234.jpg.json`). Every copy is verified by content hash, later backups only send what's new, and it **never deletes anything from your phone**. It leaves a small receipt on the phone so the app's 'Free Up Space' knows what's safely on the PC.

1. Open the downloaded **PicJotSetup.exe**. Windows may say *Windows protected your PC*, because the installer isn't signed yet: click **More info**, then **Run anyway**.
2. Click **Install**. It installs for you only, so Windows doesn't ask for an administrator, and starts by itself. The first time, choose the folder or drive for your backup.
3. Windows asks whether PicJot WiFi Backup Manager may use your network: choose **Allow** (private networks are enough). If Windows has your home network set to *Public*, switch it to *Private* (Settings → Network & internet → your connection → Network profile type).
4. A page with a QR code opens. In PicJot: **Settings → Backup → Back Up over Wi-Fi → Pair with PC**, and scan the code (once; the phone remembers the PC). Pairing the same phone again later replaces its earlier pairing.
5. Tap **Back Up Now** whenever the PC is on. PicJot WiFi Backup Manager runs in the background with an icon by the clock (click **^** if you don't see it) and starts with Windows. A notification on the PC says when a backup has finished, and the PC doesn't go to sleep while one runs.

**The icon by the clock:** click it to see the PicJot WiFi Backup Manager page (the last backup, paired phones listed by name and model, recent activity; **Forget** unpairs a phone you no longer use, e.g. a lost one). Right-click it for **Pair a Phone**, **Change Backup Folder...**, **Start with Windows** (on or off) or **Quit**.

The connection is encrypted with the PC's own certificate, which the phone checks; only paired phones are accepted, and only on your home network. A backup that's interrupted carries on where it stopped next time. If the backup drive is unplugged, the phone says so.

**Updating:** run a newer installer over it; it stops the running copy first (finishing any backup). **Uninstalling:** Settings → Apps → PicJot WiFi Backup Manager. Your backed-up photos are never touched, and its settings (paired phones, the backup folder) are kept in case you install it again.

<details>
<summary>Advanced: back up over a USB cable (needs Node.js)</summary>

The older USB-cable tool is still here for people who prefer a cable: **[download the backup tool (zip)](https://github.com/djxprice/photoapp-backup/archive/refs/heads/main.zip)**. It backs up to the same folder in the same way.

> ⚠️ **Node.js is required.** The backup tool runs on Node.js, which most PCs don't have yet. Install it first from **[nodejs.org](https://nodejs.org)**: download the **LTS** version and accept the default options. You only need to do this once. (If it's missing, the backup window says so.)

Backs up **all photos** from your phone to a folder or drive on your PC over USB or Wi-Fi, filed by month (`YYYY/MM/`), with PicJot's tags and notes saved beside each tagged photo (e.g. `IMG_1234.jpg` + `IMG_1234.jpg.json`). Every copy is verified by content hash, re-runs only copy what's new, and it **never deletes anything from your phone**. It leaves a small receipt on the phone so the app's 'Free Up Space' knows what's safely on the PC.

**Requirements:** Windows 10/11 and [Node.js](https://nodejs.org) (LTS). No other installs.

**Use it:**

1. Unzip the download anywhere (e.g. `Documents\PicJot Backup`). If Windows warns that the files came from the internet, right-click the zip → *Properties* → tick *Unblock* before unzipping.
2. Plug in your phone by USB, **unlock it**, and choose **File transfer** in the USB notification.
3. Double-click **`Backup photos.cmd`**. The first time, pick your backup folder; it's remembered, and you can add a desktop shortcut. Later runs: press **Enter** to **Back Up Photos and Tags**, **S** to **Sync Tags Only** (a few seconds: copies tag changes made on the phone since the last backup), or **C** to **Choose a Different Folder**.

The first backup copies everything (a few minutes for a few GB); after that, runs take seconds plus any new photos.

The source of PicJot WiFi Backup Manager is in this repository too (`receiver.js`, `tray/`); `PicJot WiFi Backup Manager.cmd` runs it with Node.js instead of the installer.

Command line:

```
node backup.js --to "E:\Photos"              # back up from the phone
node backup.js --to "E:\Photos" --dry-run    # list what would be copied
node backup.js --to "E:\Photos" --from <dir> # organise an already-copied folder
node backup.js --to "E:\Photos" --tags-only  # sync PicJot's tags only
```

- Reads the phone's `DCIM`, `Pictures` and `Download` folders over the same USB connection File Explorer uses (MTP via `mtp.ps1`); photos only, no videos; no developer mode needed. PicJot's tag files are found wherever you keep them inside `DCIM`, `Pictures`, `Download` or `Documents`.
- Every run first re-checks the PC copies; any that are missing or changed are copied again and never counted as backed up.
- Tags flow phone → PC: edited tags replace the PC's `<photo>.json`; tags cleared in the app (it leaves a "cleared" tag file) delete it. A tag file that's simply missing never deletes anything. **Sync Tags Only** (**S**) does only this. The app's 'Settings → Backup → Free Up Space' shows how many photos' tags changed since the last backup or sync.
- The date comes from the photo's EXIF date, then PicJot's tag file (for HEIC, RAW and PNG), then the filename, then the phone's file date. Photos with no date go to `undated/`.
- The same photo is never stored twice (even if renamed); different photos with the same name get a short hash suffix.
- Bookkeeping lives in `<backup folder>\.photoapp\` (index, pull log, receipts).
- Tests: `npm test` (Node's built-in test runner).
</details>

## Metadata format

Each tagged photo's metadata is a small JSON file; the format is documented in [`metadata-schema.md`](metadata-schema.md).

---

*The PicJot source code itself is private; this repository is generated from it.*
