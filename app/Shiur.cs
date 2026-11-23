// Shiur: one tap starts the shiur.
//
// - Starts the Shiur engine (server.js) hidden. The engine starts OBS hidden, opens the wall screen and the Zoom meeting.
// - The Shiur app has two sizes:
//     big   (ME / SHOW, nobody sees the laptop): fills the screen. Zoom tiles big on the left, the controls on the right.
//     small (SCREEN, or while looking something up): a strip along the bottom. Everyone sees everything above it.
//   The strip is kept for the app the way the taskbar keeps its place, so other windows never cover it.
// - The real Zoom window is kept out of sight (behind the wall picture, or off screen); its tiles are shown live in the app.
// - The controls are the web page http://localhost:8080/bar, shown inside the app (WebView2), or in a small
//   Chrome/Edge window if WebView2 is not available.
// - Tells the engine where the free part of the screen is, so only that part is shown to the wall and Zoom.
//
// Built on the laptop by "Install Shiur.bat" with the C# compiler that comes with Windows (C# 5, .NET Framework 4).
// Built with /define:WEBVIEW2 when the WebView2 files could be downloaded.
// Updates itself: when the app starts (and no shiur is running), it checks the latest GitHub release of the repository
// named in app/update.json. If it is newer than version.txt, it downloads it, swaps the files and starts again.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
#if WEBVIEW2
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
#endif

namespace ShiurApp
{
    public static class Program
    {
        [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);

        [STAThread]
        public static void Main(string[] args)
        {
            string baseDir = (args != null && args.Length > 0 && Directory.Exists(args[0])) ? args[0] : AppDomain.CurrentDomain.BaseDirectory;
            try { SetProcessDpiAwarenessContext(new IntPtr(-4)); }
            catch (Exception) { try { SetProcessDPIAware(); } catch (Exception) { } }
            Engine.Init(baseDir);
            bool created;
            using (Mutex mutex = new Mutex(true, "Local\\ShiurPanel", out created))
            {
                if (!created)
                {
                    // Already running: just make sure everything is up.
                    Engine.Post("/api/launch", "{}", 3000);
                    return;
                }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                // A newer version on GitHub? Update first (only when no shiur is running), then start again.
                if (Engine.Get("/api/ping", 1500) == null && Updater.UpdateIfNewer(baseDir)) return;
                Application.Run(new ShiurPanel(baseDir));
            }
        }
    }

    public static class Engine
    {
        public static int Port = 8080;
        static string logFile;

        public static void Init(string baseDir)
        {
            try
            {
                string data = Path.Combine(baseDir, "data");
                Directory.CreateDirectory(data);
                logFile = Path.Combine(data, "panel-log.txt");
                if (File.Exists(logFile) && new FileInfo(logFile).Length > 512 * 1024) File.Delete(logFile);
                string cfg = Path.Combine(data, "config.json");
                if (File.Exists(cfg))
                {
                    Match m = Regex.Match(File.ReadAllText(cfg), "\"port\"\\s*:\\s*(\\d+)");
                    if (m.Success) Port = int.Parse(m.Groups[1].Value);
                }
            }
            catch (Exception) { }
        }

        public static void Log(string text)
        {
            try { if (logFile != null) File.AppendAllText(logFile, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + text + Environment.NewLine); }
            catch (Exception) { }
        }

        public static string Url(string path) { return "http://127.0.0.1:" + Port + path; }
        public static string Get(string path, int timeoutMs) { return Send("GET", path, null, timeoutMs); }
        public static string Post(string path, string json, int timeoutMs) { return Send("POST", path, json ?? "{}", timeoutMs); }

        static string Send(string method, string path, string body, int timeoutMs)
        {
            try
            {
                HttpWebRequest r = (HttpWebRequest)WebRequest.Create(Url(path));
                r.Method = method;
                r.Timeout = timeoutMs;
                r.ReadWriteTimeout = timeoutMs;
                r.Proxy = null;
                r.KeepAlive = false;
                if (body != null)
                {
                    byte[] b = Encoding.UTF8.GetBytes(body);
                    r.ContentType = "application/json";
                    r.ContentLength = b.Length;
                    using (Stream s = r.GetRequestStream()) s.Write(b, 0, b.Length);
                }
                using (HttpWebResponse resp = (HttpWebResponse)r.GetResponse())
                using (StreamReader sr = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                    return sr.ReadToEnd();
            }
            catch (WebException ex)
            {
                // An error answer still means the engine is running.
                if (ex.Response != null) return "";
                return null;
            }
            catch (Exception) { return null; }
        }
    }

    // Keeps the app up to date from GitHub releases.
    public static class Updater
    {
        static string Read(string file) { try { return File.Exists(file) ? File.ReadAllText(file).Trim() : null; } catch (Exception) { return null; } }

        static string Fetch(string url, int timeoutMs)
        {
            try
            {
                HttpWebRequest r = (HttpWebRequest)WebRequest.Create(url);
                r.UserAgent = "Shiur-app";
                r.Accept = "application/vnd.github+json";
                r.Timeout = timeoutMs;
                r.ReadWriteTimeout = timeoutMs;
                using (HttpWebResponse resp = (HttpWebResponse)r.GetResponse())
                using (StreamReader sr = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                    return sr.ReadToEnd();
            }
            catch (Exception) { return null; }
        }

        // Returns true if an update was downloaded and is being put in place (the app must then close).
        public static bool UpdateIfNewer(string baseDir)
        {
            try
            {
                string current = Read(Path.Combine(baseDir, "version.txt"));
                string cfg = Read(Path.Combine(baseDir, "app", "update.json"));
                if (string.IsNullOrEmpty(current) || cfg == null) return false;        // running from the source code: no updates
                Match repo = Regex.Match(cfg, "\"repo\"\\s*:\\s*\"([\\w.-]+/[\\w.-]+)\"");
                if (!repo.Success || repo.Groups[1].Value.StartsWith("OWNER/")) return false;
                try { ServicePointManager.SecurityProtocol |= (SecurityProtocolType)3072; } catch (Exception) { }   // TLS 1.2
                string json = Fetch("https://api.github.com/repos/" + repo.Groups[1].Value + "/releases/latest", 5000);
                if (json == null) return false;                                        // offline: carry on with this version
                Match tag = Regex.Match(json, "\"tag_name\"\\s*:\\s*\"([^\"]+)\"");
                Match zip = Regex.Match(json, "\"browser_download_url\"\\s*:\\s*\"([^\"]+/shiur-app\\.zip)\"");
                if (!tag.Success || !zip.Success || tag.Groups[1].Value == current) return false;
                Engine.Log("Updating from " + current + " to " + tag.Groups[1].Value);
                return Apply(baseDir, zip.Groups[1].Value);
            }
            catch (Exception ex) { Engine.Log("Update check failed: " + ex.Message); return false; }
        }

        static bool Apply(string baseDir, string zipUrl)
        {
            UpdateNotice notice = new UpdateNotice();
            notice.Show();
            Application.DoEvents();
            try
            {
                string temp = Path.GetTempPath();
                string folder = Path.Combine(temp, "shiur-update"), zipFile = folder + ".zip";
                using (WebClient wc = new WebClient())
                {
                    wc.Headers.Add("User-Agent", "Shiur-app");
                    wc.DownloadFile(zipUrl, zipFile);
                }
                if (Directory.Exists(folder)) Directory.Delete(folder, true);
                ZipFile.ExtractToDirectory(zipFile, folder);
                if (!File.Exists(Path.Combine(folder, "Shiur.exe"))) { Engine.Log("Update package has no Shiur.exe"); notice.Close(); return false; }
                string dest = baseDir.TrimEnd('\\');
                // Wait for this app to close, copy the new files over (keeping your list and settings), start again.
                string script = Path.Combine(temp, "shiur-apply-update.cmd");
                File.WriteAllText(script,
                    "@echo off\r\n" +
                    "ping -n 3 127.0.0.1 >nul\r\n" +
                    "robocopy \"" + folder + "\" \"" + dest + "\" /E /XD data /R:10 /W:1 /NFL /NDL /NJH /NJS /NP >nul\r\n" +
                    "rmdir /s /q \"" + folder + "\"\r\n" +
                    "start \"\" \"" + dest + "\\Shiur.exe\"\r\n");
                ProcessStartInfo psi = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "cmd.exe"), "/c \"" + script + "\"");
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.WindowStyle = ProcessWindowStyle.Hidden;
                Process.Start(psi);
                notice.Close();
                return true;
            }
            catch (Exception ex)
            {
                Engine.Log("Update failed: " + ex.Message);
                notice.Close();
                return false;
            }
        }
    }

    // A small "Updating Shiur..." message in the middle of the screen while an update downloads.
    public class UpdateNotice : Form
    {
        public UpdateNotice()
        {
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.CenterScreen;
            ShowInTaskbar = false;
            TopMost = true;
            BackColor = Color.FromArgb(31, 36, 44);
            Size = new Size(380, 90);
            Label l = new Label();
            l.Text = "Updating Shiur... (a few seconds)";
            l.ForeColor = Color.FromArgb(243, 239, 230);
            l.Font = new Font("Segoe UI", 12f);
            l.Dock = DockStyle.Fill;
            l.TextAlign = ContentAlignment.MiddleCenter;
            Controls.Add(l);
        }
    }

    static class Native
    {
        [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
        [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
        [StructLayout(LayoutKind.Sequential)] public struct SIZE { public int cx, cy; }
        [StructLayout(LayoutKind.Sequential)]
        public struct APPBARDATA { public int cbSize; public IntPtr hWnd; public uint uCallbackMessage; public uint uEdge; public RECT rc; public IntPtr lParam; }
        [StructLayout(LayoutKind.Sequential)]
        public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
        [StructLayout(LayoutKind.Sequential)]
        public struct DWM_THUMBNAIL_PROPERTIES
        {
            public int dwFlags;
            public RECT rcDestination;
            public RECT rcSource;
            public byte opacity;
            [MarshalAs(UnmanagedType.Bool)] public bool fVisible;
            [MarshalAs(UnmanagedType.Bool)] public bool fSourceClientAreaOnly;
        }
        public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        public const uint ABM_NEW = 0, ABM_REMOVE = 1, ABM_QUERYPOS = 2, ABM_SETPOS = 3;
        public const uint ABE_RIGHT = 2, ABE_BOTTOM = 3;
        public const int ABN_POSCHANGED = 1;
        public static readonly IntPtr HWND_TOP = IntPtr.Zero;
        public static readonly IntPtr HWND_BOTTOM = new IntPtr(1);
        public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
        public static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);
        public const uint SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOZORDER = 0x4, SWP_NOACTIVATE = 0x10, SWP_SHOWWINDOW = 0x40;
        public const int SW_RESTORE = 9, SW_SHOWNOACTIVATE = 4, SW_MAXIMIZE = 3;
        public const int GWL_EXSTYLE = -20;
        public const int WS_EX_TOPMOST = 0x8, WS_EX_TOOLWINDOW = 0x80, WS_EX_NOACTIVATE = 0x08000000;
        public const int WM_CLOSE = 0x10, WM_DISPLAYCHANGE = 0x7E, WM_SETTINGCHANGE = 0x1A, WM_DPICHANGED = 0x2E0;
        public const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
        public const int DWM_TNP_RECTDESTINATION = 0x1, DWM_TNP_OPACITY = 0x4, DWM_TNP_VISIBLE = 0x8, DWM_TNP_SOURCECLIENTAREAONLY = 0x10;

        [DllImport("shell32.dll")] public static extern UIntPtr SHAppBarMessage(uint dwMessage, ref APPBARDATA pData);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern uint RegisterWindowMessage(string lpString);
        [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
        [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
        [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
        [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc proc, IntPtr lParam);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int max);
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
        [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, int msg, IntPtr w, IntPtr l);
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
        [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
        [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
        [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int index);
        [DllImport("user32.dll")] public static extern IntPtr MonitorFromPoint(POINT pt, uint flags);
        [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);
        [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO mi);
        [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
        [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attr, out RECT value, int size);
        [DllImport("dwmapi.dll")] public static extern int DwmRegisterThumbnail(IntPtr dest, IntPtr src, out IntPtr thumb);
        [DllImport("dwmapi.dll")] public static extern int DwmUnregisterThumbnail(IntPtr thumb);
        [DllImport("dwmapi.dll")] public static extern int DwmUpdateThumbnailProperties(IntPtr thumb, ref DWM_THUMBNAIL_PROPERTIES props);
        [DllImport("dwmapi.dll")] public static extern int DwmQueryThumbnailSourceSize(IntPtr thumb, out SIZE size);

        public static string Title(IntPtr h) { StringBuilder sb = new StringBuilder(256); GetWindowText(h, sb, 256); return sb.ToString(); }
        public static string ClassOf(IntPtr h) { StringBuilder sb = new StringBuilder(256); GetClassName(h, sb, 256); return sb.ToString(); }
        public static Rectangle ToRect(RECT r) { return Rectangle.FromLTRB(r.Left, r.Top, r.Right, r.Bottom); }
        public static Rectangle WindowRect(IntPtr h) { RECT r; GetWindowRect(h, out r); return ToRect(r); }

        public static MONITORINFO MonitorInfo(IntPtr monitor)
        {
            MONITORINFO mi = new MONITORINFO();
            mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
            GetMonitorInfo(monitor, ref mi);
            return mi;
        }
        public static IntPtr PrimaryMonitor()
        {
            POINT p = new POINT(); p.X = 0; p.Y = 0;
            return MonitorFromPoint(p, 1);
        }
    }


    public class ShiurPanel : Form
    {
        const int StripHeightDip = 92;      // the strip along the bottom
        const int MiniZoomWidthDip = 170;   // the small Zoom tiles at the end of the strip
        const double BigZoomShare = 0.44;   // in the big app, the Zoom tiles take this much of the width
        readonly string baseDir;

        float scale = 1f;
        uint callbackMsg;
        bool registered, positioning, ending;
        string panelSize = "big";           // "big" or "small", decided by the engine
        DateTime panelLocalUntil = DateTime.MinValue;   // just changed it here: don't let an older answer from the engine undo it
        string mode = "me";
        Rectangle strip = Rectangle.Empty;  // the reserved strip, on screen
        Rectangle bigArea = Rectangle.Empty;// the whole screen above the taskbar, on screen
        Rectangle webRect, zoomBox, captionBox, bigZoomBox;   // inside this window
        string status = "Shiur is starting...";

        // the controls: built-in web view, or a browser window as a backup
        bool useChrome;
        IntPtr barWnd = IntPtr.Zero;
        DateTime browserStartedAt = DateTime.MinValue;
        int browserStarts;
#if WEBVIEW2
        WebView2 web;
#endif

        // Zoom
        IntPtr zoomWnd = IntPtr.Zero;
        IntPtr thumb = IntPtr.Zero;
        bool zoomBig;
        DateTime lastZoomSearch = DateTime.MinValue, lastDialogCheck = DateTime.MinValue;
        Rectangle lastThumbDest = Rectangle.Empty, lastPark = Rectangle.Empty;
        readonly Dictionary<uint, string> processNames = new Dictionary<uint, string>();
        readonly HashSet<string> loggedZoomWindows = new HashSet<string>();
        readonly HashSet<IntPtr> dialogsMoved = new HashSet<IntPtr>();

        // A web page or file just opened from the app: bring its browser window onto the laptop screen
        DateTime browserHomeFrom = DateTime.MinValue, browserHomeUntil = DateTime.MinValue;

        // talking to the engine
        System.Windows.Forms.Timer timer;
        int pinging;
        bool seqKnown, serverSeen;
        int lastSeq, serverMisses;
        DateTime lastServerStart = DateTime.MinValue;
        string lastReport = "";
        DateTime lastReportAt = DateTime.MinValue;

        public ShiurPanel(string baseDir)
        {
            this.baseDir = baseDir;
            Text = "Shiur";
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            TopMost = true;
            StartPosition = FormStartPosition.Manual;
            AutoScaleMode = AutoScaleMode.None;
            BackColor = Color.FromArgb(17, 21, 28);
            SetStyle(ControlStyles.OptimizedDoubleBuffer | ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.ResizeRedraw, true);
            Bounds = new Rectangle(-32000, -32000, 10, 10);
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch (Exception) { }
        }

        protected override bool ShowWithoutActivation { get { return true; } }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ExStyle |= Native.WS_EX_TOOLWINDOW | Native.WS_EX_TOPMOST;
                return cp;
            }
        }

        protected override void OnLoad(EventArgs e)
        {
            base.OnLoad(e);
            Engine.Log("Shiur app starting");
            try { scale = Native.GetDpiForWindow(Handle) / 96f; }
            catch (Exception) { using (Graphics g = CreateGraphics()) scale = g.DpiX / 96f; }
            if (scale <= 0) scale = 1f;
            callbackMsg = Native.RegisterWindowMessage("ShiurPanelAppBar");
            Native.APPBARDATA abd = NewAbd();
            abd.uCallbackMessage = callbackMsg;
            Native.SHAppBarMessage(Native.ABM_NEW, ref abd);
            registered = true;
            ReserveStrip();

            Thread t = new Thread(StartEverything);
            t.IsBackground = true;
            t.Start();

            timer = new System.Windows.Forms.Timer();
            timer.Interval = 400;
            timer.Tick += OnTick;
            timer.Start();
        }

        Native.APPBARDATA NewAbd()
        {
            Native.APPBARDATA abd = new Native.APPBARDATA();
            abd.cbSize = Marshal.SizeOf(typeof(Native.APPBARDATA));
            abd.hWnd = Handle;
            return abd;
        }

        // ---------- the strip and the two sizes ----------

        // Keep a strip along the bottom of the laptop screen for the app (above the taskbar).
        void ReserveStrip()
        {
            if (!registered || positioning) return;
            positioning = true;
            try
            {
                Native.MONITORINFO mi = Native.MonitorInfo(Native.PrimaryMonitor());
                Rectangle mon = Native.ToRect(mi.rcMonitor);
                int h = (int)Math.Round(StripHeightDip * scale);
                Native.APPBARDATA abd = NewAbd();
                abd.uEdge = Native.ABE_BOTTOM;
                abd.rc.Left = mon.Left; abd.rc.Right = mon.Right; abd.rc.Top = mon.Bottom - h; abd.rc.Bottom = mon.Bottom;
                Native.SHAppBarMessage(Native.ABM_QUERYPOS, ref abd);
                abd.rc.Top = abd.rc.Bottom - h;
                Native.SHAppBarMessage(Native.ABM_SETPOS, ref abd);
                strip = Native.ToRect(abd.rc);
                Rectangle work = Native.ToRect(Native.MonitorInfo(Native.PrimaryMonitor()).rcWork);
                bigArea = Rectangle.FromLTRB(work.Left, Math.Min(work.Top, strip.Top), work.Right, Math.Max(strip.Bottom, work.Bottom));
                Engine.Log("Strip at " + strip + ", big app area " + bigArea + ", scale " + scale);
            }
            finally { positioning = false; }
            ApplyLayout();
        }

        // Size and lay out the app for "big" or "small".
        // Big is a normal window in front of the others (so anything you open comes in front of it, and the app then
        // becomes the strip). Small, the strip, always stays on top.
        void ApplyLayout() { ApplyLayout(false); }
        void ApplyLayout(bool bringToFront)
        {
            if (strip.IsEmpty) return;
            int pad = (int)Math.Round(8 * scale);
            int capH = (int)Math.Round(30 * scale);
            Rectangle on = panelSize == "big" ? bigArea : strip;
            int w = on.Width, h = on.Height;
            int zw = (int)Math.Round(bigArea.Width * BigZoomShare);
            bigZoomBox = new Rectangle(pad, pad, zw - 2 * pad, bigArea.Height - capH - 2 * pad);
            if (panelSize == "big")
            {
                zoomBox = bigZoomBox;
                captionBox = new Rectangle(pad, zoomBox.Bottom, zw - 2 * pad, capH);
                webRect = new Rectangle(zw, 0, w - zw, h);
            }
            else
            {
                int mz = (int)Math.Round(MiniZoomWidthDip * scale);
                zoomBox = new Rectangle(w - mz + pad / 2, pad / 2 + 1, mz - pad, h - pad - 2);
                captionBox = Rectangle.Empty;
                webRect = new Rectangle(0, 0, w - mz, h);
            }
            bool haveBar = useChrome && barWnd != IntPtr.Zero && Native.IsWindow(barWnd);
            IntPtr after = panelSize == "big" ? Native.HWND_NOTOPMOST : (haveBar ? barWnd : Native.HWND_TOPMOST);
            Native.SetWindowPos(Handle, after, on.X, on.Y, w, h, Native.SWP_NOACTIVATE | Native.SWP_SHOWWINDOW);
            if (panelSize == "big" && bringToFront)
            {
                if (haveBar) Native.SetWindowPos(barWnd, Native.HWND_NOTOPMOST, 0, 0, 0, 0, Native.SWP_NOMOVE | Native.SWP_NOSIZE | Native.SWP_NOACTIVATE);
                ForceForeground(Handle);
                if (haveBar) Native.BringWindowToTop(barWnd);
            }
#if WEBVIEW2
            if (web != null) web.Bounds = webRect;
#endif
            lastThumbDest = Rectangle.Empty;
            if (thumb != IntPtr.Zero && !zoomBig) ShowThumb();
            Invalidate();
        }

        Rectangle WebOnScreen() { return new Rectangle(Bounds.X + webRect.X, Bounds.Y + webRect.Y, webRect.Width, webRect.Height); }

        protected override void WndProc(ref Message m)
        {
            if (registered && callbackMsg != 0 && m.Msg == (int)callbackMsg)
            {
                if (m.WParam.ToInt64() == Native.ABN_POSCHANGED) ReserveStrip();
            }
            else if (m.Msg == Native.WM_DISPLAYCHANGE || m.Msg == Native.WM_DPICHANGED)
            {
                if (m.Msg == Native.WM_DPICHANGED) scale = (m.WParam.ToInt64() & 0xFFFF) / 96f;
                if (registered) BeginInvoke(new Action(ReserveStrip));
            }
            base.WndProc(ref m);
        }

        // ---------- starting ----------

        void StartEverything()
        {
            // If the last shiur is still closing down, wait for it to finish first.
            string first = Engine.Get("/api/ping", 1500);
            for (int i = 0; i < 40 && first != null && Regex.IsMatch(first, "\"ended\"\\s*:\\s*true"); i++) { Thread.Sleep(500); first = Engine.Get("/api/ping", 1000); }
            if (first == null) StartEngine(false);
            else Engine.Post("/api/launch", "{}", 3000);
            for (int i = 0; i < 80 && Engine.Get("/api/ping", 1000) == null; i++) Thread.Sleep(500);
            try { BeginInvoke(new Action(StartControls)); } catch (Exception) { }
        }

        static string FindNode()
        {
            List<string> c = new List<string>();
            c.Add(Path.Combine(Environment.GetEnvironmentVariable("ProgramFiles") ?? "", "nodejs\\node.exe"));
            c.Add(Path.Combine(Environment.GetEnvironmentVariable("ProgramW6432") ?? "", "nodejs\\node.exe"));
            c.Add(Path.Combine(Environment.GetEnvironmentVariable("LOCALAPPDATA") ?? "", "Programs\\nodejs\\node.exe"));
            foreach (string dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';'))
                if (dir.Trim().Length > 0) c.Add(Path.Combine(dir.Trim().Trim('"'), "node.exe"));
            foreach (string f in c) { try { if (File.Exists(f)) return f; } catch (Exception) { } }
            return null;
        }

        void StartEngine(bool restart)
        {
            string node = FindNode();
            if (node == null) { SetStatus("Node.js is missing. Install it from nodejs.org, then tap Shiur again."); Engine.Log("node.exe not found"); return; }
            string data = Path.Combine(baseDir, "data");
            Directory.CreateDirectory(data);
            string log = Path.Combine(data, "engine-log.txt");
            try { if (File.Exists(log) && new FileInfo(log).Length > 1024 * 1024) File.Delete(log); } catch (Exception) { }
            string cmd = "\"" + node + "\" \"" + Path.Combine(baseDir, "server.js") + "\" --launch" + (restart ? " --no-zoom" : "") + " >> \"" + log + "\" 2>&1";
            ProcessStartInfo psi = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "cmd.exe"), "/s /c \"" + cmd + "\"");
            psi.WorkingDirectory = baseDir;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.WindowStyle = ProcessWindowStyle.Hidden;
            try { Process.Start(psi); lastServerStart = DateTime.Now; Engine.Log("Engine started" + (restart ? " again" : "")); }
            catch (Exception ex) { SetStatus("Could not start: " + ex.Message); Engine.Log("Engine start failed: " + ex.Message); }
        }

        void StartControls()
        {
            if (ending) return;
#if WEBVIEW2
            StartWebView();
#else
            useChrome = true;
            StartBrowser();
#endif
        }

#if WEBVIEW2
        async void StartWebView()
        {
            try
            {
                web = new WebView2();
                web.DefaultBackgroundColor = BackColor;
                web.Bounds = webRect;
                Controls.Add(web);
                string folder = Path.Combine(baseDir, "data", "webview");
                CoreWebView2Environment env = await CoreWebView2Environment.CreateAsync(null, folder);
                await web.EnsureCoreWebView2Async(env);
                web.CoreWebView2.Settings.IsZoomControlEnabled = false;
                web.CoreWebView2.Settings.IsStatusBarEnabled = false;
                web.CoreWebView2.NewWindowRequested += delegate(object s, CoreWebView2NewWindowRequestedEventArgs a)
                {
                    a.Handled = true;
                    try { Process.Start(a.Uri); } catch (Exception) { }
                };
                web.CoreWebView2.Navigate("http://localhost:" + Engine.Port + "/bar");
                Engine.Log("Controls shown in the built-in web view");
            }
            catch (Exception ex)
            {
                Engine.Log("Built-in web view not available (" + ex.Message + "); using a browser window instead");
                try { if (web != null) { Controls.Remove(web); web.Dispose(); } } catch (Exception) { }
                web = null;
                useChrome = true;
                StartBrowser();
            }
        }
#endif

        static string FindBrowser()
        {
            string pf = Environment.GetEnvironmentVariable("ProgramFiles") ?? "";
            string pf86 = Environment.GetEnvironmentVariable("ProgramFiles(x86)") ?? "";
            string local = Environment.GetEnvironmentVariable("LOCALAPPDATA") ?? "";
            string[] c = {
                Path.Combine(pf, "Google\\Chrome\\Application\\chrome.exe"),
                Path.Combine(pf86, "Google\\Chrome\\Application\\chrome.exe"),
                Path.Combine(local, "Google\\Chrome\\Application\\chrome.exe"),
                Path.Combine(pf86, "Microsoft\\Edge\\Application\\msedge.exe"),
                Path.Combine(pf, "Microsoft\\Edge\\Application\\msedge.exe")
            };
            foreach (string f in c) { try { if (File.Exists(f)) return f; } catch (Exception) { } }
            return null;
        }

        void StartBrowser()
        {
            if (ending) return;
            string exe = FindBrowser();
            if (exe == null) { SetStatus("Could not find Chrome or Edge."); return; }
            string profile = Path.Combine(baseDir, "data", "bar-browser");
            Rectangle a = WebOnScreen();
            int x = (int)(a.X / scale), y = (int)(a.Y / scale), w = (int)(a.Width / scale), h = (int)(a.Height / scale);
            string args = "--app=http://localhost:" + Engine.Port + "/bar --user-data-dir=\"" + profile + "\" --no-first-run --no-default-browser-check" +
                " --disable-features=Translate,TranslateUI --hide-crash-restore-bubble --disable-session-crashed-bubble" +
                " --window-position=" + x + "," + y + " --window-size=" + w + "," + h;
            try { Process.Start(exe, args); browserStartedAt = DateTime.Now; browserStarts++; Engine.Log("Controls opened in " + exe); }
            catch (Exception ex) { SetStatus("Could not open the controls: " + ex.Message); }
        }

        void SetStatus(string text)
        {
            try { BeginInvoke(new Action(delegate { status = text; Invalidate(); })); } catch (Exception) { }
        }

        // ---------- every 0.4 seconds ----------

        void OnTick(object sender, EventArgs e)
        {
            if (ending) return;
            if (useChrome) KeepBarInPlace();
            KeepZoomInPlace();
            CheckZoomDialogs();
            if (DateTime.Now < browserHomeUntil) BringBrowserHome();
            ReportScreen();
            if (Interlocked.CompareExchange(ref pinging, 1, 0) == 0)
            {
                ThreadPool.QueueUserWorkItem(delegate
                {
                    string r = Engine.Get("/api/ping", 1500);
                    try { BeginInvoke(new Action<string>(OnPing), r); } catch (Exception) { }
                    Interlocked.Exchange(ref pinging, 0);
                });
            }
        }

        void OnPing(string r)
        {
            if (ending) return;
            if (r == null)
            {
                serverMisses++;
                // The engine stopped by itself: start it again (without re-opening Zoom).
                if (serverSeen && serverMisses > 15 && (DateTime.Now - lastServerStart).TotalSeconds > 30)
                {
                    serverMisses = 0;
                    ThreadPool.QueueUserWorkItem(delegate { StartEngine(true); });
                }
                return;
            }
            serverSeen = true;
            serverMisses = 0;
            if (Regex.IsMatch(r, "\"ended\"\\s*:\\s*true")) { BeginEnd(Regex.IsMatch(r, "\"closeObs\"\\s*:\\s*true")); return; }

            Match md = Regex.Match(r, "\"mode\"\\s*:\\s*\"(\\w+)\"");
            if (md.Success) mode = md.Groups[1].Value;
            Match p = Regex.Match(r, "\"panel\"\\s*:\\s*\"(big|small)\"");
            if (p.Success && p.Groups[1].Value != panelSize && DateTime.Now > panelLocalUntil)
            {
                panelSize = p.Groups[1].Value;
                if (panelSize == "big" && zoomBig) { zoomBig = false; lastPark = Rectangle.Empty; }   // the app shows the tiles again
                ApplyLayout(panelSize == "big");
            }

            Match s = Regex.Match(r, "\"seq\"\\s*:\\s*(\\d+)");
            Match a = Regex.Match(r, "\"action\"\\s*:\\s*\"(\\w+)\"");
            if (!s.Success) return;
            int seq = int.Parse(s.Groups[1].Value);
            if (!seqKnown) { seqKnown = true; lastSeq = seq; return; }
            if (seq == lastSeq) return;
            lastSeq = seq;
            string action = a.Success ? a.Groups[1].Value : "";
            if (action == "zoomBack") ParkZoom();
            else if (action == "zoomFront") ZoomBig();
            else if (action == "live") { ParkZoom(); StartBrowserHome(); }
            else if (action == "browser") StartBrowserHome();
        }

        // ---------- pages opened from the app go on the laptop screen ----------

        // The browser may open a page on another screen (where it was last). Then SCREEN would show the empty desktop.
        // So for a few seconds, look for the browser window and move it onto the laptop screen, full size.
        void StartBrowserHome()
        {
            browserHomeFrom = DateTime.Now;
            browserHomeUntil = DateTime.Now.AddSeconds(8);
        }

        void BringBrowserHome()
        {
            IntPtr pick = IntPtr.Zero;
            IntPtr fg = Native.GetForegroundWindow();
            if (IsBrowserWindow(fg)) pick = fg;
            // If the browser did not come to the front by itself, after a moment take the browser window nearest the top.
            if (pick == IntPtr.Zero && (DateTime.Now - browserHomeFrom).TotalSeconds > 2.5)
            {
                Native.EnumWindows(delegate(IntPtr h, IntPtr l)
                {
                    if (!IsBrowserWindow(h)) return true;
                    pick = h;
                    return false;
                }, IntPtr.Zero);
            }
            if (pick == IntPtr.Zero) return;
            browserHomeUntil = DateTime.MinValue;
            IntPtr primary = Native.PrimaryMonitor();
            if (Native.MonitorFromWindow(pick, 2) != primary || !Native.IsZoomed(pick))
            {
                Rectangle work = Native.ToRect(Native.MonitorInfo(primary).rcWork);
                if (Native.IsIconic(pick) || Native.IsZoomed(pick)) Native.ShowWindow(pick, Native.SW_RESTORE);
                Native.SetWindowPos(pick, Native.HWND_TOP, work.X, work.Y, work.Width, work.Height, Native.SWP_SHOWWINDOW);
                Native.ShowWindow(pick, Native.SW_MAXIMIZE);
                Engine.Log("Brought the browser onto the laptop screen: " + Native.Title(pick));
            }
            ForceForeground(pick);
        }

        bool IsBrowserWindow(IntPtr h)
        {
            if (h == IntPtr.Zero || h == Handle || (useChrome && h == barWnd) || !Native.IsWindowVisible(h)) return false;
            string title = Native.Title(h);
            if (title.Length == 0 || title.StartsWith("Shiur bar")) return false;
            uint pid;
            Native.GetWindowThreadProcessId(h, out pid);
            string name = ProcessName(pid).ToLowerInvariant();
            if (name != "chrome" && name != "msedge" && name != "firefox" && name != "brave" && name != "opera" && name != "vivaldi") return false;
            Rectangle r = Native.WindowRect(h);
            return Native.IsIconic(h) || (r.Width >= 400 && r.Height >= 300);
        }

        // ---------- the backup browser window for the controls ----------

        IntPtr FindBarWindow()
        {
            IntPtr found = IntPtr.Zero;
            bool loose = (DateTime.Now - browserStartedAt).TotalSeconds > 8;
            Native.EnumWindows(delegate(IntPtr h, IntPtr l)
            {
                if (!Native.IsWindowVisible(h)) return true;
                if (!Native.ClassOf(h).StartsWith("Chrome_WidgetWin")) return true;
                string t = Native.Title(h);
                if (t == "Shiur bar" || (loose && t.StartsWith("Shiur bar") && found == IntPtr.Zero)) { found = h; if (t == "Shiur bar") return false; }
                return true;
            }, IntPtr.Zero);
            return found;
        }

        void KeepBarInPlace()
        {
            if (barWnd == IntPtr.Zero || !Native.IsWindow(barWnd) || !Native.IsWindowVisible(barWnd))
            {
                barWnd = FindBarWindow();
                if (barWnd == IntPtr.Zero)
                {
                    if (browserStartedAt != DateTime.MinValue && (DateTime.Now - browserStartedAt).TotalSeconds > 12 && browserStarts < 6) StartBrowser();
                    return;
                }
            }
            if (Native.IsIconic(barWnd) || Native.IsZoomed(barWnd)) Native.ShowWindow(barWnd, Native.SW_RESTORE);
            Rectangle area = WebOnScreen();
            Rectangle wr = Native.WindowRect(barWnd);
            Native.RECT fr;
            int ol = 0, ot = 0, orr = 0, ob = 0;
            if (Native.DwmGetWindowAttribute(barWnd, Native.DWMWA_EXTENDED_FRAME_BOUNDS, out fr, Marshal.SizeOf(typeof(Native.RECT))) == 0)
            {
                ol = fr.Left - wr.Left; ot = fr.Top - wr.Top; orr = wr.Right - fr.Right; ob = wr.Bottom - fr.Bottom;
            }
            Rectangle target = Rectangle.FromLTRB(area.Left - ol, area.Top - ot, area.Right + orr, area.Bottom + ob);
            // Keep this window just under the controls window, so it never covers them.
            if (panelSize != "big") Native.SetWindowPos(Handle, barWnd, 0, 0, 0, 0, Native.SWP_NOMOVE | Native.SWP_NOSIZE | Native.SWP_NOACTIVATE);
            bool topmost = (Native.GetWindowLong(barWnd, Native.GWL_EXSTYLE) & Native.WS_EX_TOPMOST) != 0;
            bool wantTop = panelSize != "big";
            if (wr != target || topmost != wantTop)
                Native.SetWindowPos(barWnd, wantTop ? Native.HWND_TOPMOST : Native.HWND_NOTOPMOST, target.X, target.Y, target.Width, target.Height, Native.SWP_NOACTIVATE | Native.SWP_SHOWWINDOW);
        }

        // ---------- Zoom ----------

        string ProcessName(uint pid)
        {
            string name;
            if (!processNames.TryGetValue(pid, out name))
            {
                try { name = Process.GetProcessById((int)pid).ProcessName; } catch (Exception) { name = ""; }
                processNames[pid] = name;
            }
            return name;
        }

        bool IsZoomProcess(uint pid) { return string.Equals(ProcessName(pid), "Zoom", StringComparison.OrdinalIgnoreCase); }

        IntPtr FindZoomWindow()
        {
            IntPtr best = IntPtr.Zero;
            long bestScore = 0;
            Native.EnumWindows(delegate(IntPtr h, IntPtr l)
            {
                if (!Native.IsWindowVisible(h)) return true;
                uint pid;
                Native.GetWindowThreadProcessId(h, out pid);
                if (!IsZoomProcess(pid)) return true;
                string cls = Native.ClassOf(h), title = Native.Title(h);
                Rectangle r = Native.WindowRect(h);
                string seen = cls + " | " + title + " | " + r.Width + "x" + r.Height;
                if (!loggedZoomWindows.Contains(seen)) { loggedZoomWindows.Add(seen); Engine.Log("Zoom window: " + seen); }
                bool minimized = Native.IsIconic(h);
                long score;
                if (cls == "ZPContentViewWndClass") score = 3;
                // Otherwise only a big window with "Meeting" in its name: not the small "before you join" window or pop-ups.
                else if (title.IndexOf("Meeting", StringComparison.OrdinalIgnoreCase) >= 0 && cls.IndexOf("Float", StringComparison.OrdinalIgnoreCase) < 0 &&
                         !minimized && r.Width >= 800 && r.Height >= 560) score = 2;
                else return true;
                if (!minimized && r.Width * (long)r.Height < 300 * 200) return true;
                score = score * 100000000L + Math.Min(99999999L, r.Width * (long)r.Height);
                if (score > bestScore) { bestScore = score; best = h; }
                return true;
            }, IntPtr.Zero);
            return best;
        }

        // The wall picture from OBS, if it is open full screen on another screen.
        IntPtr FindWallWindow()
        {
            IntPtr found = IntPtr.Zero;
            IntPtr primary = Native.PrimaryMonitor();
            Native.EnumWindows(delegate(IntPtr h, IntPtr l)
            {
                if (!Native.IsWindowVisible(h)) return true;
                if (Native.Title(h).IndexOf("Shiur - Room", StringComparison.OrdinalIgnoreCase) < 0) return true;
                uint pid;
                Native.GetWindowThreadProcessId(h, out pid);
                if (!ProcessName(pid).StartsWith("obs", StringComparison.OrdinalIgnoreCase)) return true;
                if (Native.MonitorFromWindow(h, 2) == primary) return true;
                found = h;
                return false;
            }, IntPtr.Zero);
            return found;
        }

        Rectangle ZoomParkRect()
        {
            // Same shape as the big tiles box, but big enough for Zoom to lay out its tiles well.
            double k = Math.Max(1.0, 960.0 / Math.Max(1, bigZoomBox.Width));
            Size s = new Size((int)(bigZoomBox.Width * k), (int)(bigZoomBox.Height * k));
            IntPtr wall = FindWallWindow();
            if (wall != IntPtr.Zero)
            {
                // Behind the full-screen wall picture. Keep the wall picture on top so Zoom never shows in the room.
                if ((Native.GetWindowLong(wall, Native.GWL_EXSTYLE) & Native.WS_EX_TOPMOST) == 0)
                    Native.SetWindowPos(wall, Native.HWND_TOPMOST, 0, 0, 0, 0, Native.SWP_NOMOVE | Native.SWP_NOSIZE | Native.SWP_NOACTIVATE);
                Rectangle m = Native.ToRect(Native.MonitorInfo(Native.MonitorFromWindow(wall, 2)).rcMonitor);
                int w = Math.Min(s.Width, m.Width), h = Math.Min(s.Height, m.Height);
                return new Rectangle(m.X + (m.Width - w) / 2, m.Y + (m.Height - h) / 2, w, h);
            }
            // No wall screen: just off the edge of the screens.
            Rectangle v = SystemInformation.VirtualScreen;
            return new Rectangle(v.Left - s.Width - 200, v.Top + 20, s.Width, s.Height);
        }

        void KeepZoomInPlace()
        {
            if (zoomWnd == IntPtr.Zero || !Native.IsWindow(zoomWnd))
            {
                if (zoomWnd != IntPtr.Zero) { DropThumb(); zoomWnd = IntPtr.Zero; zoomBig = false; Invalidate(); }
                if ((DateTime.Now - lastZoomSearch).TotalSeconds < 1.5) return;
                lastZoomSearch = DateTime.Now;
                zoomWnd = FindZoomWindow();
                if (zoomWnd == IntPtr.Zero) return;
                Engine.Log("Found the Zoom meeting window: " + Native.Title(zoomWnd));
                zoomBig = false;   // a new meeting window: tuck it away and show its tiles in the app
                lastPark = Rectangle.Empty;
                Invalidate();
            }
            if (!zoomBig)
            {
                if (Native.IsIconic(zoomWnd) || Native.IsZoomed(zoomWnd)) Native.ShowWindow(zoomWnd, Native.SW_SHOWNOACTIVATE);
                Rectangle park = ZoomParkRect();
                // Move it if it has wandered off; Zoom may insist on being a little bigger than asked, which is fine.
                if (Native.WindowRect(zoomWnd).Location != park.Location || park != lastPark)
                {
                    Native.SetWindowPos(zoomWnd, Native.HWND_BOTTOM, park.X, park.Y, park.Width, park.Height, Native.SWP_NOACTIVATE);
                    lastPark = park;
                }
                ShowThumb();
            }
        }

        // Zoom sometimes asks something in a small window of its own. While the big app covers the screen, or while
        // Zoom is tucked away, that window would be hidden: bring it onto the laptop screen and make the app small.
        void CheckZoomDialogs()
        {
            if ((DateTime.Now - lastDialogCheck).TotalSeconds < 1.5) return;
            lastDialogCheck = DateTime.Now;
            if (mode == "screen") return;   // never pop it up in front of everyone; it waits until you press ME or SHOW
            IntPtr found = IntPtr.Zero;
            Native.EnumWindows(delegate(IntPtr h, IntPtr l)
            {
                if (h == zoomWnd || !Native.IsWindowVisible(h) || Native.IsIconic(h)) return true;
                uint pid;
                Native.GetWindowThreadProcessId(h, out pid);
                if (!IsZoomProcess(pid)) return true;
                string cls = Native.ClassOf(h), title = Native.Title(h);
                if (title.Length == 0 || cls == "ZPPTMainFrmWndClassEx" || title == "Zoom Workplace" || title == "Zoom") return true;
                if (cls.IndexOf("Float", StringComparison.OrdinalIgnoreCase) >= 0 || cls.IndexOf("ToolBar", StringComparison.OrdinalIgnoreCase) >= 0) return true;
                Rectangle r = Native.WindowRect(h);
                if (r.Width < 250 || r.Height < 120) return true;
                if (dialogsMoved.Contains(h)) return true;
                found = h;
                return false;
            }, IntPtr.Zero);
            if (found == IntPtr.Zero) return;
            dialogsMoved.Add(found);
            Rectangle work = Native.ToRect(Native.MonitorInfo(Native.PrimaryMonitor()).rcWork);
            Rectangle d = Native.WindowRect(found);
            int w = Math.Min(d.Width, work.Width), hh = Math.Min(d.Height, work.Height);
            Native.SetWindowPos(found, Native.HWND_TOP, work.X + (work.Width - w) / 2, work.Y + (work.Height - hh) / 2, w, hh, Native.SWP_SHOWWINDOW);
            ForceForeground(found);
            Engine.Log("Zoom is asking something; brought it onto the screen: " + Native.ClassOf(found) + " | " + Native.Title(found));
            if (panelSize == "big") ThreadPool.QueueUserWorkItem(delegate { Engine.Post("/api/panel", "{\"size\":\"small\"}", 3000); });
        }

        void ShowThumb()
        {
            if (zoomWnd == IntPtr.Zero) return;
            if (thumb == IntPtr.Zero)
            {
                if (Native.DwmRegisterThumbnail(Handle, zoomWnd, out thumb) != 0) { thumb = IntPtr.Zero; return; }
                lastThumbDest = Rectangle.Empty;
            }
            Rectangle dest = zoomBox;
            Native.SIZE src;
            if (Native.DwmQueryThumbnailSourceSize(thumb, out src) == 0 && src.cx > 0 && src.cy > 0)
            {
                double k = Math.Min(zoomBox.Width / (double)src.cx, zoomBox.Height / (double)src.cy);
                int w = (int)(src.cx * k), h = (int)(src.cy * k);
                dest = new Rectangle(zoomBox.X + (zoomBox.Width - w) / 2, zoomBox.Y + (zoomBox.Height - h) / 2, w, h);
            }
            if (dest == lastThumbDest) return;
            lastThumbDest = dest;
            Native.DWM_THUMBNAIL_PROPERTIES p = new Native.DWM_THUMBNAIL_PROPERTIES();
            p.dwFlags = Native.DWM_TNP_RECTDESTINATION | Native.DWM_TNP_VISIBLE | Native.DWM_TNP_OPACITY | Native.DWM_TNP_SOURCECLIENTAREAONLY;
            p.rcDestination.Left = dest.Left; p.rcDestination.Top = dest.Top; p.rcDestination.Right = dest.Right; p.rcDestination.Bottom = dest.Bottom;
            p.opacity = 255;
            p.fVisible = true;
            p.fSourceClientAreaOnly = true;
            Native.DwmUpdateThumbnailProperties(thumb, ref p);
        }

        void DropThumb()
        {
            if (thumb != IntPtr.Zero) { Native.DwmUnregisterThumbnail(thumb); thumb = IntPtr.Zero; }
            lastThumbDest = Rectangle.Empty;
        }

        // Bring Zoom up big on the laptop screen (the engine has switched away from SCREEN and made the app small).
        void ZoomBig()
        {
            if (zoomWnd == IntPtr.Zero || !Native.IsWindow(zoomWnd)) { zoomWnd = FindZoomWindow(); if (zoomWnd == IntPtr.Zero) return; }
            zoomBig = true;
            lastPark = Rectangle.Empty;
            DropThumb();
            Rectangle work = Native.ToRect(Native.MonitorInfo(Native.PrimaryMonitor()).rcWork);
            if (Native.IsIconic(zoomWnd)) Native.ShowWindow(zoomWnd, Native.SW_RESTORE);
            Native.SetWindowPos(zoomWnd, Native.HWND_TOP, work.X, work.Y, work.Width, work.Height, Native.SWP_SHOWWINDOW);
            ForceForeground(zoomWnd);
            Invalidate();
        }

        void ParkZoom()
        {
            if (!zoomBig) return;
            zoomBig = false;
            lastPark = Rectangle.Empty;
            KeepZoomInPlace();
            Invalidate();
        }

        static void ForceForeground(IntPtr h)
        {
            uint pid;
            IntPtr fg = Native.GetForegroundWindow();
            uint fgThread = Native.GetWindowThreadProcessId(fg, out pid), me = Native.GetCurrentThreadId();
            bool attached = fgThread != 0 && fgThread != me && Native.AttachThreadInput(me, fgThread, true);
            Native.BringWindowToTop(h);
            Native.SetForegroundWindow(h);
            if (attached) Native.AttachThreadInput(me, fgThread, false);
        }

        protected override void OnMouseClick(MouseEventArgs e)
        {
            base.OnMouseClick(e);
            if (ending) return;
            Rectangle tap = captionBox.IsEmpty ? zoomBox : Rectangle.Union(zoomBox, captionBox);
            if (!tap.Contains(e.Location)) return;
            if (zoomWnd == IntPtr.Zero)
            {
                ThreadPool.QueueUserWorkItem(delegate { Engine.Post("/api/open-zoom", "{}", 3000); });
                return;
            }
            if (zoomBig) { ThreadPool.QueueUserWorkItem(delegate { Engine.Post("/api/panel", "{\"size\":\"big\"}", 3000); }); ParkZoom(); }
            else
            {
                ZoomBig();
                ThreadPool.QueueUserWorkItem(delegate { Engine.Post("/api/zoom-front", "{}", 3000); });
            }
        }

        // ---------- leaving the big app ----------

        // When another window is opened or clicked while the big app is showing, become the strip, so that window can be seen.
        protected override void OnDeactivate(EventArgs e)
        {
            base.OnDeactivate(e);
            if (ending || panelSize != "big") return;
            System.Windows.Forms.Timer t = new System.Windows.Forms.Timer();
            t.Interval = 200;
            t.Tick += delegate { t.Stop(); t.Dispose(); CheckLeftTheApp(); };
            t.Start();
        }

        void CheckLeftTheApp()
        {
            if (ending || panelSize != "big") return;
            IntPtr fg = Native.GetForegroundWindow();
            if (fg == IntPtr.Zero || fg == Handle) return;
            if (Native.GetAncestor(fg, 3) == Handle) return;           // our own pop-ups, like choosing files
            if (useChrome && fg == barWnd) return;
            uint pid;
            Native.GetWindowThreadProcessId(fg, out pid);
            if (pid == (uint)Process.GetCurrentProcess().Id) return;
            string name = ProcessName(pid), cls = Native.ClassOf(fg);
            if (name.StartsWith("msedgewebview2", StringComparison.OrdinalIgnoreCase)) return;   // pop-ups of the controls themselves
            // The taskbar, Start menu and search: wait until an actual window opens.
            if (cls == "Shell_TrayWnd" || cls == "Shell_SecondaryTrayWnd" || name == "StartMenuExperienceHost" || name == "SearchHost" ||
                name == "SearchApp" || name == "ShellExperienceHost" || name == "ShellHost") return;
            Engine.Log("Another window came in front (" + name + "): making the app the strip");
            panelSize = "small";
            panelLocalUntil = DateTime.Now.AddSeconds(2);
            ApplyLayout();
            ThreadPool.QueueUserWorkItem(delegate { Engine.Post("/api/panel", "{\"size\":\"small\"}", 3000); });
        }

        // ---------- telling the engine what to show ----------

        void ReportScreen()
        {
            Native.MONITORINFO mi = Native.MonitorInfo(Native.PrimaryMonitor());
            Rectangle mon = Native.ToRect(mi.rcMonitor), work = Native.ToRect(mi.rcWork);
            string json = "{\"mon\":{\"x\":" + mon.X + ",\"y\":" + mon.Y + ",\"w\":" + mon.Width + ",\"h\":" + mon.Height + "}," +
                          "\"work\":{\"x\":" + work.X + ",\"y\":" + work.Y + ",\"w\":" + work.Width + ",\"h\":" + work.Height + "},\"zoomPanel\":true}";
            if (json == lastReport && (DateTime.Now - lastReportAt).TotalSeconds < 10) return;
            lastReport = json;
            lastReportAt = DateTime.Now;
            ThreadPool.QueueUserWorkItem(delegate { if (Engine.Post("/api/bar", json, 3000) == null) lastReport = ""; });
        }

        // ---------- drawing (the Zoom tiles themselves are drawn by Windows on top) ----------

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;
            g.Clear(BackColor);
            bool small = panelSize != "big";
            using (Font font = new Font("Segoe UI", small ? 8.5f : 11f, FontStyle.Regular))
            using (Font big = new Font("Segoe UI", 13f, FontStyle.Regular))
            using (SolidBrush muted = new SolidBrush(Color.FromArgb(169, 176, 188)))
            using (SolidBrush text = new SolidBrush(Color.FromArgb(243, 239, 230)))
            using (SolidBrush box = new SolidBrush(Color.FromArgb(11, 13, 17)))
            using (Pen line = new Pen(Color.FromArgb(54, 61, 73), Math.Max(1f, scale)))
            using (StringFormat center = new StringFormat())
            {
                center.Alignment = StringAlignment.Center;
                center.LineAlignment = StringAlignment.Center;
                if (zoomBox.Width > 0)
                {
                    using (GraphicsPath path = Rounded(zoomBox, (int)((small ? 8 : 14) * scale)))
                    {
                        g.FillPath(box, path);
                        g.DrawPath(line, path);
                    }
                    string inside = zoomWnd == IntPtr.Zero ? (small ? "Tap to open Zoom" : "Zoom is not open yet") : zoomBig ? (small ? "Zoom is open" : "Zoom is open on your screen") : "";
                    if (inside.Length > 0) g.DrawString(inside, font, muted, zoomBox, center);
                    if (!captionBox.IsEmpty)
                    {
                        string cap = zoomWnd == IntPtr.Zero ? "Tap to open Zoom" : zoomBig ? "Tap to put Zoom back here" : "Zoom  ·  tap to open Zoom big";
                        g.DrawString(cap, font, muted, captionBox, center);
                    }
                }
                if (webRect.Width > 0) g.DrawString(status, big, text, webRect, center);
            }
        }

        static GraphicsPath Rounded(Rectangle r, int radius)
        {
            GraphicsPath p = new GraphicsPath();
            int d = Math.Max(2, radius * 2);
            p.AddArc(r.X, r.Y, d, d, 180, 90);
            p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            p.CloseFigure();
            return p;
        }

        // ---------- ending ----------

        // Ask OBS to close the normal way (like clicking its X), so it starts cleanly next time.
        void CloseObs()
        {
            Native.EnumWindows(delegate(IntPtr h, IntPtr l)
            {
                uint pid;
                Native.GetWindowThreadProcessId(h, out pid);
                if (!ProcessName(pid).StartsWith("obs", StringComparison.OrdinalIgnoreCase)) return true;
                if (!Native.Title(h).StartsWith("OBS ")) return true;
                Engine.Log("Closing OBS: " + Native.Title(h));
                Native.PostMessage(h, Native.WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
                return true;
            }, IntPtr.Zero);
        }

        void BeginEnd(bool closeObs)
        {
            if (ending) return;
            ending = true;
            Engine.Log("Ending");
            if (closeObs) CloseObs();
            status = "Closing...";
            // Bring Zoom back onto the screen so the meeting can be ended there.
            if (zoomWnd != IntPtr.Zero && Native.IsWindow(zoomWnd)) { zoomBig = false; ZoomBig(); }
            if (useChrome && barWnd != IntPtr.Zero && Native.IsWindow(barWnd)) Native.PostMessage(barWnd, Native.WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
            panelSize = "small";
            ApplyLayout();
            System.Windows.Forms.Timer t = new System.Windows.Forms.Timer();
            t.Interval = 2500;
            t.Tick += delegate { t.Stop(); Close(); };
            t.Start();
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (timer != null) timer.Stop();
            DropThumb();
            // Never leave Zoom hidden away.
            if (zoomWnd != IntPtr.Zero && Native.IsWindow(zoomWnd) && !zoomBig)
            {
                Rectangle work = Native.ToRect(Native.MonitorInfo(Native.PrimaryMonitor()).rcWork);
                Native.SetWindowPos(zoomWnd, Native.HWND_TOP, work.X + work.Width / 8, work.Y + work.Height / 8, work.Width * 3 / 4, work.Height * 3 / 4, Native.SWP_SHOWWINDOW);
            }
            if (useChrome && barWnd != IntPtr.Zero && Native.IsWindow(barWnd)) Native.PostMessage(barWnd, Native.WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
            if (registered)
            {
                Native.APPBARDATA abd = NewAbd();
                Native.SHAppBarMessage(Native.ABM_REMOVE, ref abd);
                registered = false;
            }
            Engine.Log("Shiur app closed");
            base.OnFormClosing(e);
        }
    }
}
