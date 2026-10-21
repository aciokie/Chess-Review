// FakeEngine.cs — a tiny UCI test double for the Chess Review native host.
//
// It exists ONLY so scripts/native-host-smoke.mjs can exercise the real native-messaging framing,
// process lifecycle, UCI handshake, MultiPV handling, stop/cancel, engine-crash and silence-timeout
// paths on a machine that does not have a genuine Stockfish 19 executable installed. It is NOT a
// chess engine and is never shipped or registered — see native/README.md.
//
// Magic position tokens used by the smoke test (the FEN must stay valid, so they are encoded in the
// fullmove number the host forwards):
//   fullmove 9999 -> the process exits immediately mid-search (simulates an engine crash)
//   fullmove 9998 -> accepts "go" but never answers      (simulates a wedged engine)
//   fullmove 9997 -> answers "bestmove (none)"
//
// Build (the smoke script does this for you):
//   csc /target:exe /out:FakeEngine.exe native/test/FakeEngine.cs

using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text.RegularExpressions;
using System.Threading;

internal static class FakeEngine
{
    private static readonly object Gate = new object();
    private static string _position = "";
    private static int _multipv = 1;
    private static volatile bool _stop;
    private static volatile string _bestmove = "e2e4";

    private static void Out(string line)
    {
        lock (Gate)
        {
            Console.Out.Write(line);
            Console.Out.Write('\n');
            Console.Out.Flush();
        }
    }

    private static int Main()
    {
        // The smoke test watches this pid file to prove the engine is reaped: a graceful exit removes
        // it, a force-killed engine leaves a pid that no longer exists.
        string pidFile = null;
        try { pidFile = Path.Combine(Directory.GetCurrentDirectory(), "fake-engine-pid.txt"); } catch { }
        if (pidFile != null)
        {
            try { File.WriteAllText(pidFile, Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture)); } catch { }
        }
        int code;
        try { code = Run(); }
        finally { if (pidFile != null) { try { File.Delete(pidFile); } catch { } } }
        return code;
    }

    private static int Run()
    {
        string line;
        while ((line = Console.In.ReadLine()) != null)
        {
            if (line == "uci")
            {
                // The identity is overridable so the smoke test can prove that only a Stockfish 19
                // `id name` is reported as verified.
                string idName = Environment.GetEnvironmentVariable("CHESS_REVIEW_FAKE_ID_NAME");
                if (String.IsNullOrEmpty(idName)) idName = "Stockfish 19 (Chess Review test double)";
                Out("id name " + idName);
                Out("id author Chess Review tests");
                Out("option name Hash type spin default 16 min 1 max 4096");
                Out("option name Threads type spin default 1 min 1 max 64");
                Out("option name MultiPV type spin default 1 min 1 max 500");
                Out("option name Skill Level type spin default 20 min 0 max 20");
                Out("option name EvalFile type string default nn-test.nnue");
                Out("option name UCI_AnalyseMode type check default false");
                Out("uciok");
            }
            else if (line == "isready")
            {
                Out("readyok");
            }
            else if (line.StartsWith("setoption", StringComparison.Ordinal))
            {
                int nameAt = line.IndexOf(" name ", StringComparison.Ordinal);
                int valueAt = line.IndexOf(" value ", StringComparison.Ordinal);
                if (nameAt >= 0 && valueAt > nameAt)
                {
                    string name = line.Substring(nameAt + 6, valueAt - nameAt - 6).Trim();
                    string value = line.Substring(valueAt + 7).Trim();
                    if (name.Equals("MultiPV", StringComparison.OrdinalIgnoreCase))
                    {
                        int parsed;
                        if (Int32.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out parsed) && parsed > 0) _multipv = parsed;
                    }
                    Out("info string option " + name + "=" + value);
                }
            }
            else if (line.StartsWith("position ", StringComparison.Ordinal))
            {
                _position = line;
            }
            else if (line.StartsWith("go ", StringComparison.Ordinal))
            {
                StartSearch(line);
            }
            else if (line == "stop")
            {
                _stop = true;
            }
            else if (line == "quit")
            {
                return 0;
            }
        }
        return 0;
    }

    private static void StartSearch(string goLine)
    {
        // The smoke test encodes its crash/hang scenarios in the fullmove number (see header).
        if (Regex.IsMatch(_position, @"\s9999\s*$")) { Crash(); return; }
        if (Regex.IsMatch(_position, @"\s9998\s*$")) return;   // wedge: no reply at all
        _bestmove = Regex.IsMatch(_position, @"\s9997\s*$") ? "(none)" : "e2e4";

        int depth = 12;
        int depthAt = goLine.IndexOf(" depth ", StringComparison.Ordinal);
        if (depthAt >= 0)
        {
            int parsed;
            if (Int32.TryParse(goLine.Substring(depthAt + 7).Trim().Split(' ')[0], NumberStyles.Integer, CultureInfo.InvariantCulture, out parsed)) depth = parsed;
        }

        Thread worker = new Thread(delegate() { Search(depth); });
        worker.IsBackground = true;
        worker.Start();
    }

    private static void Crash()
    {
        Console.Error.WriteLine("fake engine simulating a crash");
        Environment.Exit(3);
    }

    private static void Search(int depth)
    {
        _stop = false;
        int baseCp = 30 + (_position.Length % 7);
        for (int d = 1; d <= depth; d++)
        {
            if (_stop) break;
            for (int m = 1; m <= _multipv; m++)
            {
                int cp = baseCp - (m - 1) * 13;
                Out(String.Format(CultureInfo.InvariantCulture,
                    "info depth {0} seldepth {1} multipv {2} score cp {3} pv {4}", d, d, m, cp, Pv(m)));
            }
            Thread.Sleep(25);
        }
        Out("bestmove " + _bestmove);
        _stop = false;
    }

    private static string Pv(int multipv)
    {
        string[] lines = { "e2e4 e7e5 g1f3", "d2d4 d7d5 c2c4", "g1f3 g8f6 c2c4", "c2c4 e7e5 g1f3" };
        return lines[(multipv - 1) % lines.Length];
    }
}