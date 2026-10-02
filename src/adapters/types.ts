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
  ) {
    super(message);
    this.name = "EngineError";
  }
}

/** A contract-level `{"error":{code,message,path}}` object, as returned by calc for a bad request. */
export interface ContractError {
  error: { code: string; message: string; path?: string };
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
  close(): Promise<void>;
}
