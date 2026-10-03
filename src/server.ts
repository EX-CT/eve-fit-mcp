// MCP server: tools, resources and prompts for EVE fitting on top of any eve-dogma contract engine.
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isContractError, type FitRequest, type FitStats } from "./adapters/types.js";
import type { Dataset, Kind, Slot } from "./dataset.js";
import { JARGON, KINDS, SLOTS, codedError } from "./dataset.js";
import { exportDna, exportMultibuy } from "./dna.js";
import { normalizeFit, type Ctx, type FitInput } from "./fit.js";
import { applyChange, candidateModules, characterLevel, evalBatch, freeSlots, optimize, skillRequirements, suggest, toGoals } from "./helpers.js";
import { DEFAULT_COMPARE, goalScore, METRICS, metric, round, type Goal } from "./metrics.js";

const goalScoreSafe = (g: Goal[], s: FitStats, b: FitStats) => round(goalScore(g, s, b), 5) ?? 0;
import { DAMAGE_PROFILES, implantSets, SKILL_PRESETS, TARGET_PROFILES, targetProfile } from "./profiles.js";
import { describeGraphs, graphSpecs, pickAxes, sampleX, summarizeSeries, TARGET_GRAPHS } from "./graphs.js";
import { browseMarket, typeMarket, typeRow } from "./market.js";
import { fitItems, HUBS, PriceService, priceConfig, SOURCES } from "./prices.js";
import { resolvePriceFile, type ResolvedPriceFile } from "./price-file.js";
import type { PricesLoadResult } from "./adapters/types.js";
import { Change, Constraints, fitInputShape, FitInputObject, FitRequestLenient, GoalSpec, priceInputShape, z } from "./schemas.js";
import { applyPriceInputs } from "./pricing-input.js";
import { batchTable, prepareBatch } from "./batch.js";
import { markdownTable, pickSections, SECTIONS, summarize } from "./summary.js";

export const VERSION = "0.4.2";
const here = dirname(fileURLToPath(import.meta.url));

function readAsset(rel: string): string {
  for (const base of [join(here, ".."), join(here, "..", "..")]) {
    try {
      return readFileSync(join(base, rel), "utf8");
    } catch {}
  }
  return "{}";
}

type ToolResult = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean; _meta?: Record<string, unknown> };

function ok(data: unknown, text?: string): ToolResult {
  const json = JSON.stringify(data);
  const content: ToolResult["content"] = [];
  if (text) content.push({ type: "text", text });
  content.push({ type: "text", text: json });
  return { content, structuredContent: data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : { result: data } };
}

function fail(e: unknown): ToolResult {
  const err: any = e;
  // engine errors keep their contract code verbatim; the MCP's own input errors are BAD_REQUEST (contract codes only)
  const c = err?.code && typeof err.code === "string" && /^[A-Z][A-Z0-9_]+$/.test(err.code) ? err.code : "BAD_REQUEST";
  const path = err?.path ? ` (at ${err.path})` : "";
  const details: Record<string, unknown> | undefined = err?.details && typeof err.details === "object" ? err.details : undefined;
  const extra = details ? ` ${JSON.stringify(details)}` : "";
  // the structured form is the engine's error object (code, message, path and its other fields such as count / limit)
  const error = { ...(details ?? {}), code: c, message: String(err?.message ?? e), ...(err?.path ? { path: err.path } : {}) };
  return { content: [{ type: "text", text: `Error: ${c}: ${err?.message ?? String(e)}${path}${extra}` }], structuredContent: { error }, isError: true };
}

function wrap<A>(fn: (a: A, extra?: any) => Promise<ToolResult>) {
  return async (a: A, extra?: any) => {
    try {
      return await fn(a, extra);
    } catch (e) {
      return fail(e);
    }
  };
}

function names(ds: Dataset, req: any) {
  const n = (id?: number | null) => (id ? ds.type(id)?.name ?? String(id) : null);
  return {
    ship: n(req.ship?.type_id),
    modules: (req.modules ?? []).map((m: any, i: number) => ({ index: i, name: n(m.type_id), slot: m.slot ?? ds.type(m.type_id)?.slot ?? null, state: m.state ?? "online", charge: n(m.charge_type_id) })),
    drones: (req.drones ?? []).map((d: any) => `${n(d.type_id)} x${d.quantity ?? 1}${d.active !== undefined && d.active !== d.quantity ? ` (${d.active} active)` : ""}`),
    fighters: (req.fighters ?? []).map((d: any) => `${n(d.type_id)} x${d.quantity ?? 1}`),
    implants: (req.implants ?? []).map((i: any) => n(i)),
    boosters: (req.boosters ?? []).map((b: any) => n(b.type_id)),
    skills: req.character?.skills,
  };
}

export interface ServerDeps extends Ctx {
  engineMetaNote?: string;
  /** market prices (default: from the environment, see prices.ts) */
  prices?: PriceService;
  /** injected price file currently loaded into the engine (load_prices / EVE_FIT_PRICES); shared by all sessions */
  priceFile?: LoadedPriceFile | null;
}

export interface LoadedPriceFile extends ResolvedPriceFile {
  /** the engine's prices_load answer */
  engine: PricesLoadResult;
  loaded_at: string;
}

/** Load (spec) or clear (null) the engine's injected price file (docs/23 §5.3 file layer). Used by load_prices and at
 *  startup for EVE_FIT_PRICES. */
export async function loadPriceFile(ctx: ServerDeps, spec: string | null, env: NodeJS.ProcessEnv = process.env): Promise<LoadedPriceFile | null> {
  if (!ctx.engine.setPrices) throw codedError("UNSUPPORTED", `the ${ctx.engine.kind} engine adapter cannot load price files`);
  if (spec === null) {
    await ctx.engine.setPrices(null);
    ctx.priceFile = null;
    return null;
  }
  const pc = priceConfig(env);
  const f = await resolvePriceFile(spec, { cacheDir: pc.cacheDir, offline: pc.offline, userAgent: pc.userAgent, repo: env.EVE_FIT_PRICES_REPO, apiBase: env.EVE_FIT_GITHUB_API });
  const engine = await ctx.engine.setPrices(f.path);
  ctx.priceFile = { ...f, engine, loaded_at: new Date().toISOString() };
  return ctx.priceFile;
}

export function createServer(ctx: ServerDeps): McpServer {
  const { ds } = ctx;
  const server = new McpServer(
    { name: "eve-fit-mcp", version: VERSION },
    {
      capabilities: { tools: {}, resources: {}, prompts: {}, logging: {} },
      instructions:
        "EVE Online fitting tools backed by a deterministic dogma engine (Pyfa-parity numbers). Typical flow: search_types / browse_market → compute_fit (EFT text, DNA or FitRequest JSON; names accepted) → compare_fits / what_if → suggest_modules / optimize_fit; compute_graph (list_graphs) for Pyfa graphs; price_fit / get_prices for market prices. Every tool is stateless: pass the whole fit each time. Skills default to all V unless `skills` is given. Read eve://guide/fitting for the workflow and eve://schema/fit-request for the request format.",
    },
  );

  const norm = (a: FitInput) => normalizeFit(ctx, a);
  const prices = ctx.prices ?? new PriceService(priceConfig());
  const calc = (req: FitRequest) => ctx.engine.calc(req);

  // ---------------------------------------------------------------- catalogue
  server.registerTool(
    "search_types",
    {
      title: "Search items",
      description:
        "Find ships, modules, charges, drones, fighters, implants, boosters, subsystems or skills by name (English or Chinese, player jargon like 'mwd', 'lse', 'dc', 'scram'). Filters: kind, slot, group, meta level, tech level, and fits_ship (only modules that can be fitted to that hull).",
      inputSchema: {
        query: z.string().describe("name fragment; empty string lists everything that matches the filters"),
        kinds: z.array(z.enum(KINDS as [Kind, ...Kind[]])).optional(),
        slot: z.enum(SLOTS as [Slot, ...Slot[]]).optional(),
        group: z.string().optional().describe("group name fragment, e.g. 'Shield Extender'"),
        meta_min: z.number().optional(),
        meta_max: z.number().optional(),
        tech_level: z.number().int().optional(),
        fits_ship: z.union([z.number().int(), z.string()]).optional().describe("ship id or name"),
        include_unpublished: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).optional().describe("default 20"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    wrap(async (a) => {
      const fits = a.fits_ship !== undefined ? ds.resolve(a.fits_ship, ["ship", "structure"]) : undefined;
      const hits = ds.search(a.query, {
        kinds: a.kinds,
        slot: a.slot,
        group: a.group,
        metaMin: a.meta_min,
        metaMax: a.meta_max,
        techLevel: a.tech_level,
        fitsShip: fits?.id,
        includeUnpublished: a.include_unpublished,
        limit: a.limit,
      });
      const jargon = JARGON[a.query.trim().toLowerCase()];
      return ok({ count: hits.length, results: hits, ...(jargon ? { jargon: `${a.query} = ${jargon}` } : {}) });
    }),
  );

  server.registerTool(
    "get_type",
    {
      title: "Item details",
      description:
        "Show-info for one type: group/category, slot, meta/tech level, named attributes with units (base values, before skills/modules), effects, required skills (with prerequisites), compatible charges for weapons, and for ships the slot/hardpoint/resource layout.",
      inputSchema: {
        type: z.union([z.number().int(), z.string()]).describe("type id or name"),
        all_attributes: z.boolean().optional().describe("include unpublished/internal attributes (default false)"),
        charges_limit: z.number().int().min(0).max(500).optional().describe("default 40"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    wrap(async (a) => {
      const t = ds.resolve(a.type);
      const charges = ds.compatibleCharges(t, a.charges_limit ?? 40).map((c) => ({ type_id: c.id, name: c.name, group: c.group }));
      const tree = ds.skillTree(t);
      const variations = [...ds.types.values()]
        .filter((x) => x.groupId === t.groupId && x.published && x.id !== t.id)
        .sort((x, y) => x.metaLevel - y.metaLevel || x.id - y.id)
        .slice(0, 40)
        .map((x) => ({ type_id: x.id, name: x.name, meta_level: x.metaLevel, tech_level: x.techLevel }));
      return ok({
        ...ds.hit(t),
        published: t.published,
        mass: t.mass,
        volume: t.volume,
        capacity: t.capacity,
        radius: t.radius,
        meta_group_id: t.metaGroup,
        attributes: ds.namedAttrs(t, { publishedOnly: !a.all_attributes }),
        effects: t.effects.map(([id, d]) => ({ id, name: ds.effectNames.get(id) ?? String(id), default: d })),
        required_skills: ds.requiredSkills(t),
        all_required_skills: [...tree].map(([id, lvl]) => ({ skill_id: id, skill: ds.type(id)?.name ?? String(id), level: lvl })),
        ...(charges.length ? { charges } : {}),
        ...(t.kind === "ship" || t.kind === "structure" ? { layout: ds.shipLayout(t) } : {}),
        same_group: variations,
        ...(ds.marketGroups.size ? { market: typeMarket(ds, t) } : {}),
      });
    }),
  );

  server.registerTool(
    "get_ship",
    {
      title: "Ship layout",
      description:
        "Slots, hardpoints, rig size, CPU/powergrid/calibration, drone bay and bandwidth for a hull, its traits (role bonuses and bonuses per level of each hull skill, English + Chinese), plus the empty hull's computed stats with the given skills (default all V): what you have to work with before fitting.",
      inputSchema: {
        ship: z.union([z.number().int(), z.string()]),
        skills: fitInputShape.skills,
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    wrap(async (a) => {
      const t = ds.resolve(a.ship, ["ship", "structure"]);
      const n = await norm({ fit: { ship: t.id }, skills: a.skills });
      const s = await calc(n.request);
      const sum = summarize(ds, n.request, s);
      return ok({
        ship: { type_id: t.id, name: t.name, name_zh: t.nameZh, group: t.group },
        base_layout: ds.shipLayout(t),
        traits: ds.shipTraits(t),
        with_skills: {
          resources: (s as any).resources,
          defense: sum.defense,
          capacitor: sum.capacitor,
          navigation: sum.navigation,
          targeting: sum.targeting,
          drones: (s as any).drones,
        },
        required_skills: ds.requiredSkills(t),
        notes: n.notes,
      });
    }),
  );

  server.registerTool(
    "list_presets",
    {
      title: "Presets",
      description: "Built-in skill presets, pirate implant sets (from the dataset), incoming damage profiles (for EHP) and target profiles (for applied DPS), usable by name in every fit tool.",
      inputSchema: { kind: z.enum(["all", "skills", "implant_sets", "damage_profiles", "target_profiles", "metrics"]).optional() },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    wrap(async (a) => {
      const k = a.kind ?? "all";
      const out: Record<string, unknown> = {};
      if (k === "all" || k === "skills") out.skills = SKILL_PRESETS;
      if (k === "all" || k === "implant_sets") out.implant_sets = implantSets(ds).map((s) => (k === "all" ? { name: s.name, implants: s.implants.length } : s));
      if (k === "all" || k === "damage_profiles") out.damage_profiles = DAMAGE_PROFILES;
      if (k === "all" || k === "target_profiles") out.target_profiles = TARGET_PROFILES;
      if (k === "all" || k === "metrics") out.metrics = METRICS.map((m) => ({ key: m.key, label: m.label, unit: m.unit, better: m.better > 0 ? "higher" : m.better < 0 ? "lower" : "neutral" }));
      return ok(out);
    }),
  );

  // ---------------------------------------------------------------- import / export
  server.registerTool(
    "parse_fit",
    {
      title: "Import fit",
      description: "EFT text, ship DNA, or a lenient FitRequest (names instead of ids) → the strict contract FitRequest the engine takes, with every item named and a request_hash for caching/replay. No calculation.",
      inputSchema: fitInputShape,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    wrap(async (a) => {
      const n = await norm(a);
      return ok({ request: n.request, request_hash: n.hash, items: names(ds, n.request), notes: n.notes });
    }),
  );

  server.registerTool(
    "export_fit",
    {
      title: "Export fit",
      description: "Write a fit as EFT (Pyfa-exact, via the engine), ship DNA, multibuy shopping list, or contract JSON.",
      inputSchema: { ...fitInputShape, format: z.enum(["eft", "dna", "multibuy", "json"]).describe("output format"), name: z.string().optional().describe("fit name for EFT header") },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    wrap(async (a) => {
      const n = await norm(a);
      let text: string;
      if (a.format === "eft") text = await ctx.engine.eftExport(n.request, a.name);
      else if (a.format === "dna") text = exportDna(ds, n.request);
      else if (a.format === "multibuy") text = exportMultibuy(ds, n.request);
      else text = JSON.stringify(n.request, null, 2);
      return { content: [{ type: "text", text }], structuredContent: { format: a.format, text, request_hash: n.hash } };
    }),
  );

  // ---------------------------------------------------------------- calculation
  server.registerTool(
    "validate_fit",
    {
      title: "Validate fit",
      description: "Check a fit for fitting problems (CPU/powergrid/calibration overload, slots, hardpoints, rig size, ship restrictions, max-group limits, charges, skills) with module names and fix hints, plus resource usage.",
      inputSchema: fitInputShape,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    wrap(async (a) => {
      const n = await norm(a);
      n.request.options = { ...((n.request as any).options ?? {}), validate: true };
      const s = await calc(n.request);
      const sum = summarize(ds, n.request, s);
      const req = skillRequirements(ds, n.request);
      return ok({
        valid: sum.violations.length === 0,
        violations: sum.violations,
        fitting: sum.fitting,
        missing_skills: req.skills.filter((r) => r.missing).map((r) => `${r.skill} ${r.required} (have ${r.character})`),
        warnings: sum.warnings,
        notes: n.notes,
        request_hash: n.hash,
      });
    }),
  );

  server.registerTool(
    "compute_fit",
    {
      title: "Compute fit stats",
      description:
        "Full Pyfa-parity statistics for a fit: DPS/volley (per weapon, drones, fighters, applied vs a target profile), EHP/resists/tank, capacitor simulation, speed/align/signature/warp, targeting (incl. probe size), mining yield, outgoing remote repair / cap transfer (with spool range), bombs needed to kill the fit, overheat burnout per module, resources and validity (violations with fix hints; options.validate=false skips the checks). Illegal fits are still computed in full. Prices (docs/23, computed by the engine): price_overrides (by type / market group / group / category; fixed price incl. 0, or multiplier), prices.isk (injected) and price=true return the engine's `price` block (total, sections, per-item lines with source, missing). detail=summary (default) returns a compact view + named metrics; detail=full returns the engine output (optionally only `sections`).",
      inputSchema: {
        ...fitInputShape,
        detail: z.enum(["summary", "full"]).optional(),
        sections: z.array(z.enum(SECTIONS)).optional().describe("with detail=full: only these top-level sections"),
        include_request: z.boolean().optional().describe("echo the normalised FitRequest"),
        options: z.record(z.string(), z.any()).optional().describe("engine options merged into the request (factor_reload, default_spool, rah, validate, include_attributes, cap_sim…)"),
        ...priceInputShape,
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    wrap(async (a) => {
      const n = await norm(a);
      if (a.options) n.request.options = { ...((n.request as any).options ?? {}), ...a.options };
      // docs/23 prices: passed to the engine, which returns the `price` block (and `provenance`) itself
      applyPriceInputs(ds, n.request as Record<string, any>, a);
      const s = await calc(n.request);
      const body: Record<string, unknown> =
        a.detail === "full" ? (a.sections?.length ? pickSections(s, a.sections) : s) : summarize(ds, n.request, s);
      const mcp = { request_hash: n.hash, notes: n.notes, engine: (s as any).meta?.engine };
      if (a.detail === "full") {
        // detail=full is the engine's calc output unchanged (identical to a compute_batch result's stats, docs/23);
        // the MCP's own fields go to the result `_meta` (and the notes into a text line), never into the stats
        const out: Record<string, unknown> = a.include_request ? { ...body, request: n.request } : body;
        const r: ToolResult = ok(out, n.notes.length ? `notes: ${n.notes.join("; ")}` : undefined);
        r._meta = { "eve-fit-mcp": mcp };
        return r;
      }
      const out: Record<string, unknown> = { ...body, ...mcp };
      if (a.include_request) out.request = n.request;
      return ok(out);
    }),
  );

  server.registerTool(
    "compute_batch",
    {
      title: "Compute a batch of fits / variants",
      description:
        "Many fits in one engine call (docs/23 BatchRequest, passed through to the engine; the BatchResponse comes back unchanged). Forms: `fits` [{id,label,fit,price_overrides}] (independent fits), `base` + `variants` [{id,label,patch (RFC 6902 JSON Patch on the FitRequest, plus {op:'swap_type',from,to}),price_overrides}], or `base` + `product` {axes:[{name,options|sweep}]} / `sweep` {path,values|from,to,step} (capped by max_combinations, default 2000 -> BATCH_TOO_LARGE). Output control: fields (dotted paths, incl. price.total_isk), deltas (vs base or delta_ref), filter [{field,op,value,on}], sort_by [{field,order}], top_n. Prices (engine-computed): batch-wide and per-variant price_overrides, prices.isk; each result has its own price block. Fit sources may use names, EFT text or DNA (normalised like compute_fit; patch paths refer to the normalised FitRequest, see compute_fit include_request). Per-fit errors stay in place.",
      inputSchema: {
        request: z.record(z.string(), z.any()).describe("BatchRequest (docs/23 §2); batch_version defaults to 1"),
        skills: fitInputShape.skills.describe("default skills for every fit source without its own (default all_5)"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    wrap(async (a) => {
      const { request, notes } = await prepareBatch(ctx, a.request, a.skills);
      let resp: any;
      try {
        resp = await ctx.engine.call("batch", request);
      } catch (e: any) {
        if (e?.code === "UNKNOWN_METHOD" || /unknown method/i.test(String(e?.message)))
          throw Object.assign(new Error(`the engine has no \`batch\` method (docs/23); update eve-dogma (engine: ${(await ctx.engine.meta().catch(() => ({}) as any)).engine ?? "?"})`), { code: "UNKNOWN_METHOD" });
        throw e;
      }
      const out = notes.length ? { ...resp, notes } : resp;
      return ok(out, batchTable(resp));
    }),
  );

  const FitEntry = FitInputObject.extend({ label: z.string().optional() });

  server.registerTool(
    "compare_fits",
    {
      title: "Compare fits",
      description: "Compute several fits in one batch and return a metric × fit table with deltas vs the first fit (markdown + JSON). Shared skills/damage/target profiles apply to every fit unless a fit sets its own.",
      inputSchema: {
        fits: z.array(FitEntry).min(2).max(20),
        metrics: z.array(z.string()).optional().describe(`metric keys (list_presets kind=metrics); default ${DEFAULT_COMPARE.join(", ")}`),
        skills: fitInputShape.skills,
        damage_profile: fitInputShape.damage_profile,
        target_profile: fitInputShape.target_profile,
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    wrap(async (a) => {
      const ms = (a.metrics?.length ? a.metrics : DEFAULT_COMPARE).map(metric);
      const norms = await Promise.all(
        a.fits.map((f) => norm({ ...f, skills: f.skills ?? a.skills, damage_profile: f.damage_profile ?? a.damage_profile, target_profile: f.target_profile ?? a.target_profile })),
      );
      const res = await evalBatch(ctx, norms.map((n) => n.request));
      const labels = a.fits.map((f, i) => f.label ?? `${i + 1}: ${ds.type((norms[i].request as any).ship.type_id)?.name}`);
      const errors = res.map((r, i) => (isContractError(r) ? { fit: labels[i], ...r.error } : null)).filter(Boolean);
      const rows = ms.map((m) => {
        const vals = res.map((r) => (isContractError(r) ? null : round(m.get(r))));
        const base = vals[0];
        return { metric: m.key, label: m.label, unit: m.unit, better: m.better, values: vals, delta: vals.map((v) => (v !== null && base !== null ? round(v - base) : null)) };
      });
      const best = rows.map((r) => {
        if (!r.better) return null;
        let bi = -1;
        r.values.forEach((v, i) => {
          if (v !== null && (bi < 0 || (r.better > 0 ? v > r.values[bi]! : v < r.values[bi]!))) bi = i;
        });
        return bi >= 0 ? labels[bi] : null;
      });
      const table = markdownTable(
        ["metric", ...labels, ...labels.slice(1).map((l) => `Δ ${l}`), "best"],
        rows.map((r, i) => [`${r.label}${r.unit ? ` (${r.unit})` : ""}`, ...r.values, ...r.delta.slice(1).map((d) => (d === null ? null : d > 0 ? `+${round(d, 2)}` : String(round(d, 2)))), best[i]]),
      );
      return ok({ fits: labels, rows, best, table, errors, request_hashes: norms.map((n) => n.hash) }, table);
    }),
  );

  server.registerTool(
    "what_if",
    {
      title: "What-if scenarios",
      description:
        "Apply changes to a fit and see the stat deltas, all in one batch: add/remove/replace modules, change module state or ammo, skills, drones, implants, boosters, damage/target profile, engine options. Each scenario is a list of changes applied together; `changes` alone means one scenario per change.",
      inputSchema: {
        ...fitInputShape,
        changes: z.array(Change).optional().describe("each change is evaluated on its own"),
        scenarios: z.array(z.object({ label: z.string().optional(), changes: z.array(Change).min(1) })).optional(),
        metrics: z.array(z.string()).optional(),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    wrap(async (a) => {
      const n = await norm(a);
      const scen = [...(a.scenarios ?? []), ...(a.changes ?? []).map((c) => ({ label: undefined, changes: [c] }))];
      if (!scen.length) throw new Error("give `changes` or `scenarios`");
      const reqs: FitRequest[] = [n.request];
      const labels: string[] = ["base"];
      for (const s of scen) {
        let r = n.request;
        for (const c of s.changes) r = applyChange(ctx, r, c);
        reqs.push(r);
        labels.push(s.label ?? s.changes.map((c: any) => `${c.op}${c.index !== undefined ? ` #${c.index}` : ""}${c.module ? ` ${typeof c.module === "object" ? c.module.name ?? c.module.type_id : c.module}` : ""}${c.charge !== undefined ? ` ${c.charge}` : ""}${c.state ? ` ${c.state}` : ""}${c.skill ? ` ${c.skill} ${c.level}` : ""}${c.type ? ` ${c.type}` : ""}`).join("; "));
      }
      const res = await evalBatch(ctx, reqs);
      if (isContractError(res[0])) throw new Error(`base fit: ${res[0].error.message}`);
      const base = res[0] as FitStats;
      const ms = (a.metrics?.length ? a.metrics : DEFAULT_COMPARE).map(metric);
      const baseViol = new Set(((base as any).violations ?? []).map((v: any) => v.code));
      const results = res.slice(1).map((r, i) => {
        if (isContractError(r)) return { scenario: labels[i + 1], error: r.error };
        const deltas: Record<string, { value: number | null; delta: number | null }> = {};
        for (const m of ms) {
          const v = m.get(r);
          const b = m.get(base);
          deltas[m.key] = { value: round(v), delta: v !== null && b !== null ? round(v - b) : null };
        }
        const viol = ((r as any).violations ?? []).map((v: any) => v.code);
        return { scenario: labels[i + 1], metrics: deltas, new_violations: viol.filter((c: string) => !baseViol.has(c)), resolved_violations: [...baseViol].filter((c) => !viol.includes(c)) };
      });
      const table = markdownTable(
        ["metric", "base", ...labels.slice(1)],
        ms.map((m) => [m.label, round(m.get(base)), ...results.map((r: any) => (r.error ? "error" : r.metrics[m.key].delta === null ? null : `${r.metrics[m.key].delta >= 0 ? "+" : ""}${round(r.metrics[m.key].delta, 2)}`))]),
      );
      return ok({ base: Object.fromEntries(ms.map((m) => [m.key, round(m.get(base))])), results, table, notes: n.notes }, table);
    }),
  );

  // ---------------------------------------------------------------- AI helpers
  server.registerTool(
    "suggest_modules",
    {
      title: "Suggest modules",
      description:
        "Rank modules for one slot by a goal (e.g. dps, ehp, tank, speed, align, cap_stability, lock_range, or a weighted mix) by actually computing every candidate fit in a batch. Either fill a free slot (`slot`) or replace module `replace_index`. Candidates that add fitting violations are dropped unless constraints.allow_violations; constraints.min/max set hard limits on any metric.",
      inputSchema: {
        ...fitInputShape,
        goal: GoalSpec.describe("metric key or [{metric, weight}]"),
        slot: z.enum(SLOTS as [Slot, ...Slot[]]).optional().describe("slot to fill (default: the replaced module's slot)"),
        replace_index: z.number().int().optional().describe("module index to replace"),
        constraints: Constraints,
        top: z.number().int().min(1).max(50).optional().describe("default 10"),
        budget: z.number().int().min(1).max(2000).optional().describe("max candidate fits to compute"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    wrap(async (a) => {
      const n = await norm(a);
      const req: any = n.request;
      let slot = a.slot as Slot | undefined;
      if (a.replace_index !== undefined) {
        const m = req.modules[a.replace_index];
        if (!m) throw new Error(`replace_index ${a.replace_index} out of range (fit has ${req.modules.length} modules)`);
        slot ??= m.slot ?? ds.type(m.type_id)?.slot;
      }
      const baseStats = await calc(req);
      if (!slot) {
        const free = Object.keys(freeSlots(baseStats));
        if (free.length !== 1) throw new Error(`give slot or replace_index; free slots: ${free.join(", ") || "none"}`);
        slot = free[0] as Slot;
      }
      const goals = toGoals(a.goal as any);
      const r = await suggest(ctx, { base: req, baseStats, goals, slot, replaceIndex: a.replace_index, constraints: a.constraints, top: a.top ?? 10, budget: Math.min(a.budget ?? ctx.maxBatch, 2000) });
      const baseGoal = Object.fromEntries(goals.map((g) => [g.metric, round(metric(g.metric).get(baseStats))]));
      const table = markdownTable(
        ["#", "module", ...goals.map((g) => `Δ ${g.metric}`), "cpu left", "pg left"],
        r.ranked.map((x, i) => [i + 1, x.name, ...goals.map((g) => x.goal[g.metric]?.delta ?? null), x.fitting.cpu_free, x.fitting.power_free]),
      );
      return ok(
        {
          slot,
          replacing: a.replace_index !== undefined ? ds.type(req.modules[a.replace_index].type_id)?.name : null,
          base: baseGoal,
          suggestions: r.ranked,
          evaluated: r.evaluated,
          candidates: r.candidates,
          strategy: r.strategy,
          table,
          notes: n.notes,
        },
        table,
      );
    }),
  );

  server.registerTool(
    "suggest_charges",
    {
      title: "Suggest ammo",
      description:
        "For each weapon type in the fit (or only module `module_index`'s type), compute the fit with every compatible charge loaded in all of those weapons and rank the charges by a goal (default dps; try applied_dps with a target_profile, or weapon_range).",
      inputSchema: {
        ...fitInputShape,
        goal: GoalSpec.optional().describe("default dps"),
        module_index: z.number().int().optional(),
        top: z.number().int().min(1).max(50).optional().describe("default 8 per weapon type"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    wrap(async (a) => {
      const n = await norm(a);
      const req: any = n.request;
      const goals = toGoals((a.goal as any) ?? "dps");
      const types = new Map<number, number[]>();
      req.modules.forEach((m: any, i: number) => {
        if (a.module_index !== undefined && req.modules[a.module_index]?.type_id !== m.type_id) return;
        const t = ds.type(m.type_id);
        if (t && ds.compatibleCharges(t, 1).length) types.set(m.type_id, [...(types.get(m.type_id) ?? []), i]);
      });
      if (!types.size) throw new Error("no module in the fit takes charges" + (a.module_index !== undefined ? ` (module ${a.module_index})` : ""));
      const base = await calc(req);
      const out: any[] = [];
      let text = "";
      for (const [tid, idx] of types) {
        const charges = ds.compatibleCharges(ds.type(tid)!, 300);
        const reqs = charges.map((c) => {
          const r: any = JSON.parse(JSON.stringify(req));
          for (const i of idx) r.modules[i].charge_type_id = c.id;
          return r;
        });
        const res = await evalBatch(ctx, reqs);
        const ranked = res
          .map((s, k) => {
            if (isContractError(s)) return null;
            const goal = Object.fromEntries(goals.map((g) => [g.metric, round(metric(g.metric).get(s))]));
            return { charge_type_id: charges[k].id, charge: charges[k].name, score: goalScoreSafe(goals, s, base), goal, weapon_range: round(metric("weapon_range").get(s), 0), dps: round(metric("dps").get(s), 2) };
          })
          .filter(Boolean)
          .sort((x: any, y: any) => y.score - x.score)
          .slice(0, a.top ?? 8);
        const cur = req.modules[idx[0]].charge_type_id;
        out.push({ weapon: ds.type(tid)!.name, modules: idx, current: cur ? ds.type(cur)?.name ?? cur : null, candidates: charges.length, ranked });
        text += `**${ds.type(tid)!.name}** ×${idx.length}\n` + markdownTable(["charge", ...goals.map((g) => g.metric), "range m"], ranked.map((r: any) => [r.charge, ...goals.map((g) => r.goal[g.metric]), r.weapon_range])) + "\n\n";
      }
      return ok({ weapons: out, notes: n.notes }, text.trim());
    }),
  );

  server.registerTool(
    "suggest_drones",
    {
      title: "Suggest drones",
      description:
        "Rank single-type drone loadouts for the ship: for every published drone that fits the drone bandwidth and bay, fill the bay with it, launch as many as bandwidth and the Drones skill allow, compute the fit, and rank by a goal (default dps; try applied_dps with a target_profile). Drones the character cannot use (`skills`) are listed after usable ones, with the missing skills. Replaces the fit's current drones. Mixed flights are not searched; use what_if/compare_fits for those.",
      inputSchema: {
        ...fitInputShape,
        goal: GoalSpec.optional().describe("default dps"),
        group: z.string().optional().describe("only drone groups matching this (case-insensitive substring), e.g. 'Combat Drone', 'Logistic'"),
        max_active: z.number().int().min(1).max(5).optional().describe("cap on launched drones (default: Drones skill level, 5 with all-V)"),
        top: z.number().int().min(1).max(50).optional().describe("default 10"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    wrap(async (a) => {
      const n = await norm(a);
      const req: any = n.request;
      const goals = toGoals((a.goal as any) ?? "dps");
      const ship = ds.type(req.ship.type_id)!;
      const bw = ds.attr(ship, "droneBandwidth") ?? 0;
      const bay = ds.attr(ship, "droneCapacity") ?? 0;
      if (bay <= 0 || bw <= 0) throw new Error(`${ship.name} has no drone bay or no drone bandwidth`);
      const skillCap = characterLevel(req, 3436); // Drones: +1 active drone per level
      const maxActive = Math.min(a.max_active ?? 5, skillCap);
      if (maxActive <= 0) throw new Error("the character cannot launch drones (Drones skill 0)");
      const g = a.group?.toLowerCase();
      const loadouts: { t: any; quantity: number; active: number }[] = [];
      for (const t of ds.types.values()) {
        if (t.kind !== "drone" || !t.published || (g && !t.group.toLowerCase().includes(g))) continue;
        const use = ds.attr(t, "droneBandwidthUsed") ?? 0;
        const vol = t.volume || 0;
        if (vol <= 0 || vol > bay) continue;
        const active = Math.min(maxActive, use > 0 ? Math.floor(bw / use + 1e-9) : maxActive);
        if (active <= 0) continue;
        loadouts.push({ t, quantity: Math.floor(bay / vol + 1e-9), active: Math.min(active, Math.floor(bay / vol + 1e-9)) });
      }
      if (!loadouts.length) throw new Error("no drone fits this ship" + (g ? ` in groups matching '${a.group}'` : ""));
      const noDrones: any = { ...JSON.parse(JSON.stringify(req)), drones: [] };
      const base = await calc(noDrones);
      const reqs = loadouts.map((l) => ({ ...JSON.parse(JSON.stringify(noDrones)), drones: [{ type_id: l.t.id, quantity: l.quantity, active: l.active }] }));
      const res = await evalBatch(ctx, reqs);
      const ranked = res
        .map((s, k) => {
          if (isContractError(s)) return null;
          const l = loadouts[k];
          const goal = Object.fromEntries(goals.map((x) => [x.metric, round(metric(x.metric).get(s))]));
          const missing = [...ds.skillTree(l.t)].filter(([sid, lvl]) => characterLevel(req, sid) < lvl).map(([sid, lvl]) => `${ds.type(sid)?.name ?? sid} ${lvl}`);
          return { drone_type_id: l.t.id, drone: l.t.name, group: l.t.group, quantity: l.quantity, active: l.active, score: goalScoreSafe(goals, s, base), goal, violations: s.violations?.length ?? 0, missing_skills: missing };
        })
        .filter(Boolean)
        .sort((x: any, y: any) => Number(x.missing_skills.length > 0) - Number(y.missing_skills.length > 0) || y.score - x.score || x.violations - y.violations)
        .slice(0, a.top ?? 10);
      const current = (req.drones ?? []).map((d: any) => ({ drone: ds.type(d.type_id)?.name ?? d.type_id, quantity: d.quantity, active: d.active }));
      const text =
        `**${ship.name}**: bandwidth ${bw} Mbit/s, bay ${bay} m³, up to ${maxActive} active\n` +
        markdownTable(["drone", "launched", "in bay", ...goals.map((x) => x.metric), "missing skills"], ranked.map((r: any) => [r.drone, r.active, r.quantity, ...goals.map((x) => r.goal[x.metric]), r.missing_skills.join(", ") || "–"]));
      return ok({ ship: ship.name, drone_bandwidth: bw, drone_bay_m3: bay, max_active: maxActive, current, candidates: loadouts.length, ranked, notes: n.notes }, text);
    }),
  );

  server.registerTool(
    "sweep",
    {
      title: "Parameter sweep (graph data)",
      description:
        "Series data for graphs: vary one parameter and compute metrics at each point in one batch. x = target_signature (m), target_velocity (m/s), skill_level (all skills 0–5), or distance (m; for projected effects in the fit). Default y: applied_dps for target sweeps, dps/ehp/speed for skills.",
      inputSchema: {
        ...fitInputShape,
        x: z.enum(["target_signature", "target_velocity", "skill_level", "distance"]),
        values: z.array(z.number()).max(100).optional().describe("x values; or use from/to/steps"),
        from: z.number().optional(),
        to: z.number().optional(),
        steps: z.number().int().min(2).max(100).optional(),
        y: z.array(z.string()).optional().describe("metric keys"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    wrap(async (a) => {
      const n = await norm(a);
      const req: any = n.request;
      let xs = a.values;
      if (!xs?.length) {
        const def: Record<string, [number, number, number]> = { target_signature: [25, 500, 20], target_velocity: [0, 3000, 16], skill_level: [0, 5, 6], distance: [0, 60000, 13] };
        const [f0, t0, s0] = def[a.x];
        const [f, t, st] = [a.from ?? f0, a.to ?? t0, a.steps ?? s0];
        xs = Array.from({ length: st }, (_, k) => round(f + ((t - f) * k) / (st - 1), 3)!);
      }
      const ys = (a.y?.length ? a.y : a.x === "skill_level" ? ["dps", "ehp", "speed", "cap_stability"] : a.x === "distance" ? ["speed", "dps", "cap_stability"] : ["applied_dps"]).map(metric);
      if (a.x === "distance" && !(req.projected ?? []).length) throw new Error("distance sweeps move the fit's projected[] sources; the fit has none");
      const tp = req.target_profile ?? { em: 0, thermal: 0, kinetic: 0, explosive: 0, signature_radius: 125, max_velocity: 0, radius: null };
      const reqs = xs.map((x) => {
        const r: any = JSON.parse(JSON.stringify(req));
        if (a.x === "target_signature") r.target_profile = { ...tp, signature_radius: x };
        else if (a.x === "target_velocity") r.target_profile = { ...tp, max_velocity: x };
        else if (a.x === "skill_level") r.character = { ...(r.character ?? {}), skills: { default_level: Math.round(x), levels: {} } };
        else r.projected = r.projected.map((p: any) => ({ ...p, distance_m: x }));
        return r;
      });
      const res = await evalBatch(ctx, reqs);
      const series = ys.map((m) => ({ metric: m.key, label: m.label, unit: m.unit, points: xs!.map((x, k) => [x, isContractError(res[k]) ? null : round(m.get(res[k] as FitStats))]) }));
      const text = markdownTable([a.x, ...ys.map((m) => m.key)], xs.map((x, k) => [x, ...series.map((s) => s.points[k][1] as number | null)]));
      return ok({ x: a.x, series, notes: n.notes }, text);
    }),
  );

  server.registerTool(
    "optimize_fit",
    {
      title: "Optimise fit",
      description:
        "Greedy local search towards a goal: fills free slots with the best module, then repeatedly applies the single best module swap, until no move improves the goal or the evaluation budget runs out. Returns the improved fit (EFT + request), stat changes and the step trace. Respects constraints like suggest_modules; `lock` keeps module indices unchanged.",
      inputSchema: {
        ...fitInputShape,
        goal: GoalSpec,
        constraints: Constraints,
        slots: z.array(z.enum(SLOTS as [Slot, ...Slot[]])).optional().describe("only touch these slot types"),
        lock: z.array(z.number().int()).optional().describe("module indices to keep"),
        budget: z.number().int().min(10).max(5000).optional().describe("max fits to compute (default 4× EVE_FIT_MAX_BATCH, capped at 1600)"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    wrap(async (a, extra) => {
      const n = await norm(a);
      const goals = toGoals(a.goal as any);
      const budget = a.budget ?? Math.min(ctx.maxBatch * 4, 1600);
      const token = extra?._meta?.progressToken;
      const onProgress =
        token !== undefined && extra?.sendNotification
          ? (evaluated: number, message: string) =>
              extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: Math.min(evaluated, budget), total: budget, message } }).catch(() => {})
          : undefined;
      const r = await optimize(ctx, n.request, goals, a.constraints, budget, a.slots as Slot[] | undefined, a.lock ?? [], onProgress);
      let eft: string | null = null;
      try {
        eft = await ctx.engine.eftExport(r.request, "optimized");
      } catch {}
      const ms = [...new Set([...goals.map((g) => g.metric), ...DEFAULT_COMPARE])].map(metric);
      const rows = ms.map((m) => ({ metric: m.key, before: round(m.get(r.firstStats)), after: round(m.get(r.stats)) }));
      const table = markdownTable(["metric", "before", "after"], rows.map((x) => [x.metric, x.before, x.after]));
      return ok({ improved: r.trace.length > 0, steps: r.trace, evaluated: r.evaluated, comparison: rows, eft, request: r.request, table, notes: n.notes }, table);
    }),
  );

  server.registerTool(
    "skill_requirements",
    {
      title: "Skill requirements",
      description: "Every skill (with prerequisites) the fit's ship, modules, charges, drones, fighters, implants and boosters need, and which the given character lacks (character = `skills`, default all V).",
      inputSchema: fitInputShape,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    wrap(async (a) => {
      const n = await norm(a);
      return ok({ ...skillRequirements(ds, n.request), notes: n.notes });
    }),
  );

  server.registerTool(
    "evaluate_profiles",
    {
      title: "Profiles sweep",
      description: "Applied DPS against each target profile and EHP against each incoming damage profile, in one batch: how the fit performs against frigates vs battleships, or against Guristas vs Blood Raiders.",
      inputSchema: {
        ...fitInputShape,
        target_profiles: z.array(z.string()).optional().describe("default: all built-in target profiles"),
        damage_profiles: z.array(z.string()).optional().describe("default: all built-in damage profiles"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    wrap(async (a) => {
      const n = await norm(a);
      const tps = a.target_profiles ?? TARGET_PROFILES.map((p) => p.name);
      const dps = a.damage_profiles ?? DAMAGE_PROFILES.map((p) => p.name);
      const reqs = [
        ...tps.map((p) => applyChange(ctx, n.request, { op: "set_target_profile", profile: p })),
        ...dps.map((p) => applyChange(ctx, n.request, { op: "set_damage_profile", profile: p })),
      ];
      const res = await evalBatch(ctx, reqs);
      const val = (r: any, f: (s: FitStats) => number | null) => (isContractError(r) ? null : round(f(r), 1));
      const applied = tps.map((p, i) => ({ profile: p, applied_dps: val(res[i], metric("applied_dps").get), raw_dps: val(res[i], metric("dps").get) }));
      const ehp = dps.map((p, i) => ({ profile: p, ehp: val(res[tps.length + i], metric("ehp").get), tank_ehp_s: val(res[tps.length + i], metric("tank").get) }));
      const text =
        markdownTable(["target", "applied DPS", "raw DPS"], applied.map((x) => [x.profile, x.applied_dps, x.raw_dps])) +
        "\n\n" +
        markdownTable(["incoming damage", "EHP", "tank EHP/s"], ehp.map((x) => [x.profile, x.ehp, x.tank_ehp_s]));
      return ok({ applied_dps: applied, ehp, notes: n.notes }, text);
    }),
  );

  server.registerTool(
    "engine_info",
    {
      title: "Engine info",
      description: "Which engine/adapter is in use, its dataset (SDE build, sha256) and whether the MCP's search index uses the same dataset.",
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    wrap(async () => {
      const m = await ctx.engine.meta();
      return ok({
        engine: m,
        adapter: ctx.engine.kind,
        mcp: { name: "eve-fit-mcp", version: VERSION },
        dataset: { path: ds.path, sha256: ds.sha256, json_sha256: ds.jsonSha256, sde_build: ds.sdeBuild, format: ds.format, types: ds.types.size, index_load_ms: Math.round(ds.loadMs) },
        dataset_match: ds.sameDataset(m.dataset_sha256 as string | undefined),
        default_skill_level: ctx.defaultSkillLevel,
      });
    }),
  );


  // ---------------------------------------------------------------- market browser
  server.registerTool(
    "browse_market",
    {
      title: "Market browser",
      description:
        "Pyfa's market tree: market groups (English/Chinese names) with item counts, the items of a group (meta group, meta level, tech level, slot), optionally only some meta groups (Pyfa's meta buttons: Tech I, Tech II, Faction, Storyline, Deadspace, Officer, Abyssal…). Without `group` it lists the root groups. Give `type` instead to get an item's market path and its variations (meta family: T1, T2, faction, deadspace, officer…) for meta swaps. Only fitting-relevant items are in the dataset; empty groups are hidden unless include_empty.",
      inputSchema: {
        group: z.union([z.number().int(), z.string()]).optional().describe("market group id, name, or path like 'Ship Equipment/Turrets & Launchers/Projectile Turrets'"),
        type: z.union([z.number().int(), z.string()]).optional().describe("an item (id or name): return its market path and variations instead"),
        depth: z.number().int().min(0).max(3).optional().describe("sub-group levels to expand (default 0: direct children only)"),
        meta_groups: z.array(z.union([z.string(), z.number().int()])).optional().describe("only items of these meta groups, e.g. ['Tech II','Faction']"),
        include_empty: z.boolean().optional(),
        limit: z.number().int().min(1).max(1000).optional().describe("max items listed (default 200)"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    wrap(async (a) => {
      if (a.type !== undefined) {
        const t = ds.resolve(a.type);
        if (!ds.marketGroups.size) throw new Error("this dataset has no market_groups (needs an eve-sde-pipeline release r4 or later)");
        return ok({ type: typeRow(ds, t), ...typeMarket(ds, t) });
      }
      return ok(browseMarket(ds, { group: a.group, depth: a.depth, meta_groups: a.meta_groups, include_empty: a.include_empty, limit: a.limit }));
    }),
  );

  // ---------------------------------------------------------------- graphs
  server.registerTool(
    "list_graphs",
    {
      title: "Graph catalogue",
      description:
        "The engine's graphs (Pyfa graph window: damage, application profile, capacitor, shield regen, mobility, warp time, lock time, EWAR, remote reps, ECM/burst) with x axes, y series, units and parameter defaults (engine graph_specs, CONTRACT-GRAPHS 0.2). Use with compute_graph.",
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    wrap(async () => {
      const specs = await graphSpecs(ctx.engine);
      return ok({ contract: specs.contract ?? null, graphs: describeGraphs(specs) });
    }),
  );

  const GraphTarget = z
    .object({
      profile: z.union([z.string(), z.record(z.string(), z.number().nullable())]).optional().describe("target profile preset name (list_presets) or {em,thermal,kinetic,explosive (resist 0..1), max_velocity, signature_radius, radius}"),
      fit: FitRequestLenient.optional().describe("target fit (FitRequest, names allowed)"),
      eft: z.string().optional().describe("target fit as EFT"),
      dna: z.string().optional().describe("target fit as DNA"),
      skills: fitInputShape.skills,
      // validated by the engine (BAD_REQUEST passes through with its code)
      resist_mode: z.string().optional().describe("which resist layer of a target fit applies: auto (default), shield, armor, hull, weighted_average"),
    })
    .optional();

  server.registerTool(
    "compute_graph",
    {
      title: "Compute graph",
      description:
        "One engine-computed graph for a fit (Pyfa graph window parity, CONTRACT-GRAPHS 0.2): e.g. graph=damage x_axis=distance_m y=[dps]; capacitor vs time_s; mobility speed vs time_s; lock_time vs tgt_sig_m; warp_time vs distance_m; application_profile (best ammo per distance); ewar / remote_reps vs distance_m; ecm_burst. x: explicit values or {from,to,points} (default range per axis, 21 points). `target` (damage, application_profile, ewar, remote_reps): a target profile or a target fit. Returns the series, a per-series summary (min/max/x at max) and a markdown table. Units are SI (m, s, m/s, HP/s, %).",
      inputSchema: {
        ...fitInputShape,
        graph: z.string().nullish().describe("graph name from list_graphs, e.g. damage, capacitor, mobility (required)"),
        x_axis: z.string().optional().describe("x axis (default: the graph's first axis valid for every requested y)"),
        x: z
          // values are checked in the handler so a bad value is a BAD_REQUEST tool error, not a protocol error
          .object({ values: z.array(z.any()).max(500).optional(), from: z.number().optional(), to: z.number().optional(), points: z.number().int().min(2).max(500).optional() })
          .optional(),
        y: z.array(z.string()).optional().describe("series (default: every series defined for the x axis)"),
        target: GraphTarget,
        params: z.record(z.string(), z.any()).optional().describe("graph parameters (list_graphs `params`, e.g. tgt_speed_mps, cap_start_pct, use_capsim, ammo_quality)"),
        settings: z.record(z.string(), z.any()).optional().describe("Pyfa graph settings: ignore_resists, apply_projected, ignore_lock_range, ignore_drone_control_range, mobile_drone_mode"),
        table: z.boolean().optional().describe("include a markdown table in the text output (default: when ≤ 30 points)"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    wrap(async (a) => {
      if (!a.graph) throw codedError("BAD_REQUEST", "graph is required (see list_graphs)", "graph");
      a.x?.values?.forEach((v: unknown, i: number) => {
        if (typeof v !== "number" || !Number.isFinite(v)) throw codedError("BAD_REQUEST", `x.values[${i}] must be a finite number (got ${JSON.stringify(v)})`, `x.values[${i}]`);
      });
      const specs = await graphSpecs(ctx.engine);
      const spec = specs.graphs[a.graph];
      if (!spec) throw Object.assign(new Error(`unknown graph '${a.graph}' (graphs: ${Object.keys(specs.graphs).join(", ")})`), { code: "UNKNOWN_GRAPH" });
      const { axis, y } = pickAxes(spec, a.graph, a.x_axis, a.y);
      const xs = sampleX(a.graph, axis, a.x);
      const n = await norm(a);
      const notes = [...n.notes];
      const req: Record<string, unknown> = { schema_version: 1, graph: a.graph, fit: n.request, x: { axis, values: xs }, y };
      if (a.target) {
        if (!TARGET_GRAPHS.has(a.graph)) notes.push(`graph ${a.graph} ignores the target`);
        const tg = a.target;
        const target: Record<string, unknown> = {};
        if (tg.fit !== undefined || tg.eft || tg.dna) {
          const tn = await norm({ fit: tg.fit, eft: tg.eft, dna: tg.dna, skills: tg.skills });
          target.fit = tn.request;
          if (tg.resist_mode) target.resist_mode = tg.resist_mode;
          notes.push(...tn.notes.map((x) => `target: ${x}`));
        } else if (tg.profile !== undefined) {
          if (typeof tg.profile === "string") {
            const p = targetProfile(tg.profile);
            if (!p) throw new Error(`unknown target profile '${tg.profile}' (see list_presets kind=target_profiles)`);
            target.profile = { em: p.em, thermal: p.thermal, kinetic: p.kinetic, explosive: p.explosive, max_velocity: p.max_velocity, signature_radius: p.signature_radius, radius: p.radius ?? null };
          } else target.profile = { em: 0, thermal: 0, kinetic: 0, explosive: 0, ...tg.profile };
        }
        if (Object.keys(target).length) req.target = target;
      }
      if (a.params) req.params = a.params;
      if (a.settings) req.settings = a.settings;
      const r: any = await ctx.engine.call("graph", req);
      const series: Record<string, (number | null)[]> = r.series ?? {};
      const units = Object.fromEntries(y.map((k) => [k, spec.series?.[k]?.unit ?? null]));
      const out = {
        graph: a.graph,
        title: spec.title ?? a.graph,
        x_axis: r.x_axis ?? axis,
        x_unit: spec.axes?.[axis]?.unit ?? null,
        units,
        x: r.x ?? xs,
        series,
        summary: summarizeSeries(r.x ?? xs, series),
        ...(r.meta ? { meta: r.meta } : {}),
        notes,
        request_hash: n.hash,
      };
      const showTable = a.table ?? xs.length <= 30;
      let text: string | undefined;
      if (showTable) {
        const fmt = (v: number | null | undefined) => (v === null || v === undefined ? "–" : String(round(v, 3)));
        const head = `| ${axis} | ${y.map((k) => `${k}${units[k] ? ` (${units[k]})` : ""}`).join(" | ")} |`;
        const rows = out.x.map((xv: number, i: number) => `| ${fmt(xv)} | ${y.map((k) => fmt(series[k]?.[i])).join(" | ")} |`);
        text = [`${out.title} — ${y.join(", ")} vs ${axis}`, "", head, `|${"---|".repeat(y.length + 1)}`, ...rows].join("\n");
      }
      return ok(out, text);
    }),
  );

  // ---------------------------------------------------------------- prices
  const PriceOpts = {
    source: z.enum(SOURCES.map((x) => x.id) as [string, ...string[]]).optional().describe("price source (default EVE_FIT_PRICE_SOURCE or esi): esi = CCP universe average, fuzzwork = trade-hub sell/buy percentile"),
    system: z.enum(Object.keys(HUBS) as [string, ...string[]]).optional().describe("trade hub for fuzzwork (default EVE_FIT_PRICE_SYSTEM or jita)"),
  };

  server.registerTool(
    "get_prices",
    {
      title: "Item prices",
      description:
        "Market prices for items (ids or names) from a public source: esi (CCP ESI /markets/prices/, universe-wide average) or fuzzwork (Jita/Amarr/Dodixie/Rens/Hek sell and buy 5% percentile). Cached (default 1 h); offline or on network errors the cache is used and `stale` is set; unknown prices are null.",
      inputSchema: { types: z.array(z.union([z.number().int(), z.string()])).min(1).max(500), ...PriceOpts },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    wrap(async (a) => {
      const ts = a.types.map((x) => ds.resolve(x));
      const r = await prices.lookup(ts.map((t) => t.id), { source: a.source, system: a.system });
      return ok({
        source: r.source,
        system: r.system,
        as_of: r.as_of ? new Date(r.as_of).toISOString() : null,
        stale: r.stale,
        prices: ts.map((t) => ({ type_id: t.id, name: t.name, ...r.prices.get(t.id) })),
        notes: r.notes,
      });
    }),
  );

  server.registerTool(
    "price_fit",
    {
      title: "Fit price",
      description:
        "Price a fit like Pyfa's price panel: ship, fittings (modules), charges (loaded, a full module load each), drones, fighters, cargo, implants and boosters, with per-item price and quantity (price column) and the total. Toggles leave drones/fighters, cargo or implants/boosters out of the total. Same sources and caching as get_prices. On a docs/23 engine the engine prices the fit: market prices (+ your isk) are injected, items without one fall back to the engine's embedded snapshot (use_snapshot=false to disable), each line names its source, and `provenance` says which SDE / price data was used.",
      inputSchema: {
        ...fitInputShape,
        ...PriceOpts,
        include_drones: z.boolean().optional().describe("drones and fighters in the total (default true)"),
        include_cargo: z.boolean().optional().describe("cargo in the total (default true)"),
        include_character: z.boolean().optional().describe("implants and boosters in the total (default true)"),
        price_overrides: priceInputShape.price_overrides.describe("docs/23 overrides applied by the engine (type / market group / group / category; fixed price incl. 0, or multiplier); needs an engine with docs/23 prices"),
        isk: z.record(z.string(), z.number()).optional().describe("your own prices: type id -> ISK, on top of the market prices (engine layer L3)"),
        use_snapshot: z.boolean().optional().describe("items without a market price fall back to the engine's embedded price snapshot (docs/22; default true); false: leave them unpriced"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    wrap(async (a) => {
      const n = await norm(a);
      const items = fitItems(n.request, (mod, ch) => {
        const cap = ds.type(mod)?.capacity ?? 0;
        const vol = ds.type(ch)?.volume ?? 0;
        return cap > 0 && vol > 0 ? Math.max(1, Math.floor(cap / vol + 1e-9)) : 1;
      });
      const r = await prices.lookup(items.map((i) => i.type_id), { source: a.source, system: a.system });
      // docs/23: the engine prices the fit. The MCP only supplies the market table (+ the user's own prices) as
      // injected prices and passes the overrides; totals, multipliers and the breakdown come from the engine.
      const market: Record<string, number> = {};
      for (const [id, p] of r.prices) if (typeof p?.price === "number") market[String(id)] = p.price;
      const req: Record<string, any> = JSON.parse(JSON.stringify(n.request));
      applyPriceInputs(ds, req, { price_overrides: a.price_overrides, prices: { isk: { ...market, ...(a.isk ?? {}) }, ...(a.use_snapshot === false ? { use_snapshot: false } : {}) }, price: true });
      const st: any = await calc(req as FitRequest);
      const excluded = [
        ...(a.include_drones === false ? ["drones", "fighters"] : []),
        ...(a.include_cargo === false ? ["cargo"] : []),
        ...(a.include_character === false ? ["implants", "boosters"] : []),
      ];
      if (st.price) {
        const pb = st.price;
        // the toggles are a view over the engine's sections (Pyfa price panel); the engine block itself is unchanged
        const included = (pb.total_isk ?? 0) - excluded.reduce((s, k) => s + (pb.sections?.[k]?.total_isk ?? 0), 0);
        const isk = (v: number) => `${round(v / 1e6, 2)}M`;
        const text = [`Fit price (engine; market ${r.source}${r.source === "esi" ? "" : ` ${r.system}`}${r.stale ? ", cached/stale" : ""}): ${isk(included)} ISK${excluded.length ? ` (without ${excluded.join(", ")}; all: ${isk(pb.total_isk ?? 0)})` : ""}${pb.complete === false ? ` (${pb.missing?.length ?? 0} items unpriced)` : ""}`, ...Object.entries<any>(pb.sections ?? {}).filter(([, v]) => v?.items?.length).map(([k, v]) => `- ${k}: ${isk(v.total_isk ?? 0)}${excluded.includes(k) ? " (excluded)" : ""}`)].join("\n");
        return ok({ priced_by: "engine", market_source: r.source, system: r.system, as_of: r.as_of ? new Date(r.as_of).toISOString() : null, stale: r.stale, total_isk: round(included, 2), excluded, price: pb, ...(st.provenance ? { provenance: st.provenance } : {}), notes: [...n.notes, ...r.notes], request_hash: n.hash }, text);
      }
      if (a.price_overrides?.length) throw codedError("UNSUPPORTED", "price_overrides need an engine with docs/23 prices (the current engine returns no price block)");
      // legacy path for engines before docs/23 (no price block): MCP-side sum of market prices
      const excl = new Set<string>(excluded);
      const sections: Record<string, number> = {};
      let total = 0;
      const rows = items.map((i) => {
        const p = a.isk?.[String(i.type_id)] ?? r.prices.get(i.type_id)?.price ?? null;
        const value = p === null ? null : p * i.quantity;
        sections[i.section] = (sections[i.section] ?? 0) + (value ?? 0);
        if (value !== null && !excl.has(i.section)) total += value;
        return { section: i.section, type_id: i.type_id, name: ds.type(i.type_id)?.name ?? String(i.type_id), quantity: i.quantity, unit_price: p, value };
      });
      const isk = (v: number) => `${round(v / 1e6, 2)}M`;
      const text = [`Fit price (${r.source}${r.source === "esi" ? "" : ` ${r.system}`}${r.stale ? ", cached/stale" : ""}): ${isk(total)} ISK`, ...Object.entries(sections).map(([k, v]) => `- ${k}: ${isk(v)}${excl.has(k) ? " (excluded)" : ""}`)].join("\n");
      return ok(
        {
          source: r.source,
          system: r.system,
          as_of: r.as_of ? new Date(r.as_of).toISOString() : null,
          stale: r.stale,
          total: round(total, 2),
          sections: Object.fromEntries(Object.entries(sections).map(([k, v]) => [k, round(v, 2)])),
          excluded: [...excl],
          items: rows,
          missing: rows.filter((x) => x.unit_price === null).map((x) => x.name),
          priced_by: "mcp-legacy",
          notes: [...n.notes, ...r.notes, "engine without docs/23 prices: summed by the MCP (legacy)"],
          request_hash: n.hash,
        },
        text,
      );
    }),
  );

  server.registerTool(
    "load_prices",
    {
      title: "Load / update engine price data",
      description:
        "Load a price file into the engine as injected prices (docs/23 file layer, like the engine's `--prices FILE`): an eve-price-snapshot v1 (EX-CT/eve-market-prices) or a plain {type_id: isk} map, from a local path, an http(s) URL, or `latest` = download the newest EX-CT/eve-market-prices snapshot release (update prices). Precedence: request price_overrides > request prices.isk > this file > the engine's embedded snapshot. Results then report provenance.price_source = file with the file's snapshot time. `clear: true` goes back to the embedded snapshot; no arguments shows what is loaded. Applies to every later engine call (all sessions).",
      inputSchema: {
        source: z.string().optional().describe("path, http(s) URL, or `latest` (newest eve-market-prices release)"),
        clear: z.boolean().optional().describe("drop the loaded file (embedded snapshot again)"),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    },
    wrap(async (a) => {
      if (a.clear && a.source) throw codedError("BAD_REQUEST", "give source or clear, not both");
      if (a.clear) {
        await loadPriceFile(ctx, null);
        return ok({ loaded: null, note: "injected price file cleared; the engine's embedded snapshot applies" }, "Price file cleared (embedded snapshot applies).");
      }
      if (!a.source) return ok({ loaded: ctx.priceFile ?? null }, ctx.priceFile ? `Loaded: ${ctx.priceFile.path} (${ctx.priceFile.engine.types ?? "?"} types, ${ctx.priceFile.engine.price_snapshot_id ?? "plain map"})` : "No price file loaded (embedded snapshot applies).");
      const f = await loadPriceFile(ctx, a.source);
      return ok({ loaded: f }, `Loaded ${f!.path}${f!.release ? ` (release ${f!.release}${f!.origin === "release-cache" ? ", cached" : ""})` : ""}: ${f!.engine.types ?? "?"} types, snapshot ${f!.engine.price_snapshot_id ?? "-"} ${f!.engine.snapshot_time ?? ""}${f!.engine.warnings?.length ? `; warnings: ${f!.engine.warnings.join("; ")}` : ""}`);
    }),
  );

  // ---------------------------------------------------------------- resources
  const json = (uri: string, data: unknown) => ({ contents: [{ uri, mimeType: "application/json", text: JSON.stringify(data, null, 1) }] });
  server.registerResource("dataset-meta", "eve://dataset/meta", { title: "Dataset metadata", mimeType: "application/json", description: "SDE build, sha256, counts" }, async (uri) =>
    json(uri.href, { path: ds.path, sha256: ds.sha256, sde_build: ds.sdeBuild, format: ds.format, types: ds.types.size, attributes: ds.attrs.size, groups: ds.groups.size }),
  );
  server.registerResource("schema-fit-request", "eve://schema/fit-request", { title: "FitRequest JSON Schema", mimeType: "application/schema+json" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "application/schema+json", text: readAsset("schemas/fit-request.schema.json") }],
  }));
  server.registerResource("schema-fit-stats", "eve://schema/fit-stats", { title: "FitStats JSON Schema", mimeType: "application/schema+json" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "application/schema+json", text: readAsset("schemas/fit-stats.schema.json") }],
  }));
  server.registerResource("presets", "eve://presets", { title: "Skill / damage / target presets and implant sets", mimeType: "application/json" }, async (uri) =>
    json(uri.href, { skills: SKILL_PRESETS, damage_profiles: DAMAGE_PROFILES, target_profiles: TARGET_PROFILES, implant_sets: implantSets(ds) }),
  );
  server.registerResource("price-sources", "eve://prices/sources", { title: "Price sources, trade hubs and terms", mimeType: "application/json" }, async (uri) =>
    json(uri.href, { default_source: prices.cfg.source, default_system: prices.cfg.system, offline: prices.cfg.offline, ttl_s: prices.cfg.ttlS, sources: SOURCES, hubs: HUBS }),
  );
  server.registerResource("jargon", "eve://jargon", { title: "Player jargon understood by search", mimeType: "application/json" }, async (uri) => json(uri.href, JARGON));
  server.registerResource("metrics", "eve://metrics", { title: "Metric keys for compare/suggest/optimise goals", mimeType: "application/json" }, async (uri) =>
    json(uri.href, METRICS.map((m) => ({ key: m.key, label: m.label, unit: m.unit, better: m.better, group: m.group }))),
  );
  server.registerResource("guide", "eve://guide/fitting", { title: "Fitting workflow guide", mimeType: "text/markdown" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "text/markdown", text: readAsset("docs/fitting-guide.md") }],
  }));
  server.registerResource(
    "type",
    new ResourceTemplate("eve://type/{id}", { list: undefined }),
    { title: "Type info", mimeType: "application/json", description: "base attributes, effects, skills of one type id" },
    async (uri, vars) => {
      const t = ds.resolve(Number(vars.id));
      return json(uri.href, { ...ds.hit(t), attributes: ds.namedAttrs(t, { publishedOnly: true }), required_skills: ds.requiredSkills(t) });
    },
  );
  server.registerResource(
    "ship-layout",
    new ResourceTemplate("eve://ship/{id}/layout", { list: undefined }),
    { title: "Ship layout", mimeType: "application/json", description: "slots, hardpoints and base resources of a hull" },
    async (uri, vars) => {
      const t = ds.resolve(Number(vars.id), ["ship", "structure"]);
      return json(uri.href, { ship: ds.hit(t), layout: ds.shipLayout(t) });
    },
  );
  server.registerResource(
    "ship-modules",
    new ResourceTemplate("eve://ship/{id}/modules/{slot}", { list: undefined }),
    { title: "Modules fitting a hull slot", mimeType: "application/json" },
    async (uri, vars) => {
      const t = ds.resolve(Number(vars.id), ["ship", "structure"]);
      const slot = String(vars.slot) as Slot;
      if (!SLOTS.includes(slot)) throw new Error(`slot must be one of ${SLOTS.join(", ")}`);
      return json(uri.href, candidateModules(ds, t, slot).map((m) => ({ type_id: m.id, name: m.name, group: m.group, meta_level: m.metaLevel })));
    },
  );

  // ---------------------------------------------------------------- prompts
  const userMsg = (text: string) => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text } }] });
  server.registerPrompt(
    "fit_for_role",
    {
      title: "Build a fit for a role",
      description: "Design a fit for a ship and activity, iterating with the tools until it is valid and meets the goal.",
      argsSchema: { ship: z.string(), activity: z.string().describe("e.g. 'level 4 missions vs Guristas', 'solo lowsec PvP', 'exploration'"), constraints: z.string().optional().describe("budget, skills, must-have modules") },
    },
    ({ ship, activity, constraints }) =>
      userMsg(
        `Build a ${ship} fit for: ${activity}.${constraints ? ` Constraints: ${constraints}.` : ""}\n\n` +
          `Use the eve-fit tools:\n1. get_ship for the layout and resources.\n2. search_types (with fits_ship) to pick modules for each slot; choose a tank type (shield/armor) that suits the hull.\n` +
          `3. compute_fit with the draft (EFT text is fine) and the matching damage_profile/target_profile; fix every violation (validate_fit gives hints).\n` +
          `4. Use suggest_modules / what_if (or optimize_fit with constraints) to improve the main goal while keeping capacitor and fitting room acceptable.\n` +
          `5. Finish with the EFT (export_fit), key stats (DPS, EHP, tank, cap, speed), and skill_requirements if skills matter. Explain trade-offs briefly.`,
      ),
  );
  server.registerPrompt(
    "review_fit",
    {
      title: "Review a fit",
      description: "Explain a fit's strengths, weaknesses and concrete improvements, backed by computed numbers.",
      argsSchema: { fit: z.string().describe("EFT text or DNA"), purpose: z.string().optional() },
    },
    ({ fit, purpose }) =>
      userMsg(
        `Review this fit${purpose ? ` for ${purpose}` : ""}:\n\n${fit}\n\n` +
          `Call compute_fit (and validate_fit if there are violations), then evaluate_profiles to see how damage applies and how the tank holds against common damage types. ` +
          `Point out problems (cap stability, resist holes, fitting room, range, application), then test 2–4 concrete improvements with what_if and report the deltas in a table. Keep it concise.`,
      ),
  );
  server.registerPrompt(
    "explain_stat",
    {
      title: "Explain a stat",
      description: "Explain why a fit has a particular value (align time, lock time, cap stability, DPS…) and what changes it most.",
      argsSchema: { fit: z.string().describe("EFT text or DNA"), stat: z.string().describe("e.g. 'align time', 'cap stability', 'shield EHP'") },
    },
    ({ fit, stat }) =>
      userMsg(
        `Fit:\n\n${fit}\n\nExplain the ${stat} of this fit. Use compute_fit (detail=full with the relevant sections) for the numbers, get_type for the base values of the hull/modules involved, ` +
          `and what_if to show which single change (module, state, skill, implant) moves it most. Report the sensitivities as a small table.`,
      ),
  );
  server.registerPrompt(
    "compare_options",
    {
      title: "Compare fit options",
      description: "Compare two or more alternative fits (or one fit with alternatives) on the metrics that matter for a purpose.",
      argsSchema: { fits: z.string().describe("two or more EFT blocks separated by blank lines, or one fit plus the alternatives to try"), purpose: z.string().optional() },
    },
    ({ fits, purpose }) =>
      userMsg(
        `Compare these options${purpose ? ` for ${purpose}` : ""}:\n\n${fits}\n\nUse compare_fits (pick metrics that matter for the purpose; add target_profile/damage_profile if relevant). ` +
          `If only one fit is given, build the alternatives with what_if scenarios. Recommend one and say why, citing the deltas.`,
      ),
  );

  return server;
}
