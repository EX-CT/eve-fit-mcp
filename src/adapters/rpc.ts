// Long-running JSONL RPC adapter (`<engine> serve-stdio`): {"id","method","params"} → {"id","result"}.
// The dataset is loaded once per worker process; requests are pipelined and matched by id.
// A pool of N workers spreads batches over several cores.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import {
  EngineError,
  engineErrorFrom,
  isContractError,
  type ContractError,
  type EngineAdapter,
  type EngineMeta,
  type FitRequest,
  type FitStats,
  type PricesLoadResult,
  withPricesFlag,
} from "./types.js";

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

export interface RpcOptions {
  argv: string[];
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/** One serve-stdio process. Restarted transparently if it exits. */
export class RpcWorker {
  private proc?: ChildProcessWithoutNullStreams;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private stderrTail = "";
  readonly timeoutMs: number;

  constructor(private opts: RpcOptions) {
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  /** true while the engine process is up */
  get running(): boolean {
    return !!this.proc && this.proc.exitCode === null && !this.proc.killed;
  }

  /** argv for the next (re)start (e.g. with `--prices FILE`); a running process keeps its argv */
  setArgv(argv: string[]): void {
    this.opts = { ...this.opts, argv };
  }

  get argv(): string[] {
    return this.opts.argv;
  }

  get inflight(): number {
    return this.pending.size;
  }

  private failAll(err: EngineError) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private start(): ChildProcessWithoutNullStreams {
    if (this.proc && this.proc.exitCode === null && !this.proc.killed) return this.proc;
    const [bin, ...args] = this.opts.argv;
    const p = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], env: this.opts.env ?? process.env });
    p.stderr.on("data", (d) => {
      this.stderrTail = (this.stderrTail + d.toString()).slice(-4000);
    });
    p.stdin.on("error", () => {}); // reported via exit/error
    const rl = createInterface({ input: p.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      let msg: { id?: number; result?: unknown; error?: unknown };
      try {
        msg = JSON.parse(line);
      } catch {
        return; // not a response line (some engines log banners to stdout)
      }
      const pend = typeof msg.id === "number" ? this.pending.get(msg.id) : undefined;
      if (!pend) return;
      this.pending.delete(msg.id!);
      clearTimeout(pend.timer);
      if (msg.error !== undefined) {
        const e = msg.error as any;
        pend.reject(engineErrorFrom(e));
      } else pend.resolve(msg.result);
    });
    p.on("exit", (code, sig) => {
      // a process replaced after close() must not fail the new process's requests
      if (this.proc && this.proc !== p) return;
      if (this.proc === p) this.proc = undefined;
      this.failAll(
        new EngineError("ENGINE_EXIT", `engine exited (${code ?? sig}): ${this.stderrTail.trim().slice(-800)}`),
      );
    });
    p.on("error", (e) => {
      if (this.proc === p) this.proc = undefined;
      this.failAll(new EngineError("ENGINE_SPAWN", `cannot start ${bin}: ${e.message}`));
    });
    this.proc = p;
    return p;
  }

  /** Raw RPC call. The result may itself be a contract error object (`{"error":…}`); callers decide. */
  call<T = unknown>(method: string, params: unknown): Promise<T> {
    const p = this.start();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new EngineError("TIMEOUT", `${method} timed out after ${this.timeoutMs} ms`));
        // a hung engine would poison every later call: restart it
        this.proc?.kill();
      }, this.timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      p.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  close(): void {
    const p = this.proc;
    this.proc = undefined;
    if (p) {
      p.stdin.end();
      setTimeout(() => p.kill(), 200).unref();
    }
  }
}

function unwrap<T>(v: unknown): T {
  if (isContractError(v)) throw engineErrorFrom(v.error);
  return v as T;
}

export class RpcAdapter implements EngineAdapter {
  readonly kind = "rpc";
  private workers: RpcWorker[];

  constructor(opts: RpcOptions & { workers?: number }) {
    const n = Math.max(1, opts.workers ?? 1);
    this.workers = Array.from({ length: n }, () => new RpcWorker(opts));
  }

  private pick(): RpcWorker {
    let best = this.workers[0];
    for (const w of this.workers) if (w.inflight < best.inflight) best = w;
    return best;
  }

  async calc(req: FitRequest): Promise<FitStats> {
    return unwrap<FitStats>(await this.pick().call("calc", req));
  }

  async batch(reqs: FitRequest[]): Promise<(FitStats | ContractError)[]> {
    return Promise.all(
      reqs.map((r, i) =>
        this.workers[i % this.workers.length].call<FitStats>("calc", r).catch(
          (e: any): ContractError => ({ error: { ...(e?.details ?? {}), code: e?.code ?? "ENGINE_ERROR", message: String(e?.message ?? e), ...(e?.path ? { path: e.path } : {}) } }),
        ),
      ),
    );
  }

  async eftParse(text: string): Promise<FitRequest> {
    return unwrap<FitRequest>(await this.pick().call("eft_parse", { text }));
  }

  async eftExport(fit: FitRequest, name?: string): Promise<string> {
    const r = unwrap<unknown>(await this.pick().call("eft_export", name ? { fit, name } : { fit }));
    if (typeof r === "string") return r;
    if (r && typeof (r as any).text === "string") return (r as any).text;
    throw new EngineError("BAD_ENGINE_RESPONSE", "eft_export returned no text");
  }

  async meta(): Promise<EngineMeta> {
    return unwrap<EngineMeta>(await this.pick().call("meta", {}));
  }

  async call<T = unknown>(method: string, params: unknown): Promise<T> {
    return unwrap<T>(await this.pick().call(method, params));
  }

  private pricesPath: string | null = null;

  /** Injected price file for every worker: running ones load it now (RPC `prices_load`), restarts get `--prices FILE`.
   *  On an error (bad file) nothing changes: workers that had already loaded it go back to the previous file. */
  async setPrices(path: string | null): Promise<PricesLoadResult> {
    const prev = this.pricesPath;
    const params = (p: string | null) => (p ? { path: p } : { clear: true });
    const loaded: RpcWorker[] = [];
    let first: PricesLoadResult | null = null;
    try {
      for (const [i, w] of this.workers.entries()) {
        if (!w.running && i !== 0) continue; // stopped workers pick the file up from argv when they start
        const r = unwrap<PricesLoadResult>(await w.call("prices_load", params(path)));
        loaded.push(w);
        first ??= r;
      }
    } catch (e) {
      await Promise.all(loaded.map((w) => w.call("prices_load", params(prev)).catch(() => w.close())));
      throw e;
    }
    for (const w of this.workers) w.setArgv(withPricesFlag(w.argv, path));
    this.pricesPath = path;
    return first ?? { ok: true };
  }

  async close(): Promise<void> {
    for (const w of this.workers) w.close();
  }
}
