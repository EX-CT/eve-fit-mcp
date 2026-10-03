// MCP compute_batch (docs/23): BatchRequest in, the engine's BatchResponse out, unchanged. The MCP only makes the fit
// sources friendlier (names, EFT text, DNA, default skills via normalizeFit) and resolves names in price overrides
// and `swap_type` patch ops. Expansion, patches, deltas, filter / sort / top_n, the combination cap and prices are
// the engine's (eve-dogma RPC `batch`).
import { codedError } from "./dataset.js";
import { normalizeFit, type Ctx, type FitInput } from "./fit.js";
import { resolvePriceOverrides } from "./pricing-input.js";

/** A fit source in a batch: a FitRequest (names allowed), or {eft} / {dna} / {fit} with optional skills. */
export type BatchFitSource = Record<string, unknown> | string;

async function normSource(ctx: Ctx, src: unknown, skills: FitInput["skills"], where: string, notes: string[]) {
  let input: FitInput;
  if (typeof src === "string") input = /^\s*\[/.test(src) ? { eft: src, skills } : { dna: src, skills };
  else if (src && typeof src === "object" && ("eft" in src || "dna" in src || ("fit" in src && !("ship" in src))))
    input = { ...(src as FitInput), skills: (src as FitInput).skills ?? skills };
  else if (src && typeof src === "object") input = { fit: src as FitInput["fit"], skills };
  else throw codedError("BATCH_BAD_REQUEST", `${where}: expected a FitRequest, EFT text or DNA`, where);
  try {
    const n = await normalizeFit(ctx, input);
    notes.push(...n.notes.map((x) => `${where}: ${x}`));
    return n.request;
  } catch (e: any) {
    if (e && typeof e === "object" && !e.path) e.path = where;
    throw e;
  }
}

function resolvePatch(ctx: Ctx, patch: unknown, where: string) {
  if (!Array.isArray(patch)) return patch;
  return patch.map((op: any) => {
    if (op && op.op === "swap_type") {
      const o = { ...op };
      for (const k of ["from", "to"]) if (typeof o[k] === "string") o[k] = ctx.ds.resolve(o[k]).id;
      return o;
    }
    return op;
  });
}

function resolveEntryPrices(ctx: Ctx, e: any, where: string) {
  if (e?.price_overrides !== undefined) e.price_overrides = resolvePriceOverrides(ctx.ds, e.price_overrides, `${where}/price_overrides`);
}

/** Normalise a BatchRequest for the engine; returns the request and per-fit normalisation notes. */
export async function prepareBatch(ctx: Ctx, input: Record<string, any>, skills?: FitInput["skills"]): Promise<{ request: Record<string, any>; notes: string[] }> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw codedError("BATCH_BAD_REQUEST", "request: expected a BatchRequest object");
  const notes: string[] = [];
  const req: Record<string, any> = { batch_version: 1, ...input };
  if (Array.isArray(req.fits))
    req.fits = await Promise.all(
      req.fits.map(async (f: any, i: number) => {
        const w = `fits/${i}`;
        if (!f || typeof f !== "object" || f.fit === undefined) throw codedError("BATCH_BAD_REQUEST", `${w}: each entry needs \`fit\` (FitRequest, EFT text or DNA)`, w);
        let fit: unknown;
        try {
          fit = await normSource(ctx, f.fit, f.skills ?? skills, `${w}/fit`, notes);
        } catch (err: any) {
          // docs/23: one bad fit errors in place (the engine reports it at its index), it never rejects the batch.
          // The MCP could not normalise this source, so the engine gets it as given and answers for it.
          notes.push(`${w}/fit: ${err?.code ? err.code + ": " : ""}${err?.message ?? err}; passed to the engine unchanged (per-fit error in place)`);
          fit = f.fit;
        }
        const e = { ...f, fit };
        delete e.skills;
        resolveEntryPrices(ctx, e, w);
        return e;
      }),
    );
  if (req.base !== undefined) req.base = await normSource(ctx, req.base, skills, "base", notes);
  if (Array.isArray(req.variants))
    req.variants = req.variants.map((v: any, i: number) => {
      const e = { ...v, patch: resolvePatch(ctx, v?.patch, `variants/${i}`) };
      resolveEntryPrices(ctx, e, `variants/${i}`);
      return e;
    });
  if (Array.isArray(req.product?.axes))
    req.product = {
      ...req.product,
      axes: req.product.axes.map((ax: any, i: number) =>
        Array.isArray(ax?.options)
          ? {
              ...ax,
              options: ax.options.map((o: any, j: number) => {
                const e = { ...o, patch: resolvePatch(ctx, o?.patch, `product/axes/${i}/options/${j}`) };
                resolveEntryPrices(ctx, e, `product/axes/${i}/options/${j}`);
                return e;
              }),
            }
          : ax,
      ),
    };
  resolveEntryPrices(ctx, req, "");
  return { request: req, notes };
}

/** Compact markdown view of a BatchResponse (the JSON is returned in full alongside). */
export function batchTable(resp: any): string {
  const rows: any[] = resp?.results ?? [];
  const fields = [...new Set(rows.flatMap((r) => (r.stats && !r.error && Object.keys(r.stats).length <= 12 ? Object.keys(r.stats) : [])))].slice(0, 8);
  const fmt = (v: unknown) => (typeof v === "number" ? String(Math.round(v * 1000) / 1000) : v === null || v === undefined ? "–" : String(v));
  const head = `| # | id | label | ${fields.join(" | ")} |`;
  const lines = rows.map((r) => (r.error ? `| ${r.index} | ${r.id} | ${r.label ?? ""} | error ${r.error.code}: ${r.error.message} |` : `| ${r.index} | ${r.id} | ${r.label ?? ""} | ${fields.map((f) => fmt(r.stats?.[f]) + (r.delta && typeof r.delta[f] === "number" ? ` (${r.delta[f] >= 0 ? "+" : ""}${fmt(r.delta[f])})` : "")).join(" | ")} |`));
  const pv = resp?.provenance;
  const prov = pv ? [`provenance: sde_build ${pv.sde_build ?? "?"} (${pv.sde_hash ?? "?"}), price_source ${pv.price_source ?? "?"}${pv.snapshot_time ? `, snapshot ${pv.price_snapshot_id ?? ""} ${pv.snapshot_time}` : ""}`] : [];
  return [`batch (${resp?.form ?? "?"}): ${resp?.total ?? rows.length} expanded, ${resp?.errors ?? 0} errors, ${resp?.matched ?? rows.length} matched`, ...prov, "", head, `|${"---|".repeat(fields.length + 3)}`, ...lines].join("\n");
}
