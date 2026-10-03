// Remote engine over HTTP (docs 05-api-schema): POST /v1/calc, POST /v1/batch (JSONL), GET /v1/meta, and
// POST /v1/rpc ({id,method,params} → {id,result}, same methods as serve-stdio) for eft_parse / eft_export.
// Works with `eve-dogma-go serve-http` and any server that implements those routes.
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
} from "./types.js";

export interface HttpOptions {
  baseUrl: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

export class HttpAdapter implements EngineAdapter {
  readonly kind = "http";
  private base: string;
  private timeoutMs: number;

  constructor(private opts: HttpOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  private async req(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), init.timeoutMs ?? this.timeoutMs);
    try {
      return await fetch(this.base + path, { ...init, headers: { ...(this.opts.headers ?? {}), ...(init.headers ?? {}) }, signal: ctl.signal });
    } catch (e: any) {
      if (e?.name === "AbortError") throw new EngineError("TIMEOUT", `${path} timed out after ${init.timeoutMs ?? this.timeoutMs} ms`);
      throw new EngineError("ENGINE_UNREACHABLE", `cannot reach engine at ${this.base}: ${e?.cause?.message ?? e?.message ?? e}`);
    } finally {
      clearTimeout(t);
    }
  }

  private async json(r: Response, what: string): Promise<unknown> {
    const text = await r.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new EngineError("BAD_ENGINE_RESPONSE", `${what}: HTTP ${r.status}, non-JSON body: ${text.slice(0, 300)}`);
    }
  }

  async calc(req: FitRequest): Promise<FitStats> {
    const r = await this.req("/v1/calc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req) });
    const v = await this.json(r, "calc");
    if (isContractError(v)) throw engineErrorFrom(v.error);
    if (!r.ok) throw new EngineError("ENGINE_HTTP", `calc: HTTP ${r.status}`);
    return v as FitStats;
  }

  async batch(reqs: FitRequest[]): Promise<(FitStats | ContractError)[]> {
    if (!reqs.length) return [];
    const r = await this.req("/v1/batch", {
      method: "POST",
      headers: { "content-type": "application/x-ndjson" },
      body: reqs.map((x) => JSON.stringify(x)).join("\n") + "\n",
      timeoutMs: this.timeoutMs * Math.max(1, Math.ceil(reqs.length / 50)),
    });
    if (!r.ok) throw new EngineError("ENGINE_HTTP", `batch: HTTP ${r.status}`);
    const lines = (await r.text()).split("\n").filter((l) => l.trim());
    if (lines.length !== reqs.length) throw new EngineError("BAD_ENGINE_RESPONSE", `batch: ${reqs.length} requests but ${lines.length} result lines`);
    return lines.map((l) => JSON.parse(l));
  }

  private async rpc<T>(method: string, params: unknown): Promise<T> {
    const r = await this.req("/v1/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: 1, method, params }) });
    const v: any = await this.json(r, method);
    if (v?.error) throw engineErrorFrom(v.error);
    const res = v && "result" in v ? v.result : v;
    if (isContractError(res)) throw new EngineError(res.error.code, res.error.message, res.error.path);
    return res as T;
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

  async meta(): Promise<EngineMeta> {
    const r = await this.req("/v1/meta");
    if (r.ok) return (await this.json(r, "meta")) as EngineMeta;
    return this.rpc("meta", {});
  }

  call<T = unknown>(method: string, params: unknown): Promise<T> {
    return this.rpc<T>(method, params);
  }

  /** Injected price file on a remote engine: the file's JSON is sent (RPC `prices_load {snapshot}`); it is session /
   *  server state there. */
  async setPrices(path: string | null): Promise<PricesLoadResult> {
    if (!path) return this.rpc<PricesLoadResult>("prices_load", { clear: true });
    const { readFileSync } = await import("node:fs");
    const { gunzipSync } = await import("node:zlib");
    const raw = readFileSync(path);
    const json = JSON.parse((raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw).toString("utf8"));
    return this.rpc<PricesLoadResult>("prices_load", { snapshot: json });
  }

  async close(): Promise<void> {}
}
