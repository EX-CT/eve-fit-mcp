// All configuration comes from the environment (MCP clients pass env in their server config).
import { existsSync } from "node:fs";
import { CachingAdapter } from "./adapters/cache.js";
import { CliAdapter } from "./adapters/cli.js";
import { HttpAdapter } from "./adapters/http.js";
import { expandCommand } from "./adapters/cmd.js";
import { RpcAdapter } from "./adapters/rpc.js";
import type { EngineAdapter } from "./adapters/types.js";

export interface Config {
  /** "rpc" (long-running serve-stdio, default), "cli" (spawn per call) or "http" (remote engine server). */
  adapter: "rpc" | "cli" | "http";
  engineUrl: string;
  bin: string;
  dataset: string;
  rpcCmd: string;
  calcCmd: string;
  batchCmd: string;
  workers: number;
  timeoutMs: number;
  /** Skill level applied when a fit gives no skills (engines default to 0, which surprises people). */
  defaultSkillLevel: number;
  maxBatch: number;
  cacheSize: number;
  httpHost: string;
  httpPort: number;
  allowedHosts: string[] | null;
}

export const ENV_DOC: Record<string, string> = {
  EVE_DOGMA_BIN: "engine binary (default: `eve-fit` on PATH = mainline engine F from EX-CT/eve-dogma, pinned in engines.lock; any contract engine works, e.g. the older `eve-dogma-f`, `eve-dogma` = eve-dogma-rs, or `eve-dogma-go`)",
  EVE_DOGMA_DATASET: "dataset-<build>.json.gz used by both the engine and the MCP search index (required)",
  EVE_FIT_ADAPTER: "`rpc` (default: long-running `serve-stdio` process), `cli` (spawn `calc`/`batch` per call) or `http` (remote engine server)",
  EVE_FIT_ENGINE_URL: "base URL of an HTTP engine for EVE_FIT_ADAPTER=http (POST /v1/calc, /v1/batch, /v1/rpc; GET /v1/meta)",
  EVE_FIT_RPC_CMD: "rpc command template (default `{bin} --dataset {dataset} serve-stdio`)",
  EVE_FIT_CALC_CMD: "cli calc template (default `{bin} --dataset {dataset} calc`)",
  EVE_FIT_BATCH_CMD: "cli batch template (default `{bin} --dataset {dataset} batch`)",
  EVE_FIT_WORKERS: "number of rpc engine processes (default 1; batches are spread over them)",
  EVE_FIT_TIMEOUT_MS: "per-call engine timeout (default 60000)",
  EVE_FIT_DEFAULT_SKILLS: "skill level for fits that give none (default 5, i.e. Pyfa 'All 5')",
  EVE_FIT_MAX_BATCH: "max candidate fits evaluated per helper call (default 400)",
  EVE_FIT_CACHE: "calc results kept in memory by exact request (default 2000; 0 disables)",
  EVE_FIT_PRICE_SOURCE: "price source for get_prices / price_fit: `esi` (default; CCP ESI /markets/prices/, universe average) or `fuzzwork` (trade-hub sell/buy percentile)",
  EVE_FIT_PRICE_SYSTEM: "trade hub for fuzzwork: jita (default), amarr, dodixie, rens, hek",
  EVE_FIT_PRICE_CACHE: "price cache directory (default $XDG_CACHE_HOME/eve-fit-mcp or ~/.cache/eve-fit-mcp; `off` = memory only)",
  EVE_FIT_PRICE_TTL_S: "price cache lifetime in seconds (default 3600; ESI uses its Expires header)",
  EVE_FIT_OFFLINE: "1 = never fetch prices; use the cache whatever its age (results say stale)",
  EVE_FIT_USER_AGENT: "User-Agent sent to ESI / Fuzzwork (default names this project; add your contact per ESI etiquette)",
  EVE_FIT_PRICES: "injected price file loaded into the engine at start (docs/23 file layer, like `eve-fit --prices FILE`): path or http(s) URL of an eve-price-snapshot v1 / {type_id: isk} map, or `latest` (newest EX-CT/eve-market-prices release; cached under EVE_FIT_PRICE_CACHE/snapshots). Tool load_prices changes it at run time",
  EVE_FIT_PRICES_REPO: "GitHub repo of the snapshot releases for `latest` (default EX-CT/eve-market-prices)",
  EVE_FIT_HTTP_HOST: "HTTP bind address for --http (default 127.0.0.1)",
  EVE_FIT_HTTP_PORT: "HTTP port for --http (default 8765)",
};

function int(v: string | undefined, d: number): number {
  const n = v === undefined || v === "" ? NaN : Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : d;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const adapter = (env.EVE_FIT_ADAPTER ?? "rpc").toLowerCase();
  if (adapter !== "rpc" && adapter !== "cli" && adapter !== "http") throw new Error(`EVE_FIT_ADAPTER must be rpc, cli or http, got ${adapter}`);
  return {
    adapter,
    engineUrl: env.EVE_FIT_ENGINE_URL || "",
    bin: env.EVE_DOGMA_BIN || "eve-fit",
    dataset: env.EVE_DOGMA_DATASET || "",
    rpcCmd: env.EVE_FIT_RPC_CMD || "{bin} --dataset {dataset} serve-stdio",
    calcCmd: env.EVE_FIT_CALC_CMD || "{bin} --dataset {dataset} calc",
    batchCmd: env.EVE_FIT_BATCH_CMD || "{bin} --dataset {dataset} batch",
    workers: Math.max(1, int(env.EVE_FIT_WORKERS, 1)),
    timeoutMs: Math.max(1000, int(env.EVE_FIT_TIMEOUT_MS, 60_000)),
    defaultSkillLevel: Math.min(5, Math.max(0, int(env.EVE_FIT_DEFAULT_SKILLS, 5))),
    maxBatch: Math.max(1, int(env.EVE_FIT_MAX_BATCH, 400)),
    cacheSize: Math.max(0, int(env.EVE_FIT_CACHE, 2000)),
    httpHost: env.EVE_FIT_HTTP_HOST || "127.0.0.1",
    httpPort: int(env.EVE_FIT_HTTP_PORT, 8765),
    allowedHosts: env.EVE_FIT_ALLOWED_HOSTS === "*" ? null : env.EVE_FIT_ALLOWED_HOSTS ? env.EVE_FIT_ALLOWED_HOSTS.split(",").map((x) => x.trim()).filter(Boolean) : [],
  };
}

export function checkConfig(cfg: Config): void {
  if (!cfg.dataset) throw new Error("EVE_DOGMA_DATASET is not set (path to dataset-<build>.json.gz)");
  if (!existsSync(cfg.dataset)) throw new Error(`EVE_DOGMA_DATASET does not exist: ${cfg.dataset}`);
}

export function createAdapter(cfg: Config): EngineAdapter {
  const a = createRawAdapter(cfg);
  return cfg.cacheSize > 0 ? new CachingAdapter(a, cfg.cacheSize) : a;
}

function createRawAdapter(cfg: Config): EngineAdapter {
  if (cfg.adapter === "http") {
    if (!cfg.engineUrl) throw new Error("EVE_FIT_ADAPTER=http needs EVE_FIT_ENGINE_URL");
    return new HttpAdapter({ baseUrl: cfg.engineUrl, timeoutMs: cfg.timeoutMs });
  }
  const vars = { bin: cfg.bin, dataset: cfg.dataset };
  if (cfg.adapter === "cli")
    return new CliAdapter({
      calcArgv: expandCommand(cfg.calcCmd, vars),
      batchArgv: expandCommand(cfg.batchCmd, vars),
      rpcArgv: expandCommand(cfg.rpcCmd, vars),
      timeoutMs: cfg.timeoutMs,
    });
  return new RpcAdapter({ argv: expandCommand(cfg.rpcCmd, vars), workers: cfg.workers, timeoutMs: cfg.timeoutMs });
}
