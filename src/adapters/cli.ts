// One-shot CLI adapter: spawns the engine per call (`calc` / `batch`), nothing stays resident.
// eft_parse / eft_export / meta go through a short-lived `serve-stdio` process (one request, then EOF).
import { spawn } from "node:child_process";
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

export interface CliOptions {
  calcArgv: string[];
  batchArgv: string[];
  rpcArgv: string[];
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(argv: string[], input: string, timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const [bin, ...args] = argv;
    const p = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], env: env ?? process.env });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => {
      p.kill("SIGKILL");
      reject(new EngineError("TIMEOUT", `${bin} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    p.stdout.on("data", (d) => out.push(d));
    p.stderr.on("data", (d) => err.push(d));
    p.stdin.on("error", () => {});
    p.on("error", (e) => {
      clearTimeout(timer);
      reject(new EngineError("ENGINE_SPAWN", `cannot start ${bin}: ${e.message}`));
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() });
    });
    p.stdin.end(input);
  });
}

function parseJson(s: string, what: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    throw new EngineError("BAD_ENGINE_RESPONSE", `${what}: engine printed non-JSON output: ${s.slice(0, 300)}`);
  }
}

export class CliAdapter implements EngineAdapter {
  readonly kind = "cli";
  private timeoutMs: number;

  constructor(private opts: CliOptions) {
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  async calc(req: FitRequest): Promise<FitStats> {
    const r = await run(this.opts.calcArgv, JSON.stringify(req), this.timeoutMs, this.opts.env);
    if (r.code === 3) throw new EngineError("DATASET", `engine cannot load its dataset: ${r.stderr.trim().slice(-500)}`);
    const text = r.stdout.trim();
    if (!text) throw new EngineError("ENGINE_EXIT", `engine exited ${r.code} without output: ${r.stderr.trim().slice(-500)}`);
    const v = parseJson(text, "calc");
    if (isContractError(v)) throw engineErrorFrom(v.error);
    return v as FitStats;
  }

  async batch(reqs: FitRequest[]): Promise<(FitStats | ContractError)[]> {
    if (!reqs.length) return [];
    const input = reqs.map((r) => JSON.stringify(r)).join("\n") + "\n";
    const r = await run(this.opts.batchArgv, input, this.timeoutMs * Math.max(1, Math.ceil(reqs.length / 50)), this.opts.env);
    if (r.code === 3) throw new EngineError("DATASET", `engine cannot load its dataset: ${r.stderr.trim().slice(-500)}`);
    const lines = r.stdout.split("\n").filter((l) => l.trim());
    if (lines.length !== reqs.length)
      throw new EngineError("BAD_ENGINE_RESPONSE", `batch: ${reqs.length} requests but ${lines.length} result lines`);
    return lines.map((l) => parseJson(l, "batch") as FitStats | ContractError);
  }

  private async rpc<T>(method: string, params: unknown): Promise<T> {
    const r = await run(this.opts.rpcArgv, JSON.stringify({ id: 1, method, params }) + "\n", this.timeoutMs, this.opts.env);
    for (const line of r.stdout.split("\n")) {
      if (!line.trim()) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg?.id !== 1) continue;
      if (msg.error) throw engineErrorFrom(msg.error);
      if (isContractError(msg.result)) throw engineErrorFrom(msg.result.error);
      return msg.result as T;
    }
    throw new EngineError("BAD_ENGINE_RESPONSE", `${method}: no response (exit ${r.code}): ${r.stderr.trim().slice(-500)}`);
  }

  eftParse(text: string): Promise<FitRequest> {
    return this.rpc("eft_parse", { text });
  }

  async eftExport(fit: FitRequest, name?: string): Promise<string> {
    const r = await this.rpc<unknown>("eft_export", name ? { fit, name } : { fit });
    if (typeof r === "string") return r;
    if (r && typeof (r as any).text === "string") return (r as any).text;
    throw new EngineError("BAD_ENGINE_RESPONSE", "eft_export returned no text");
  }

  meta(): Promise<EngineMeta> {
    return this.rpc("meta", {});
  }

  call<T = unknown>(method: string, params: unknown): Promise<T> {
    return this.rpc<T>(method, params);
  }

  /** Injected price file: validated once through RPC `prices_load`, then `--prices FILE` on every later spawn. */
  async setPrices(path: string | null): Promise<PricesLoadResult> {
    const r = path ? await this.rpc<PricesLoadResult>("prices_load", { path }) : { ok: true, types: 0 };
    this.opts = { ...this.opts, calcArgv: withPricesFlag(this.opts.calcArgv, path), batchArgv: withPricesFlag(this.opts.batchArgv, path), rpcArgv: withPricesFlag(this.opts.rpcArgv, path) };
    return r;
  }

  async close(): Promise<void> {}
}
