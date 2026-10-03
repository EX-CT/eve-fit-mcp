// docs/23 price inputs: the MCP only resolves names to ids and places the fields on the FitRequest / BatchRequest.
// Layer resolution, multipliers, totals and the price block are the engine's (no pricing math here).
import type { Dataset } from "./dataset.js";
import { codedError } from "./dataset.js";
import { resolveGroup } from "./market.js";

export interface PriceInputs {
  price_overrides?: Record<string, unknown>[];
  prices?: Record<string, unknown>;
  price?: boolean;
}

/** type names -> type_id, market group paths -> market_group_id; everything else verbatim (the engine validates). */
export function resolvePriceOverrides(ds: Dataset, list: unknown, where = "price_overrides"): Record<string, unknown>[] {
  if (!Array.isArray(list)) throw codedError("BAD_PRICE_OVERRIDE", `${where}: expected a list`, where);
  return list.map((e: any, i: number) => {
    if (!e || typeof e !== "object") throw codedError("BAD_PRICE_OVERRIDE", `${where}[${i}]: expected an object`, `${where}[${i}]`);
    const o = { ...e };
    if (typeof o.type_id === "string") o.type_id = ds.resolve(o.type_id).id;
    if (typeof o.market_group_id === "string") o.market_group_id = resolveGroup(ds, o.market_group_id).id;
    return o;
  });
}

/** Put the price inputs on a FitRequest (or BatchRequest) object in place. */
export function applyPriceInputs(ds: Dataset, req: Record<string, any>, a: PriceInputs, where = ""): void {
  if (a.price_overrides !== undefined) req.price_overrides = resolvePriceOverrides(ds, a.price_overrides, `${where}price_overrides`);
  if (a.prices !== undefined) req.prices = a.prices;
  if (a.price !== undefined) req.options = { ...(req.options ?? {}), price: a.price };
}
