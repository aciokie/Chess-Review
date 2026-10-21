// ChessReviewHost.cs — Chess Review's Native Messaging host.
//
//   browser extension  ->  this helper (Native Messaging, length-prefixed JSON on stdio)
//                      ->  a native Stockfish executable (UCI on its stdin/stdout)
//
// The helper is started *by the browser* when the extension calls connectNative(), and it exits as
// soon as the port closes — there is no background service. It owns exactly one Stockfish process,
// which it starts without a console window and always reaps before exiting:
//
//   * browser closes / extension disconnects  -> stdin EOF -> quit + kill engine + exit
//   * analysis finished (port.disconnect)     -> stdin EOF -> same
//   * {"type":"quit"} from the extension      -> same, exit code 0
//   * engine crashed / went silent            -> fatal error to the extension + exit
//   * protocol corruption / oversize frame    -> fatal error + exit
//
// Build: native/install.ps1 compiles this with the csc.exe that ships with Windows (.NET Framework
// 4.x, language level C# 5 — so this file deliberately avoids newer syntax). No SDK, no NuGet.
//
// stdout carries ONLY Native Messaging frames. Every diagnostic goes to stderr (and optionally to
// the log file named in config.json).

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

// How long to wait for the engine to answer `uci` / `isready`. The first launch of a large
// Stockfish executable can be blocked for a long time by antivirus/Defender scanning it — the repo
// already accepts a 60 s handshake for the big WASM build, so be equally patient here.
// (Opened by the browser: the extension adapter uses a matching per-phase budget.)

namespace ChessReview.NativeHost
{
    internal static class Program
    {
        public const string HostVersion = "1.0.0";
        // Keep in sync with engine/native.js NATIVE_MAX_FRAME_BYTES.
        public const int MaxFrameBytes = 8 * 1024 * 1024;
        private const int SwHide = 0;

        [DllImport("kernel32.dll")]
        private static extern IntPtr GetConsoleWindow();

        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        private static int Main(string[] args)
        {
            // The helper may be launched from the store extension and from an unpacked dev copy; a
            // visible console would be an obvious defect, and the .bat-free flow means the browser
            // never sees one anyway. Belt and braces: hide our own console if we were given one.
            try
            {
                IntPtr console = GetConsoleWindow();
                if (console != IntPtr.Zero) ShowWindow(console, SwHide);
            }
            catch { /* no console / not Windows-interactive: fine */ }

            int code = 1;
            try
            {
                string exePath = System.Reflection.Assembly.GetExecutingAssembly().Location;
                string exeDir = String.IsNullOrEmpty(exePath) ? AppDomain.CurrentDomain.BaseDirectory : Path.GetDirectoryName(exePath);
                HostConfig config = HostConfig.Load(exeDir);
                Log.Open(config.LogFile);

                using (Stream stdin = Console.OpenStandardInput())
                using (Stream stdout = Console.OpenStandardOutput())
                {
                    NativeHost host = new NativeHost(config, stdin, stdout);
                    code = host.Run();
                }
            }
            catch (Exception ex)
            {
                Log.Write("fatal: " + ex);
                code = 1;
            }
            finally
            {
                Log.Close();
            }
            return code;
        }
    }

    /// <summary>Append-only stderr/file log. stdout is reserved for protocol frames.</summary>
    internal static class Log
    {
        private static readonly object Gate = new object();
        private static StreamWriter _file;
        // Diagnostics go to the log file; stderr is opt-in because a browser that died without
        // closing its pipes can leave Console.Error blocking in the kernel forever — and a helper
        // that cannot finish exiting is worse than one without console output.
        private static readonly bool StdErrEnabled;

        static Log()
        {
            string flag = Environment.GetEnvironmentVariable("CHESS_REVIEW_HOST_DEBUG");
            StdErrEnabled = !String.IsNullOrEmpty(flag) && flag != "0";
        }

        public static void Open(string logFile)
        {
            if (String.IsNullOrEmpty(logFile)) return;
            try
            {
                string dir = Path.GetDirectoryName(logFile);
                if (!String.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                _file = new StreamWriter(logFile, true, new UTF8Encoding(false));
                _file.AutoFlush = true;
            }
            catch { _file = null; }
        }

        public static void Write(string message)
        {
            string line = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff", CultureInfo.InvariantCulture) + "  " + message;
            lock (Gate)
            {
                if (StdErrEnabled) { try { Console.Error.WriteLine(line); } catch { } }
                if (_file != null) { try { _file.WriteLine(line); } catch { } }
            }
        }

        public static void Close()
        {
            lock (Gate) { if (_file != null) { try { _file.Dispose(); } catch { } _file = null; } }
        }
    }

    /// <summary>The few Win32 calls the helper needs, kept in one place.</summary>
    internal static class NativeMethods
    {
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern IntPtr GetCurrentProcess();

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool TerminateProcess(IntPtr process, uint exitCode);
    }

    /// <summary>
    /// A Windows job object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE. Even a forcibly killed helper
    /// (browser shutdown, crash, antivirus intervention) cannot orphan its engine: when our last job
    /// handle closes the OS terminates every process assigned to it. Only the Stockfish child we
    /// started is ever assigned, so no unrelated process can be affected.
    /// </summary>
    internal sealed class ProcessJob : IDisposable
    {
        private const int JobObjectExtendedLimitInformation = 9;
        private const uint JobObjectLimitKillOnJobClose = 0x2000;
        private IntPtr _handle;

        [StructLayout(LayoutKind.Sequential)]
        private struct BasicLimitInformation
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IoCounters
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct ExtendedLimitInformation
        {
            public BasicLimitInformation BasicLimitInformation;
            public IoCounters IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

        [DllImport("kernel32.dll")]
        private static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint infoLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        public static ProcessJob Create()
        {
            IntPtr handle = IntPtr.Zero;
            try
            {
                handle = CreateJobObject(IntPtr.Zero, null);
                if (handle == IntPtr.Zero) return null;
                ExtendedLimitInformation info = new ExtendedLimitInformation();
                info.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
                int size = Marshal.SizeOf(info);
                IntPtr buffer = Marshal.AllocHGlobal(size);
                try
                {
                    Marshal.StructureToPtr(info, buffer, false);
                    if (!SetInformationJobObject(handle, JobObjectExtendedLimitInformation, buffer, (uint)size))
                    {
                        CloseHandle(handle);
                        return null;
                    }
                }
                finally { Marshal.FreeHGlobal(buffer); }
                ProcessJob job = new ProcessJob();
                job._handle = handle;
                return job;
            }
            catch (Exception ex)
            {
                Log.Write("job object unavailable (" + ex.Message + "); falling back to explicit reaping");
                if (handle != IntPtr.Zero) CloseHandle(handle);
                return null;
            }
        }

        public bool Assign(Process process)
        {
            if (_handle == IntPtr.Zero || process == null) return false;
            try { return AssignProcessToJobObject(_handle, process.Handle); }
            catch { return false; }
        }

        public void Dispose()
        {
            if (_handle == IntPtr.Zero) return;
            try { CloseHandle(_handle); } catch { }
            _handle = IntPtr.Zero;
        }
    }

    /// <summary>Host configuration: config.json next to the exe (written by native/install.ps1).</summary>
    internal sealed class HostConfig
    {
        public string EnginePath = "";
        public string EvalFile = "";
        public string LogFile = "";
        public List<string> EngineArgs = new List<string>();
        public int Threads = 1;
        public int HashMb = 16;
        public int SearchTimeoutMs = 120000;

        public static HostConfig Load(string exeDir)
        {
            HostConfig config = new HostConfig();
            string path = Path.Combine(exeDir ?? ".", "config.json");
            try
            {
                if (File.Exists(path))
                {
                    string json = File.ReadAllText(path, Encoding.UTF8);
                    Dictionary<string, object> map = Json.DeserializeObject(json) as Dictionary<string, object>;
                    if (map != null)
                    {
                        config.EnginePath = Json.String(map, "enginePath");
                        config.EvalFile = Json.String(map, "evalFile");
                        config.LogFile = Json.String(map, "logFile");
                        config.Threads = Json.Int(map, "threads", 1, 64, 1);
                        config.HashMb = Json.Int(map, "hashMb", 1, 4096, 16);
                        config.SearchTimeoutMs = Json.Int(map, "searchTimeoutMs", 500, 600000, 120000);
                        object[] args = map.ContainsKey("engineArgs") ? map["engineArgs"] as object[] : null;
                        if (args != null)
                        {
                            foreach (object arg in args)
                            {
                                string text = arg as string;
                                if (!String.IsNullOrEmpty(text)) config.EngineArgs.Add(text);
                            }
                        }
                    }
                }
            }
            catch (Exception ex) { Log.Write("config.json unreadable (" + path + "): " + ex.Message); }

            // Advanced override for portable/testing setups.
            string envPath = Environment.GetEnvironmentVariable("CHESS_REVIEW_ENGINE_PATH");
            if (!String.IsNullOrEmpty(envPath)) config.EnginePath = envPath;

            return config;
        }

        /// <summary>Absolute, existing file — anything else is treated as "not configured".</summary>
        public bool EngineConfigured
        {
            get
            {
                try { return !String.IsNullOrEmpty(EnginePath) && Path.IsPathRooted(EnginePath) && File.Exists(EnginePath); }
                catch { return false; }
            }
        }
    }

    internal static class Json
    {
        private static readonly JavaScriptSerializer Serializer = CreateSerializer();
        private static readonly object Gate = new object();

        private static JavaScriptSerializer CreateSerializer()
        {
            JavaScriptSerializer s = new JavaScriptSerializer();
            s.MaxJsonLength = Program.MaxFrameBytes;
            return s;
        }

        public static string Serialize(object value)
        {
            lock (Gate) { return Serializer.Serialize(value); }
        }

        public static object DeserializeObject(string json)
        {
            lock (Gate) { return Serializer.DeserializeObject(json); }
        }

        public static string String(Dictionary<string, object> map, string key)
        {
            if (map == null || !map.ContainsKey(key)) return "";
            object value = map[key];
            return value == null ? "" : Convert.ToString(value, CultureInfo.InvariantCulture);
        }

        public static int Int(Dictionary<string, object> map, string key, int min, int max, int fallback)
        {
            if (map == null || !map.ContainsKey(key)) return fallback;
            object value = map[key];
            if (value == null) return fallback;
            decimal d;
            try { d = Convert.ToDecimal(value, CultureInfo.InvariantCulture); }
            catch { return fallback; }
            int n = (int)Math.Truncate(d);
            if (n < min) return min;
            if (n > max) return max;
            return n;
        }
    }

    /// <summary>A single in-flight search. Owns the JSON to answer with.</summary>
    internal sealed class Job
    {
        public object Id;
        public int Multipv = 1;
        public readonly SortedDictionary<int, Dictionary<string, object>> Lines = new SortedDictionary<int, Dictionary<string, object>>();
        public Dictionary<string, object> Score;
        public string Pv = "";
    }

    internal sealed class NativeHost
    {
        private static readonly Regex FenPattern = new Regex(
            @"^[rnbqkpRNBQKP1-8/]{1,80} [wb] (K?Q?k?q?|-{1}) ([a-h][36]|-{1}) \d{1,4} \d{1,4}$",
            RegexOptions.Compiled);
        private static readonly Regex MovePattern = new Regex(@"^(?:[a-h][1-8][a-h][1-8][qrbnQRBN]?|0000)$", RegexOptions.Compiled);
        private static readonly Regex InfoScore = new Regex(@" score (cp|mate) (-?\d+)", RegexOptions.Compiled);
        private static readonly Regex InfoDepth = new Regex(@" depth (\d+)", RegexOptions.Compiled);
        private static readonly Regex InfoMultipv = new Regex(@" multipv (\d+)", RegexOptions.Compiled);
        private static readonly Regex InfoPv = new Regex(@" pv (.+)$", RegexOptions.Compiled);
        private static readonly Regex InfoBound = new Regex(@"\b(lowerbound|upperbound)\b", RegexOptions.Compiled);
        private static readonly Regex InfoOptionName = new Regex(@"^option name (.+?) type ", RegexOptions.Compiled);

        private readonly HostConfig _config;
        private readonly Stream _stdin;
        private readonly Stream _stdout;
        private readonly object _writeGate = new object();
        private readonly object _jobGate = new object();
        private readonly HashSet<string> _engineOptions = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        private const int UciHandshakeMs = 45000;   // process creation (+ AV scan) can be very slow once
        private const int ReadyHandshakeMs = 15000; // once the process runs, `isready` is instant
        private const int IdleExitMs = 1800000;     // 30 min with no traffic and no search -> exit

        private Process _engine;
        private ProcessJob _engineJob;
        private StreamWriter _engineIn;
        private Thread _reader;
        private Timer _watchdog;

        private readonly ManualResetEventSlim _uciOk = new ManualResetEventSlim(false);
        private readonly ManualResetEventSlim _readyOk = new ManualResetEventSlim(false);

        private Job _current;
        private string _uciIdName = "";
        private int _engineMultipv = 1;
        private bool _engineStarted;
        private bool _shuttingDown;
        private bool _fatalSent;
        private long _lastEngineOutputTicks;
        private long _lastIncomingTicks = DateTime.UtcNow.Ticks;

        public NativeHost(HostConfig config, Stream stdin, Stream stdout)
        {
            _config = config;
            _stdin = stdin;
            _stdout = stdout;
        }

        public int Run()
        {
            Log.Write("host " + Program.HostVersion + " starting; engine configured=" + _config.EngineConfigured
                + " path='" + _config.EnginePath + "'");

            // The extension probes availability by waiting for this. It is sent BEFORE Stockfish is
            // started, so opening the settings tab never launches an engine.
            SendObject(new Dictionary<string, object> {
                { "type", "hello" },
                { "version", Program.HostVersion },
                { "engineConfigured", _config.EngineConfigured },
            });

            // The browser kills us on a normal shutdown, and stdin EOF covers most crashes — but if
            // the browser dies abnormally while a zombie process still holds the pipe handles, no
            // EOF ever arrives. A helper must never become a permanent background process, so exit
            // after a long idle period with no traffic and no running search.
            Thread idleThread = new Thread(IdleExitLoop);
            idleThread.IsBackground = true;
            idleThread.Name = "chessreview-idle-exit";
            idleThread.Start();

            while (true)
            {
                byte[] frame;
                try { frame = ReadFrame(_stdin); }
                catch (Exception ex) { Fail("protocol error: " + ex.Message); return 1; }
                if (frame == null) { Log.Write("stdin closed; shutting down"); Shutdown(0); return 0; }
                Interlocked.Exchange(ref _lastIncomingTicks, DateTime.UtcNow.Ticks);

                string text;
                try { text = new UTF8Encoding(false).GetString(frame); }
                catch (Exception ex) { Fail("protocol error: undecodable frame: " + ex.Message); return 1; }

                object parsed;
                try { parsed = Json.DeserializeObject(text); }
                catch (Exception ex) { Fail("protocol error: invalid JSON: " + ex.Message); return 1; }

                Dictionary<string, object> message = parsed as Dictionary<string, object>;
                if (message == null) { Fail("protocol error: message is not an object"); return 1; }

                if (!Dispatch(message)) return 0;
            }
        }

        /// <summary>Returns false when the host should exit.</summary>
        private bool Dispatch(Dictionary<string, object> message)
        {
            string type = Json.String(message, "type");
            switch (type)
            {
                case "init": return HandleInit(message);
                case "setoption": HandleSetOption(message); return true;
                case "analyse": HandleAnalyse(message); return true;
                case "stop": HandleStop(message); return true;
                case "ping": SendObject(new Dictionary<string, object> { { "type", "pong" } }); return true;
                case "quit": Log.Write("quit requested"); Shutdown(0); return false;
                default:
                    SendError(null, "unknown message type", false);
                    return true;
            }
        }

        /* ---------------- init / engine lifecycle ---------------- */

        private bool HandleInit(Dictionary<string, object> message)
        {
            Dictionary<string, object> options = message.ContainsKey("options") ? message["options"] as Dictionary<string, object> : null;
            if (_engineStarted)
            {
                // A second init on the same port must not spawn a second engine.
                ApplyOptions(options);
                SendReady();
                return true;
            }
            if (!_config.EngineConfigured)
            {
                Fail("no Stockfish executable is configured for the native helper. "
                    + "Set enginePath in config.json (see native/README.md).");
                return false;
            }
            if (!StartEngine())
            {
                Fail("could not start the native Stockfish executable at '" + _config.EnginePath + "'.");
                return false;
            }
            ApplyOptions(options);
            SendReady();
            return true;
        }

        private bool StartEngine()
        {
            ProcessStartInfo info = new ProcessStartInfo();
            info.FileName = _config.EnginePath;
            info.UseShellExecute = false;
            info.CreateNoWindow = true;            // Stockfish must never flash a console window
            info.RedirectStandardInput = true;
            info.RedirectStandardOutput = true;
            info.RedirectStandardError = true;
            info.StandardOutputEncoding = new UTF8Encoding(false);
            info.StandardErrorEncoding = new UTF8Encoding(false);
            try { info.WorkingDirectory = Path.GetDirectoryName(_config.EnginePath); }
            catch { }
            if (_config.EngineArgs.Count > 0)
            {
                StringBuilder args = new StringBuilder();
                for (int i = 0; i < _config.EngineArgs.Count; i++)
                {
                    if (i > 0) args.Append(' ');
                    args.Append('"').Append(_config.EngineArgs[i].Replace("\"", "")).Append('"');
                }
                info.Arguments = args.ToString();
            }

            try
            {
                _engine = new Process();
                _engine.StartInfo = info;
                _engine.EnableRaisingEvents = true;
                _engine.Exited += OnEngineExited;

                // A job object with KILL_ON_JOB_CLOSE is the only way to guarantee the engine dies
                // with us if the browser (or antivirus) force-kills this helper: the OS then kills
                // every process we assigned to the job. Only OUR child is ever assigned.
                _engineJob = ProcessJob.Create();

                // Antivirus can briefly deny CreateProcess on an engine it is still scanning (a
                // just-downloaded Stockfish, for instance). Retry a few times before giving up so a
                // first review doesn't fall back to WASM for no reason.
                for (int attempt = 1; attempt <= 3; attempt++)
                {
                    try { _engine.Start(); break; }
                    catch (Exception ex)
                    {
                        Log.Write("engine start attempt " + attempt + " failed: " + ex.Message);
                        if (attempt == 3) throw;
                        Thread.Sleep(1500);
                    }
                }

                if (_engineJob != null && !_engineJob.Assign(_engine))
                    Log.Write("could not attach the engine to the cleanup job object (continuing)");
                _engineIn = _engine.StandardInput;
                _engineIn.AutoFlush = true;
            }
            catch (Exception ex)
            {
                Log.Write("engine start failed: " + ex);
                if (_engine != null) { try { _engine.Dispose(); } catch { } }
                _engine = null;
                return false;
            }

            _engineStarted = true;
            Interlocked.Exchange(ref _lastEngineOutputTicks, DateTime.UtcNow.Ticks);
            _reader = new Thread(ReadEngineLoop);
            _reader.IsBackground = true;
            _reader.Name = "chessreview-uci";
            _reader.Start();

            _watchdog = new Timer(WatchdogTick, null, 500, 500);

            SendUci("uci");
            if (!_uciOk.Wait(UciHandshakeMs))
            {
                Log.Write("engine did not answer 'uci' in time");
                return false;
            }
            SendUci("isready");
            if (!_readyOk.Wait(ReadyHandshakeMs))
            {
                Log.Write("engine did not answer 'isready' in time");
                return false;
            }
            string evalFile = !String.IsNullOrEmpty(_config.EvalFile) ? _config.EvalFile : "";
            if (!String.IsNullOrEmpty(evalFile) && File.Exists(evalFile)) SendUci("setoption name EvalFile value " + evalFile);
            else if (!String.IsNullOrEmpty(evalFile)) Log.Write("configured EvalFile does not exist: " + evalFile);
            SendUci("setoption name Threads value " + _config.Threads.ToString(CultureInfo.InvariantCulture));
            SendUci("setoption name Hash value " + _config.HashMb.ToString(CultureInfo.InvariantCulture));
            Log.Write("engine ready: '" + _uciIdName + "', threads=" + _config.Threads + ", hash=" + _config.HashMb);
            return true;
        }

        // "Verified" means the executable's OWN `id name` says Stockfish 19 (e.g. "Stockfish 19" or
        // "Stockfish 19.1"). Another Stockfish version, a dev build or a different engine is still
        // started - the extension just shows what it really is instead of calling it Stockfish 19.
        private static bool IsVerifiedStockfish19(string idName)
        {
            return Regex.IsMatch(idName ?? "", @"^\s*Stockfish\s+19(\.\d+)*(\s|$)", RegexOptions.IgnoreCase);
        }

        private void SendReady()
        {
            Dictionary<string, object> engine = new Dictionary<string, object> {
                { "name", _uciIdName },
                { "verified", IsVerifiedStockfish19(_uciIdName) },
            };
            SendObject(new Dictionary<string, object> {
                { "type", "ready" },
                { "engine", engine },
                { "engineConfigured", _config.EngineConfigured },
                // Diagnostic only (and the smoke test uses it to check the exact child process).
                { "enginePid", _engine != null ? _engine.Id : 0 },
            });
        }

        private void OnEngineExited(object sender, EventArgs e)
        {
            if (_shuttingDown) return;
            Job job;
            lock (_jobGate) { job = _current; }
            Log.Write("engine process exited unexpectedly" + (job != null ? " during search" : ""));
            SendObject(new Dictionary<string, object> {
                { "type", "error" },
                { "message", "the native Stockfish process exited unexpectedly" },
                { "fatal", true },
                { "id", job != null ? job.Id : null },
            });
            Shutdown(2);
        }

        private void WatchdogTick(object state)
        {
            if (_shuttingDown) return;
            Job job;
            lock (_jobGate) { job = _current; }
            if (job == null) return;
            long last = Interlocked.Read(ref _lastEngineOutputTicks);
            long silentMs = (DateTime.UtcNow.Ticks - last) / TimeSpan.TicksPerMillisecond;
            if (silentMs > _config.SearchTimeoutMs)
            {
                Log.Write("engine silent for " + silentMs + "ms; failing the search");
                SendObject(new Dictionary<string, object> {
                    { "type", "error" },
                    { "message", "the native Stockfish process stopped responding" },
                    { "fatal", true },
                    { "id", job.Id },
                });
                Shutdown(2);
            }
        }

        /// <summary>
        /// A helper that has seen no traffic and no engine activity for IdleExitMs is abandoned (its
        /// browser died without closing the pipe). Exit so nothing outlives the review session.
        /// </summary>
        private void IdleExitLoop()
        {
            while (!_shuttingDown)
            {
                Thread.Sleep(30000);
                if (_shuttingDown) return;
                long idleMs = (DateTime.UtcNow.Ticks - Interlocked.Read(ref _lastIncomingTicks)) / TimeSpan.TicksPerMillisecond;
                if (idleMs < IdleExitMs) continue;
                lock (_jobGate) { if (_current != null) { Interlocked.Exchange(ref _lastIncomingTicks, DateTime.UtcNow.Ticks); continue; } }
                Log.Write("no traffic for " + idleMs + " ms; exiting (abandoned connection)");
                Shutdown(0);
                return;
            }
        }

        /// <summary>
        /// Tear everything down. A bail-out timer guarantees we always exit: a stdout write can block
        /// forever if the browser died without closing its pipe read-end, and this helper must never
        /// hang around — we are exiting anyway, so nothing is lost by forcing it.
        /// </summary>
        private void Shutdown(int code)
        {
            if (_shuttingDown) return;
            _shuttingDown = true;
            Thread bailout = new Thread(delegate()
            {
                Thread.Sleep(2000);
                Log.Write("shutdown did not complete; forcing exit (" + code + ")");
                // TerminateProcess, not Environment.Exit: graceful shutdown can itself block on a
                // wedged stdout/stderr pipe. At this point we are past cleanup, so just make sure
                // the helper (and, via the job object, the engine) is really gone.
                NativeMethods.TerminateProcess(NativeMethods.GetCurrentProcess(), (uint)code);
            });
            bailout.IsBackground = true;
            bailout.Start();
            try { if (_watchdog != null) _watchdog.Dispose(); } catch { }
            try { _uciOk.Set(); _readyOk.Set(); } catch { }
            try { if (_engineIn != null) { _engineIn.WriteLine("quit"); _engineIn.Flush(); } } catch { }
            if (_engine != null)
            {
                try
                {
                    // Reap only the process WE started. Never hunt for other "stockfish" processes.
                    if (!_engine.WaitForExit(1500)) _engine.Kill();
                    else _engine.WaitForExit(500);
                }
                catch (Exception ex) { Log.Write("engine reap failed: " + ex.Message); }
                try { _engine.Dispose(); } catch { }
                _engine = null;
            }
            if (_engineJob != null)
            {
                // Closing the last handle to the kill-on-close job is the final guarantee: anything we
                // assigned to it dies now, even if the graceful quit above did not complete.
                _engineJob.Dispose();
                _engineJob = null;
            }
            Log.Write("host exiting (" + code + ")");
            Environment.Exit(code);
        }

        private void Fail(string message)
        {
            Log.Write("fatal: " + message);
            SendObject(new Dictionary<string, object> {
                { "type", "error" },
                { "message", message },
                { "fatal", true },
            });
            Shutdown(1);
        }

        /* ---------------- UCI plumbing ---------------- */

        private void SendUci(string command)
        {
            if (_engineIn == null) return;
            try { _engineIn.WriteLine(command); }
            catch (Exception ex) { Log.Write("engine write failed ('" + command + "'): " + ex.Message); }
        }

        private void ReadEngineLoop()
        {
            try
            {
                string line;
                while ((line = _engine.StandardOutput.ReadLine()) != null)
                {
                    Interlocked.Exchange(ref _lastEngineOutputTicks, DateTime.UtcNow.Ticks);
                    OnEngineLine(line);
                }
            }
            catch (Exception ex) { Log.Write("engine read loop ended: " + ex.Message); }
        }

        private void OnEngineLine(string line)
        {
            if (line.Length == 0) return;
            if (line.StartsWith("id name ", StringComparison.Ordinal)) { _uciIdName = line.Substring(8).Trim(); return; }
            if (line.StartsWith("id author ", StringComparison.Ordinal)) return;
            if (line.StartsWith("option name ", StringComparison.Ordinal))
            {
                Match optionMatch = InfoOptionName.Match(line);
                if (optionMatch.Success) { lock (_jobGate) { _engineOptions.Add(optionMatch.Groups[1].Value.Trim()); } }
                return;
            }
            if (line.IndexOf("uciok", StringComparison.Ordinal) >= 0) { _uciOk.Set(); return; }
            if (line.IndexOf("readyok", StringComparison.Ordinal) >= 0) { _readyOk.Set(); return; }
            if (line.StartsWith("info ", StringComparison.Ordinal))
            {
                if (line.IndexOf(" score ", StringComparison.Ordinal) >= 0) AccumulateInfo(line);
                return;
            }
            if (line.StartsWith("bestmove", StringComparison.Ordinal)) FinishSearch(line);
        }

        private void AccumulateInfo(string line)
        {
            Match scoreMatch = InfoScore.Match(line);
            if (!scoreMatch.Success) return;
            int value = Int32.Parse(scoreMatch.Groups[2].Value, CultureInfo.InvariantCulture);
            int multipv = 1;
            Match mpvMatch = InfoMultipv.Match(line);
            if (mpvMatch.Success) multipv = Int32.Parse(mpvMatch.Groups[1].Value, CultureInfo.InvariantCulture);
            int depth = 0;
            Match depthMatch = InfoDepth.Match(line);
            if (depthMatch.Success) depth = Int32.Parse(depthMatch.Groups[1].Value, CultureInfo.InvariantCulture);
            Match pvMatch = InfoPv.Match(line);
            string pv = pvMatch.Success ? pvMatch.Groups[1].Value.Trim() : "";
            Match boundMatch = InfoBound.Match(line);
            string bound = boundMatch.Success ? boundMatch.Groups[1].Value : "exact";

            Dictionary<string, object> score = new Dictionary<string, object>();
            score[scoreMatch.Groups[1].Value] = value;
            Dictionary<string, object> entry = new Dictionary<string, object> {
                { "score", score },
                { "pv", pv },
                { "depth", Math.Max(0, Math.Min(512, depth)) },
                { "bound", bound },
                { "multipv", Math.Max(1, Math.Min(500, multipv)) },
            };
            lock (_jobGate)
            {
                Job job = _current;
                if (job == null) return;
                if (multipv > job.Multipv) return;              // never grow past the requested line count
                job.Lines[multipv] = entry;
                if (multipv == 1) { job.Score = score; job.Pv = pv; }
            }
        }

        private void FinishSearch(string line)
        {
            Job job;
            List<Dictionary<string, object>> lines = new List<Dictionary<string, object>>();
            Dictionary<string, object> score = null;
            string pv = "";
            lock (_jobGate)
            {
                job = _current;
                if (job == null) return;
                _current = null;
                foreach (KeyValuePair<int, Dictionary<string, object>> pair in job.Lines) lines.Add(pair.Value);
                score = job.Score;
                pv = job.Pv;
            }
            string[] parts = line.Split(' ');
            string bestmove = parts.Length > 1 ? parts[1] : "";
            if (bestmove == "(none)") bestmove = "";
            SendObject(new Dictionary<string, object> {
                { "type", "bestmove" },
                { "id", job.Id },
                { "bestmove", bestmove },
                { "score", score != null ? (object)score : new Dictionary<string, object> { { "cp", 0 } } },
                { "pv", pv },
                { "lines", lines.ToArray() },
            });
        }

        /* ---------------- analyse / stop ---------------- */

        private void HandleAnalyse(Dictionary<string, object> message)
        {
            object id = message.ContainsKey("id") ? message["id"] : null;
            if (!_engineStarted)
            {
                SendError(id, "the native engine is not running (no 'init' was accepted)", false);
                return;
            }
            string fen = Json.String(message, "fen");
            if (!FenPattern.IsMatch(fen))
            {
                SendError(id, "rejected an invalid position", false);
                return;
            }
            int depth = Json.Int(message, "depth", 1, 128, 12);
            int multipv = Json.Int(message, "multipv", 1, 64, 1);
            string position = "position fen " + fen;
            Dictionary<string, object> history = message.ContainsKey("history") ? message["history"] as Dictionary<string, object> : null;
            if (history != null)
            {
                string initialFen = Json.String(history, "initialFen");
                object[] moves = history.ContainsKey("moves") ? history["moves"] as object[] : null;
                if (!String.IsNullOrEmpty(initialFen) && moves != null && moves.Length > 0)
                {
                    if (!FenPattern.IsMatch(initialFen)) { SendError(id, "rejected an invalid move history", false); return; }
                    if (moves.Length > 1024) { SendError(id, "rejected an over-long move history", false); return; }
                    StringBuilder builder = new StringBuilder();
                    for (int i = 0; i < moves.Length; i++)
                    {
                        string move = moves[i] as string;
                        if (move == null || !MovePattern.IsMatch(move)) { SendError(id, "rejected an invalid move history", false); return; }
                        if (i > 0) builder.Append(' ');
                        builder.Append(move);
                    }
                    position = "position fen " + initialFen + " moves " + builder;
                }
            }

            Job job = new Job();
            job.Id = id;
            job.Multipv = multipv;
            lock (_jobGate)
            {
                if (_current != null)
                {
                    SendError(id, "the native engine is already searching", false);
                    return;
                }
                _current = job;
            }
            Interlocked.Exchange(ref _lastEngineOutputTicks, DateTime.UtcNow.Ticks);
            // Mirror engine/uci.js: clear between positions so a native review is depth-for-depth the
            // same *kind* of cold search the WASM batch performs (classifications stay comparable).
            SendUci("ucinewgame");
            SendUci(position);
            if (multipv != _engineMultipv)
            {
                _engineMultipv = multipv;
                SendUci("setoption name MultiPV value " + multipv.ToString(CultureInfo.InvariantCulture));
            }
            SendUci("go depth " + depth.ToString(CultureInfo.InvariantCulture));
        }

        private void HandleStop(Dictionary<string, object> message)
        {
            // Stockfish answers the pending search with a (possibly partial) bestmove; the extension
            // resolves that job normally, exactly like the WASM adapter's stop().
            SendUci("stop");
        }

        private void HandleSetOption(Dictionary<string, object> message)
        {
            string name = Json.String(message, "name");
            string value = Json.String(message, "value");
            ApplyOption(name, value, false);
        }

        private void ApplyOptions(Dictionary<string, object> options)
        {
            if (options == null) return;
            foreach (KeyValuePair<string, object> pair in options)
                ApplyOption(pair.Key, pair.Value == null ? "" : Convert.ToString(pair.Value, CultureInfo.InvariantCulture), true);
        }

        private void ApplyOption(string name, string value, bool fromInit)
        {
            if (!IsSafeToken(name) || !IsSafeToken(value))
            {
                Log.Write("rejected unsafe UCI option" + (fromInit ? " (init)" : "") + ": '" + name + "'");
                return;
            }
            bool haveOptionList;
            bool known;
            lock (_jobGate) { haveOptionList = _engineOptions.Count > 0; known = _engineOptions.Contains(name); }
            if (haveOptionList && !known)
            {
                Log.Write("ignoring unknown UCI option '" + name + "'");
                return;
            }
            // Bound the options that actually consume resources or change strength semantics.
            int bounded;
            if (name.Equals("Hash", StringComparison.OrdinalIgnoreCase)) bounded = Clamp(value, 1, 4096, 16);
            else if (name.IndexOf("Thread", StringComparison.OrdinalIgnoreCase) >= 0) bounded = Clamp(value, 1, 64, 1);
            else if (name.Equals("MultiPV", StringComparison.OrdinalIgnoreCase)) bounded = Clamp(value, 1, 64, 1);
            else if (name.Equals("Skill Level", StringComparison.OrdinalIgnoreCase)) bounded = Clamp(value, 0, 20, 20);
            else { SendUci("setoption name " + name + " value " + value); return; }
            SendUci("setoption name " + name + " value " + bounded.ToString(CultureInfo.InvariantCulture));
        }

        private static int Clamp(string value, int min, int max, int fallback)
        {
            int parsed;
            if (!Int32.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out parsed)) return fallback;
            if (parsed < min) return min;
            if (parsed > max) return max;
            return parsed;
        }

        /// <summary>Printable ASCII only — the text is written straight to Stockfish's stdin.</summary>
        private static bool IsSafeToken(string value)
        {
            if (value == null || value.Length == 0 || value.Length > 128) return false;
            for (int i = 0; i < value.Length; i++)
            {
                char c = value[i];
                if (c < 0x20 || c > 0x7e) return false;
            }
            return true;
        }

        /* ---------------- Native Messaging framing ---------------- */

        private byte[] ReadFrame(Stream input)
        {
            byte[] header = new byte[4];
            if (!ReadExactly(input, header, 4)) return null;
            int length = BitConverter.ToInt32(header, 0);
            if (length < 0) throw new InvalidDataException("negative frame length");
            if (length > Program.MaxFrameBytes) throw new InvalidDataException("frame larger than " + Program.MaxFrameBytes + " bytes");
            if (length == 0) return new byte[0];
            byte[] payload = new byte[length];
            if (!ReadExactly(input, payload, length)) return null;
            return payload;
        }

        private static bool ReadExactly(Stream stream, byte[] buffer, int count)
        {
            int offset = 0;
            while (offset < count)
            {
                int read = stream.Read(buffer, offset, count - offset);
                if (read <= 0) return false;
                offset += read;
            }
            return true;
        }

        private void SendObject(Dictionary<string, object> message)
        {
            if (_fatalSent && message.ContainsKey("fatal")) return;
            byte[] payload;
            try { payload = new UTF8Encoding(false).GetBytes(Json.Serialize(message)); }
            catch (Exception ex) { Log.Write("could not serialize reply: " + ex.Message); return; }
            byte[] header = BitConverter.GetBytes(payload.Length);
            lock (_writeGate)
            {
                try
                {
                    _stdout.Write(header, 0, 4);
                    _stdout.Write(payload, 0, payload.Length);
                    _stdout.Flush();
                }
                catch (Exception ex) { Log.Write("could not write reply: " + ex.Message); }
            }
        }

        private void SendError(object id, string message, bool fatal)
        {
            if (fatal) _fatalSent = true;
            Dictionary<string, object> reply = new Dictionary<string, object> {
                { "type", "error" },
                { "message", message },
            };
            if (id != null) reply["id"] = id;
            if (fatal) reply["fatal"] = true;
            SendObject(reply);
        }
    }
}