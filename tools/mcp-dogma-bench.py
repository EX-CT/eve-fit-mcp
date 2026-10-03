#!/usr/bin/env python3
"""Replay eve-dogma-bench cases through the MCP server and score them with the bench tolerances.

Every case FitRequest is sent as-is to the MCP tool `compute_fit` ({fit: <case>, detail: "full"}) over stdio
(JSON-RPC, `node dist/main.js`), so the numbers pass through the MCP's request normalisation, adapter and
response path, not just the engine. The responses are scored like the bench does it:

  core     cases/*.json vs expected/*.json     (run.py `score`, tools/metrics.py tolerances)
  ext      ext/cases + ext/unit/cases           (ext/tools/score.py, with this script as its --batch-cmd)
  effects  effects/cases (one micro-fit per dogma effect, full attribute dump; effects/tools/score.py). The engine
           itself does not pass every case, so this suite must match the engine run directly (--engine-cmd):
           every case the engine passes must pass through the MCP too.
  cap      cap/cases of the bench cap-suite branch (--cap-bench checkout; cap/run_cap.py, CONTRACT-CAP tolerances)

usage:
  python3 tools/mcp-dogma-bench.py run --bench PATH [--cap-bench PATH] [--suite core,ext,effects,cap] [--out results.json]
                                       [--min-pass 1.0] [--engine-cmd "eve-fit batch"]
  python3 tools/mcp-dogma-bench.py batch          # JSONL FitRequests on stdin -> JSONL FitStats (score.py adapter)

The server gets the environment as is (EVE_DOGMA_BIN, EVE_DOGMA_DATASET, ...). Exit status is non-zero when any
suite passes fewer than --min-pass of its cases (default: all of them).
Ids: suite `mcp-bench` (case <name> of suite S = mcp-bench.S.<name>, e.g. mcp-bench.core.exct_rifter).
"""
import argparse, json, os, pathlib, subprocess, sys, time

ROOT = pathlib.Path(__file__).resolve().parents[1]
MAIN = ROOT / "dist" / "main.js"
META_KEYS = ("request_hash", "notes", "engine")


class Mcp:
    """Minimal MCP stdio client (newline-delimited JSON-RPC 2.0)."""

    def __init__(self, cmd=None):
        self.p = subprocess.Popen(cmd or ["node", str(MAIN)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.DEVNULL, text=True, bufsize=1, cwd=ROOT)
        self.n = 0
        r = self.rpc("initialize", {"protocolVersion": "2025-03-26", "capabilities": {},
                                    "clientInfo": {"name": "mcp-dogma-bench", "version": "1"}})
        self.server = r.get("serverInfo", {})
        self.send({"jsonrpc": "2.0", "method": "notifications/initialized"})

    def send(self, msg):
        self.p.stdin.write(json.dumps(msg) + "\n")
        self.p.stdin.flush()

    def rpc(self, method, params):
        self.n += 1
        self.send({"jsonrpc": "2.0", "id": self.n, "method": method, "params": params})
        while True:
            line = self.p.stdout.readline()
            if not line:
                raise SystemExit(f"MCP server exited during {method}")
            msg = json.loads(line)
            if msg.get("id") == self.n:
                if "error" in msg:
                    raise RuntimeError(f"{method}: {msg['error']}")
                return msg["result"]

    def compute_full(self, req):
        """compute_fit detail=full; returns the engine FitStats or {"error": {...}} like an engine would."""
        args = {"fit": req, "detail": "full"}
        if req.get("options"):
            args["options"] = req["options"]
        r = self.rpc("tools/call", {"name": "compute_fit", "arguments": args})
        if r.get("isError"):
            text = (r.get("content") or [{}])[0].get("text", "")
            return {"error": {"code": "MCP_ERROR", "message": text[:500]}}
        out = r.get("structuredContent") or json.loads(r["content"][-1]["text"])
        return {k: v for k, v in out.items() if k not in META_KEYS}

    def close(self):
        try:
            self.p.stdin.close()
            self.p.wait(timeout=10)
        except Exception:
            self.p.kill()


def cmd_batch(_a):
    m = Mcp()
    try:
        for line in sys.stdin:
            if line.strip():
                sys.stdout.write(json.dumps(m.compute_full(json.loads(line))) + "\n")
                sys.stdout.flush()
    finally:
        m.close()


def run_core(bench, out):
    sys.path.insert(0, str(bench))
    sys.path.insert(0, str(bench / "tools"))
    import run as bench_run  # noqa: E402  (bench run.py: load_cases / score)
    cases = bench_run.load_cases("cases/*.json")
    m = Mcp()
    res, t0 = {}, time.time()
    try:
        for name, text, exp in cases:
            resp = m.compute_full(json.loads(text))
            sc = bench_run.score(resp, exp)
            bad = [(k, g, w) for k, (ok, g, w) in sc.items() if not ok]
            res[name] = {"pass": not bad, "checks": len(sc), "mismatches": len(bad), "first": bad[:5],
                         "error": resp.get("error") if isinstance(resp, dict) else None}
    finally:
        m.close()
    npass = sum(r["pass"] for r in res.values())
    print(f"mcp-bench core: {npass}/{len(res)} cases pass ({sum(r['checks'] for r in res.values())} checks, {time.time() - t0:.1f}s)")
    fails = sorted(k for k, r in res.items() if not r["pass"])
    if fails:
        print("  failing: " + " ".join(fails))
        for k in fails[:10]:
            print(f"    {k}: {res[k]['error'] or res[k]['first']}")
    out["core"] = {"pass": npass, "total": len(res), "cases": res}
    return npass, len(res)


def run_ext(bench, out, tmp):
    score = bench / "ext" / "tools" / "score.py"
    me = f"{sys.executable} {pathlib.Path(__file__).resolve()} batch"
    rpath = tmp / "mcp-bench-ext.json"
    r = subprocess.run([sys.executable, str(score), "--batch-cmd", me, "--name", "mcp-bench", "--out", str(rpath)],
                       cwd=ROOT, text=True, capture_output=True)
    print(r.stdout.rstrip())
    if r.returncode != 0 or not rpath.exists():
        print(r.stderr[-2000:])
        out["ext"] = {"pass": 0, "total": 0, "error": r.stderr[-2000:]}
        return 0, 1
    d = json.loads(rpath.read_text())
    for k, c in d["cases"].items():
        if not c["pass"]:
            print(f"    {k}: {c['first'][:3]}")
    out["ext"] = d
    return d["pass"], d["total"]


def run_effects(bench, out, tmp, engine_cmd):
    score = bench / "effects" / "tools" / "score.py"
    me = f"{sys.executable} {pathlib.Path(__file__).resolve()} batch"
    res = {}
    for name, cmd in (("engine", engine_cmd), ("mcp-bench", me)):
        rpath = tmp / f"effects-{name}.json"
        r = subprocess.run([sys.executable, str(score), "--batch-cmd", cmd, "--name", name, "--out", str(rpath)], cwd=ROOT, text=True, capture_output=True)
        print("\n".join(l for l in r.stdout.splitlines()[:2]))
        if r.returncode != 0 or not rpath.exists():
            print(r.stderr[-2000:])
            out["effects"] = {"error": r.stderr[-2000:]}
            return 0, 1
        res[name] = json.loads(rpath.read_text())["cases"]
    eng = {k for k, c in res["engine"].items() if c["pass"]}
    mcp = {k for k, c in res["mcp-bench"].items() if c["pass"]}
    lost = sorted(eng - mcp)
    print(f"mcp-bench effects: {len(mcp)}/{len(res['mcp-bench'])} pass, engine direct {len(eng)}/{len(res['engine'])}; "
          f"lost through the MCP: {len(lost)}" + (f" ({' '.join(lost[:20])})" if lost else ""))
    out["effects"] = {"pass": len(mcp), "total": len(res["mcp-bench"]), "engine_pass": len(eng), "lost": lost,
                      "engine_failing": sorted(set(res["engine"]) - eng)}
    # parity: every engine pass must survive the MCP (score = MCP passes among engine passes)
    return len(eng & mcp), len(eng)


def run_cap(cap_bench, out):
    if cap_bench is None:
        raise SystemExit("--suite cap needs --cap-bench (checkout of the bench cap-suite branch, engines.lock DOGMA_BENCH_CAP_SHA)")
    me = f"{sys.executable} {pathlib.Path(__file__).resolve()} batch"
    r = subprocess.run([sys.executable, "cap/run_cap.py", "--batch-cmd", me, "--name", "mcp-bench"], cwd=cap_bench, text=True, capture_output=True)
    print("mcp-bench cap: " + (r.stdout.strip().splitlines() or [""])[-1])
    rpath = cap_bench / "cap" / "results" / "mcp-bench.json"
    if r.returncode != 0 or not rpath.exists():
        print(r.stderr[-2000:])
        out["cap"] = {"error": r.stderr[-2000:]}
        return 0, 1
    d = json.loads(rpath.read_text())
    out["cap"] = {k: d[k] for k in ("cases", "cases_ok", "per_metric", "per_category")} | {"failing": [x for x in d.get("rows", []) if not x.get("ok", True)][:20]}
    return d["cases_ok"], d["cases"]


def cmd_run(a):
    bench = pathlib.Path(a.bench).resolve()
    if not (bench / "run.py").exists():
        raise SystemExit(f"{bench}: not an eve-dogma-bench checkout")
    if not MAIN.exists():
        raise SystemExit("dist/main.js missing: npm run build first")
    out, ok = {"bench": str(bench)}, True
    tmp = pathlib.Path(os.environ.get("RUNNER_TEMP", "/tmp"))
    runners = {
        "core": run_core,
        "ext": lambda b, o: run_ext(b, o, tmp),
        "effects": lambda b, o: run_effects(b, o, tmp, a.engine_cmd),
        "cap": lambda b, o: run_cap(pathlib.Path(a.cap_bench).resolve() if a.cap_bench else None, o),
    }
    for suite in a.suite.split(","):
        p, t = runners[suite](bench, out)
        if t == 0 or p / t < a.min_pass:
            print(f"mcp-bench {suite}: {p}/{t} below --min-pass {a.min_pass}")
            ok = False
    if a.out:
        pathlib.Path(a.out).write_text(json.dumps(out, indent=1, default=str))
    sys.exit(0 if ok else 1)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--bench", required=True, help="eve-dogma-bench checkout (engines.lock DOGMA_BENCH_SHA)")
    r.add_argument("--cap-bench", help="bench checkout at the cap-suite branch (engines.lock DOGMA_BENCH_CAP_SHA)")
    r.add_argument("--suite", default="core,ext,effects,cap")
    r.add_argument("--engine-cmd", default=f"{os.environ.get('EVE_DOGMA_BIN', 'eve-fit')} batch",
                   help="the engine run directly, as the effects baseline (default: $EVE_DOGMA_BIN batch)")
    r.add_argument("--out")
    r.add_argument("--min-pass", type=float, default=1.0)
    sub.add_parser("batch")
    a = ap.parse_args()
    {"run": cmd_run, "batch": cmd_batch}[a.cmd](a)


if __name__ == "__main__":
    main()
