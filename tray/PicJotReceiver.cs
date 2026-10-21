// PicJot WiFi Backup Manager (called PicJot Receiver until 2026-10-20): the
// Wi-Fi receiver's icon by the clock (roadmap Step 33, stage 2;
// docs/wifi-backup.md). It runs `node receiver.js --background` hidden, shows
// the receiver's state, keeps the PC awake while a phone backs up, and starts
// with Windows when asked (HKCU Run key).
//
// Built on the user's PC by receiver-tray.ps1 with the C# compiler that comes
// with Windows (.NET Framework 4), so it needs no download and, being a
// Windows program rather than a script, opens no console window at login.
// That compiler only knows C# 5: no $"..." strings, no ?. operator.
// The installer (Step 27b, tools/build-pc.ps1) ships it built, next to
// "PicJot WiFi Receiver.exe" (the receiver with Node.js built in), which it
// then runs instead of `node receiver.js`.
//
//   "PicJot WiFi Backup Manager.exe"          start (or, if running, open its
//                                             page); the first start on a PC
//                                             also turns on Start with Windows
//                                             (%APPDATA%\PhotoApp\receiver-tray.json
//                                             remembers that it happened)
//   "PicJot WiFi Backup Manager.exe" --quit   ask the running one to quit
//                                   --quit --wait  ... and wait until it has
//                                             (the installer, before it
//                                             replaces or removes the files)
//
// The mutex and quit event keep their old names, so this program and the old
// "PicJot Receiver.exe" can stop each other.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

// Its name in Task Manager and in the file's properties (the installer's
// build adds the version).
[assembly: AssemblyTitle("PicJot WiFi Backup Manager")]
[assembly: AssemblyProduct("PicJot")]

static class Program
{
    [STAThread]
    static int Main(string[] args)
    {
        if (Array.IndexOf(args, "--quit") >= 0)
        {
            try { EventWaitHandle.OpenExisting(Tray.QuitEventName).Set(); }
            catch (WaitHandleCannotBeOpenedException) { }
            if (Array.IndexOf(args, "--wait") >= 0) WaitUntilGone();
            return 0;
        }
        bool created;
        using (Mutex mutex = new Mutex(true, Tray.MutexName, out created))
        {
            if (!created)
            {
                // Already running: show its page instead of a second icon.
                Tray.OpenUrl(Tray.StatusUrl);
                return 0;
            }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Tray tray = new Tray();
            Application.ThreadException += delegate (object s, ThreadExceptionEventArgs e) { tray.Note("Tray problem: " + e.Exception); };
            if (!tray.Start()) return 1;
            Application.Run();
            GC.KeepAlive(mutex);
        }
        return 0;
    }

    // Waits until the running copy has quit: it holds the mutex until it
    // ends, after its receiver has stopped (a backup being filed is finished
    // first, up to 15 minutes).
    static void WaitUntilGone()
    {
        Mutex m;
        try { m = Mutex.OpenExisting(Tray.MutexName); }
        catch (WaitHandleCannotBeOpenedException) { return; }
        using (m)
        {
            bool owned = false;
            try { owned = m.WaitOne(TimeSpan.FromMinutes(16)); }
            catch (AbandonedMutexException) { owned = true; } // it ended without letting go: also gone
            if (owned) m.ReleaseMutex();
        }
    }
}

class Tray
{
    public const string MutexName = @"Local\PicJotReceiver";
    public const string QuitEventName = @"Local\PicJotReceiverQuit";
    public const string StatusUrl = "http://127.0.0.1:47824/";
    const string PairUrl = StatusUrl + "pair";
    const string ApiUrl = StatusUrl + "api/status";
    public const string AppName = "PicJot WiFi Backup Manager";
    const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    const string RunName = AppName;
    const string OldRunName = "PicJot Receiver"; // its Start with Windows entry until 2026-10-20
    // The receiver with Node.js built in, installed beside this program.
    const string ReceiverExe = "PicJot WiFi Receiver.exe";
    const int ExitPortInUse = 3;

    [DllImport("kernel32.dll")]
    static extern uint SetThreadExecutionState(uint flags);
    const uint ES_CONTINUOUS = 0x80000000;
    const uint ES_SYSTEM_REQUIRED = 0x00000001;

    bool firstRun;
    readonly string dir = Path.GetDirectoryName(Application.ExecutablePath);
    readonly string configDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "PhotoApp");
    readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
    readonly List<string> output = new List<string>();
    NotifyIcon icon;
    ToolStripMenuItem startItem;
    Control ui;
    EventWaitHandle quitEvent;
    Process node; // the receiver, packaged or `node receiver.js`
    string nodePath; // null when packaged
    bool quitting, awake, baselineSet, pairShown, stopped;
    string seenBackupAt, seenProblem;
    int restarts;
    DateTime restartWindow = DateTime.MinValue;

    string ConfigFile { get { return Path.Combine(configDir, "backup.json"); } }
    string StateFile { get { return Path.Combine(configDir, "receiver-tray.json"); } }

    bool Packaged { get { return File.Exists(Path.Combine(dir, ReceiverExe)); } }

    public bool Start()
    {
        if (Packaged) nodePath = null;
        else if (!File.Exists(Path.Combine(dir, "receiver.js")))
        {
            MessageBox.Show("receiver.js is missing from " + dir + ". Keep " + AppName + " in the PicJot Backup folder.", AppName, MessageBoxButtons.OK, MessageBoxIcon.Error);
            return false;
        }
        else
        {
            nodePath = FindNode();
            if (nodePath == null)
            {
                if (MessageBox.Show(AppName + " needs Node.js. Install the LTS version from nodejs.org, then open " + AppName + " again.\n\nOpen nodejs.org now?", AppName, MessageBoxButtons.YesNo, MessageBoxIcon.Information) == DialogResult.Yes)
                    OpenUrl("https://nodejs.org");
                return false;
            }
        }
        if (ReadFolder() == null)
        {
            string picked = PickFolder(null);
            if (picked == null)
            {
                MessageBox.Show("No backup folder chosen, so " + AppName + " didn't start. Open it again to choose one.", AppName, MessageBoxButtons.OK, MessageBoxIcon.Information);
                return false;
            }
            SaveFolder(picked);
        }

        // A hidden control, so other threads can hand work to this one.
        ui = new Control();
        ui.CreateControl();
        IntPtr unused = ui.Handle;
        quitEvent = new EventWaitHandle(false, EventResetMode.AutoReset, QuitEventName);
        ThreadPool.RegisterWaitForSingleObject(quitEvent, delegate { ui.BeginInvoke(new Action(Quit)); }, null, -1, false);

        BuildIcon();
        StartNode();

        // The first start on this PC (however it was opened) turns on Start
        // with Windows; after that the menu decides.
        firstRun = !File.Exists(StateFile);
        if (firstRun)
        {
            SetStartWithWindows(true);
            try
            {
                Dictionary<string, object> state = new Dictionary<string, object>();
                state["firstRunAt"] = DateTime.UtcNow.ToString("o");
                File.WriteAllText(StateFile, new JavaScriptSerializer().Serialize(state), new UTF8Encoding(false));
            }
            catch (Exception e) { Note("Couldn't save receiver-tray.json: " + e.Message); }
        }
        // The program may have moved, or been renamed (the old entry goes).
        else if (IsStartWithWindows()) SetStartWithWindows(true);
        startItem.Checked = IsStartWithWindows();
        if (firstRun)
            icon.ShowBalloonTip(8000, AppName + " is running", "Your phone can now back up over Wi-Fi whenever this PC is on. It starts with Windows; right-click this icon for options.", ToolTipIcon.Info);

        SystemEvents.SessionEnding += delegate { StopNode(2000); };
        timer.Interval = 3000;
        timer.Tick += delegate { Poll(); };
        timer.Start();
        return true;
    }

    void BuildIcon()
    {
        ContextMenuStrip menu = new ContextMenuStrip();
        ToolStripMenuItem open = new ToolStripMenuItem("Open " + AppName, null, delegate { OpenUrl(StatusUrl); });
        open.Font = new Font(open.Font, FontStyle.Bold);
        menu.Items.Add(open);
        menu.Items.Add(new ToolStripMenuItem("Pair a Phone", null, delegate { OpenUrl(PairUrl); }));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(new ToolStripMenuItem("Change Backup Folder...", null, delegate { ChangeFolder(); }));
        startItem = new ToolStripMenuItem("Start with Windows");
        startItem.CheckOnClick = true;
        startItem.Click += delegate { SetStartWithWindows(startItem.Checked); };
        menu.Items.Add(startItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(new ToolStripMenuItem("Quit", null, delegate { Quit(); }));

        icon = new NotifyIcon();
        icon.Icon = LoadIcon();
        icon.Text = AppName + ": starting";
        icon.ContextMenuStrip = menu;
        icon.MouseClick += delegate (object s, MouseEventArgs e) { if (e.Button == MouseButtons.Left) OpenUrl(StatusUrl); };
        icon.Visible = true;
    }

    static Icon LoadIcon()
    {
        try
        {
            using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream("PicJot.ico"))
                return new Icon(s, SystemInformation.SmallIconSize);
        }
        catch { return SystemIcons.Application; }
    }

    // ── The receiver (node) ──
    void StartNode()
    {
        ProcessStartInfo psi = nodePath == null
            ? new ProcessStartInfo(Path.Combine(dir, ReceiverExe), "--background")
            : new ProcessStartInfo(nodePath, "\"" + Path.Combine(dir, "receiver.js") + "\" --background");
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.WorkingDirectory = dir;
        psi.RedirectStandardInput = true; // "quit" goes here; if this program ends, node sees it close
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.StandardOutputEncoding = Encoding.UTF8;
        psi.StandardErrorEncoding = Encoding.UTF8;
        Process p = new Process();
        p.StartInfo = psi;
        p.OutputDataReceived += Keep;
        p.ErrorDataReceived += Keep;
        try
        {
            p.Start();
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
            node = p;
            stopped = false;
        }
        catch (Exception e)
        {
            Note("Couldn't start the receiver: " + e.Message);
            node = null;
            stopped = true;
            SetText(AppName + ": stopped");
        }
    }

    void Keep(object sender, DataReceivedEventArgs e)
    {
        if (e.Data == null) return;
        lock (output)
        {
            output.Add(e.Data);
            if (output.Count > 20) output.RemoveAt(0);
        }
    }

    // Asks node to stop (it finishes filing a backup first), then waits.
    void StopNode(int waitMs)
    {
        Process p = node;
        node = null;
        if (p == null) return;
        try
        {
            if (!p.HasExited)
            {
                p.StandardInput.WriteLine("quit");
                p.StandardInput.Flush();
            }
        }
        catch { }
        try { if (!p.WaitForExit(waitMs)) p.Kill(); } catch { }
    }

    void NodeExited()
    {
        int code = -1;
        try { code = node.ExitCode; } catch { }
        node = null;
        SetAwake(false);
        if (code == ExitPortInUse)
        {
            stopped = true;
            SetText(AppName + ": not running");
            icon.ShowBalloonTip(10000, AppName + " couldn't start", "Its network port is in use: another copy may be running in a window. Close that window, then open " + AppName + " again.", ToolTipIcon.Warning);
            return;
        }
        // Start it again, at most 3 times in 10 minutes.
        if ((DateTime.Now - restartWindow).TotalMinutes > 10) { restartWindow = DateTime.Now; restarts = 0; }
        if (restarts < 3)
        {
            restarts++;
            Note("The receiver stopped (exit code " + code + "); starting it again.");
            StartNode();
            return;
        }
        stopped = true;
        SetText(AppName + ": stopped");
        icon.ShowBalloonTip(10000, AppName + " stopped", "It stopped unexpectedly. 'Quit' it and open " + AppName + " again; its log is in %APPDATA%\\PhotoApp\\receiver.log.", ToolTipIcon.Warning);
    }

    // ── Every 3 seconds: the receiver's state ──
    void Poll()
    {
        if (quitting || stopped) return;
        if (node == null || node.HasExited) { NodeExited(); return; }
        Dictionary<string, object> s = FetchStatus();
        if (s == null) { SetText(AppName + ": starting"); return; }

        bool busy = Bool(s, "busy");
        string problem = Str(s, "problem");
        SetAwake(busy);
        if (busy)
        {
            string phone = Str(s, "phone");
            SetText(AppName + ": backing up" + (phone != null ? " " + phone : ""));
        }
        else if (problem != null) SetText(AppName + ": " + problem);
        else SetText(AppName + ": ready");

        Dictionary<string, object> last = s.ContainsKey("lastBackup") ? s["lastBackup"] as Dictionary<string, object> : null;
        string at = last != null ? Str(last, "at") : null;
        if (!baselineSet)
        {
            // The first answer: nothing to announce yet. With no phone paired,
            // show the pairing page (the first time the receiver is opened).
            baselineSet = true;
            seenBackupAt = at;
            seenProblem = problem;
            if (Int(s, "phoneCount") == 0 && !pairShown) { pairShown = true; OpenUrl(PairUrl); }
            if (problem != null) icon.ShowBalloonTip(10000, AppName, problem, ToolTipIcon.Warning);
            return;
        }
        if (at != null && at != seenBackupAt)
        {
            seenBackupAt = at;
            string phone = Str(last, "phone");
            icon.ShowBalloonTip(8000, "Backup finished" + (phone != null ? ": " + phone : ""), Str(last, "text") ?? "", ToolTipIcon.Info);
        }
        if (problem != null && problem != seenProblem)
            icon.ShowBalloonTip(10000, AppName, problem, ToolTipIcon.Warning);
        seenProblem = problem;
    }

    static Dictionary<string, object> FetchStatus()
    {
        try
        {
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(ApiUrl);
            req.Proxy = null;
            req.Timeout = 1500;
            req.ReadWriteTimeout = 1500;
            using (HttpWebResponse res = (HttpWebResponse)req.GetResponse())
            using (StreamReader r = new StreamReader(res.GetResponseStream(), Encoding.UTF8))
                return new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(r.ReadToEnd());
        }
        catch { return null; }
    }

    static string Str(Dictionary<string, object> d, string k)
    {
        object v;
        return d.TryGetValue(k, out v) && v != null ? v.ToString() : null;
    }
    static bool Bool(Dictionary<string, object> d, string k)
    {
        object v;
        return d.TryGetValue(k, out v) && v is bool && (bool)v;
    }
    static int Int(Dictionary<string, object> d, string k)
    {
        object v;
        return d.TryGetValue(k, out v) && v is int ? (int)v : 0;
    }

    void SetText(string text)
    {
        // Windows allows 63 characters here.
        icon.Text = text.Length > 63 ? text.Substring(0, 60) + "..." : text;
    }

    // Keeps the PC from going to sleep while a phone backs up.
    void SetAwake(bool on)
    {
        if (on == awake) return;
        awake = on;
        SetThreadExecutionState(on ? ES_CONTINUOUS | ES_SYSTEM_REQUIRED : ES_CONTINUOUS);
    }

    void Quit()
    {
        if (quitting) return;
        quitting = true;
        timer.Stop();
        icon.Visible = false;
        SetAwake(false);
        // A backup being filed is finished first (up to 15 minutes).
        StopNode(15 * 60 * 1000);
        icon.Dispose();
        Application.ExitThread();
    }

    // ── The backup folder (shared with the USB backup) ──
    string ReadFolder()
    {
        try
        {
            Dictionary<string, object> d = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(ConfigFile));
            string f = Str(d, "destination");
            return string.IsNullOrEmpty(f) ? null : f;
        }
        catch { return null; }
    }

    void SaveFolder(string folder)
    {
        Directory.CreateDirectory(configDir);
        Dictionary<string, object> d = new Dictionary<string, object>();
        d["destination"] = folder;
        File.WriteAllText(ConfigFile, new JavaScriptSerializer().Serialize(d), new UTF8Encoding(false));
    }

    static string PickFolder(string start)
    {
        using (Form owner = new Form())
        using (FolderBrowserDialog dlg = new FolderBrowserDialog())
        {
            owner.TopMost = true;
            owner.ShowInTaskbar = false;
            owner.StartPosition = FormStartPosition.Manual;
            owner.Location = new Point(-2000, -2000);
            owner.Size = new Size(1, 1);
            owner.Show();
            dlg.Description = "Choose where PicJot should back up your photos (a folder on this PC or an attached drive)";
            dlg.ShowNewFolderButton = true;
            if (start != null && Directory.Exists(start)) dlg.SelectedPath = start;
            return dlg.ShowDialog(owner) == DialogResult.OK ? dlg.SelectedPath : null;
        }
    }

    void ChangeFolder()
    {
        string picked = PickFolder(ReadFolder());
        if (picked == null) return;
        SaveFolder(picked); // the receiver reads it for each backup: no restart
        icon.ShowBalloonTip(5000, "Backup folder changed", "Backups now go to " + picked + ".", ToolTipIcon.Info);
    }

    // ── Start with Windows (an entry under the old name counts, and is replaced) ──
    static bool IsStartWithWindows()
    {
        using (RegistryKey k = Registry.CurrentUser.OpenSubKey(RunKey))
            return k != null && (k.GetValue(RunName) != null || k.GetValue(OldRunName) != null);
    }

    static void SetStartWithWindows(bool on)
    {
        using (RegistryKey k = Registry.CurrentUser.CreateSubKey(RunKey))
        {
            if (on) k.SetValue(RunName, "\"" + Application.ExecutablePath + "\"");
            else k.DeleteValue(RunName, false);
            k.DeleteValue(OldRunName, false);
        }
    }

    // ── Helpers ──
    static string FindNode()
    {
        string path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (string d in path.Split(';'))
        {
            try
            {
                string p = Path.Combine(d.Trim().Trim('"'), "node.exe");
                if (File.Exists(p)) return p;
            }
            catch { }
        }
        string guess = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"nodejs\node.exe");
        return File.Exists(guess) ? guess : null;
    }

    public static void OpenUrl(string url)
    {
        try { Process.Start(url); } catch { }
    }

    // A line in the receiver's log, for problems only the tray sees.
    public void Note(string text)
    {
        try
        {
            Directory.CreateDirectory(configDir);
            File.AppendAllText(Path.Combine(configDir, "receiver.log"), DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  [tray] " + text + Environment.NewLine);
        }
        catch { }
    }
}
