// Persistent client for `eve-dogma serve-stdio` (JSONL RPC). One process, dataset loaded once.
import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export interface EngineOptions {
  bin?: string;
  dataset?: string;
  timeoutMs?: number;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

export class EngineError extends Error {
  constructor(public code: string, message: string, public path?: string) {
    super(message);
  }
}

export class Engine {
  private proc?: ChildProcessWithoutNullStreams;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private stderrTail = "";
  readonly bin: string;
  readonly dataset?: string;
  readonly timeoutMs: number;

  constructor(opts: EngineOptions = {}) {
    this.bin = opts.bin ?? process.env.EVE_DOGMA_BIN ?? "eve-dogma";
    this.dataset = opts.dataset ?? process.env.EVE_DOGMA_DATASET;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  private start(): ChildProcessWithoutNullStreams {
    if (this.proc && this.proc.exitCode === null) return this.proc;
    const args = ["serve-stdio"];
    if (this.dataset) args.push("--dataset", this.dataset);
    const p = spawn(this.bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    p.stderr.on("data", (d) => {
      this.stderrTail = (this.stderrTail + d.toString()).slice(-2000);
    });
    const rl = createInterface({ input: p.stdout });
    rl.on("line", (line) => {
      let msg: { id?: number; result?: unknown; error?: unknown };
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      const pend = msg.id !== undefined ? this.pending.get(msg.id) : undefined;
      if (!pend) return;
      this.pending.delete(msg.id!);
      clearTimeout(pend.timer);
      const res = msg.result as { error?: { code: string; message: string; path?: string } } | undefined;
      const err = (msg.error ?? res?.error) as { code: string; message: string; path?: string } | undefined;
      if (err) pend.reject(new EngineError(err.code ?? "ENGINE_ERROR", err.message ?? String(err), err.path));
      else pend.resolve(msg.result);
    });
    p.on("exit", (code) => {
      for (const [, pend] of this.pending) {
        clearTimeout(pend.timer);
        pend.reject(new EngineError("ENGINE_EXIT", `eve-dogma exited (${code}): ${this.stderrTail.trim()}`));
      }
      this.pending.clear();
    });
    p.on("error", (e) => {
      for (const [, pend] of this.pending) {
        clearTimeout(pend.timer);
        pend.reject(new EngineError("ENGINE_SPAWN", `cannot start ${this.bin}: ${e.message}`));
      }
      this.pending.clear();
    });
    this.proc = p;
    return p;
  }

  call<T = unknown>(method: string, params: unknown): Promise<T> {
    const p = this.start();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new EngineError("TIMEOUT", `${method} timed out after ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      p.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  close(): void {
    this.proc?.stdin.end();
    this.proc?.kill();
  }
}
