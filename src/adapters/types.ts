// Engine adapter contract: anything that implements the stateless eve-dogma contract
// (eve-dogma-rs docs/contract.md). Requests and results are plain JSON values.

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type FitRequest = { [k: string]: unknown };
export type FitStats = { [k: string]: any };

export interface EngineMeta {
  engine?: string;
  schema_version?: number;
  sde_build?: number;
  dataset_sha256?: string;
  [k: string]: unknown;
}

export class EngineError extends Error {
  constructor(
    public code: string,
    message: string,
    public path?: string,
    /** the engine's other error fields, passed through verbatim (e.g. BATCH_TOO_LARGE `count` / `limit`, SDE_LOAD_FAILED `reason`) */
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "EngineError";
  }
}

/** EngineError from a contract error object `{code, message, path?, ...}`: every other field is kept as `details`. */
export function engineErrorFrom(e: any, fallbackCode = "ENGINE_ERROR"): EngineError {
  if (!e || typeof e !== "object") return new EngineError(fallbackCode, String(e));
  const { code, message, path, ...rest } = e;
  return new EngineError(typeof code === "string" ? code : fallbackCode, typeof message === "string" ? message : JSON.stringify(e), typeof path === "string" ? path : undefined, Object.keys(rest).length ? rest : undefined);
}

/** A contract-level `{"error":{code,message,path}}` object, as returned by calc for a bad request. */
export interface ContractError {
  error: { code: string; message: string; path?: string; [k: string]: unknown };
}

export function isContractError(v: unknown): v is ContractError {
  return !!v && typeof v === "object" && "error" in (v as object) && typeof (v as any).error === "object";
}

export interface EngineAdapter {
  readonly kind: string;
  /** One FitRequest → FitStats. Contract errors are thrown as EngineError. */
  calc(req: FitRequest): Promise<FitStats>;
  /** Many requests, same order. A failing entry yields its ContractError in place (never throws for one bad fit). */
  batch(reqs: FitRequest[]): Promise<(FitStats | ContractError)[]>;
  /** EFT text → FitRequest (engine `eft_parse`). */
  eftParse(text: string): Promise<FitRequest>;
  /** FitRequest → EFT text (engine `eft_export`). */
  eftExport(fit: FitRequest, name?: string): Promise<string>;
  meta(): Promise<EngineMeta>;
  /** Any other serve-stdio / `POST /v1/rpc` method (e.g. `graph`, `graph_specs` per CONTRACT-GRAPHS 0.2). Contract
   *  errors (`{error:{code,message,path}}`, or an unknown method) are thrown as EngineError. */
  call<T = unknown>(method: string, params: unknown): Promise<T>;
  /** docs/22 / docs/23 injected price file (the engine's `--prices FILE` / RPC `prices_load` layer, provenance
   *  `price_source: file`): load the eve-price-snapshot v1 (or plain map) at `path` into the engine, or clear it with
   *  null. Returns the engine's `prices_load` answer (types, snapshot_time, price_snapshot_id, price_hash, warnings). */
  setPrices?(path: string | null): Promise<PricesLoadResult>;
  close(): Promise<void>;
}

export interface PricesLoadResult {
  ok?: boolean;
  types?: number;
  snapshot_time?: string | null;
  price_snapshot_id?: string | null;
  price_hash?: string | null;
  warnings?: string[];
  [k: string]: unknown;
}

/** argv with the engine's global `--prices FILE` flag right after the binary (global flags go before the subcommand). */
export function withPricesFlag(argv: string[], path: string | null): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--prices") {
      i++;
      continue;
    }
    out.push(argv[i]);
  }
  return path ? [out[0], "--prices", path, ...out.slice(1)] : out;
}
