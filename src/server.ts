// MCP server: tools, resources and prompts for EVE fitting on top of any eve-dogma contract engine.
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isContractError, type FitRequest, type FitStats } from "./adapters/types.js";
import type { Dataset, Kind, Slot } from "./dataset.js";
import { JARGON, KINDS, SLOTS } from "./dataset.js";
import { exportDna, exportMultibuy } from "./dna.js";
import { normalizeFit, type Ctx, type FitInput } from "./fit.js";
import { applyChange, candidateModules, evalBatch, freeSlots, optimize, skillRequirements, suggest, toGoals } from "./helpers.js";
import { DEFAULT_COMPARE, goalScore, METRICS, metric, round, type Goal } from "./metrics.js";

const goalScoreSafe = (g: Goal[], s: FitStats, b: FitStats) => round(goalScore(g, s, b), 5) ?? 0;
import { DAMAGE_PROFILES, implantSets, SKILL_PRESETS, TARGET_PROFILES } from "./profiles.js";
import { Change, Constraints, fitInputShape, FitInputObject, GoalSpec, z } from "./schemas.js";
import { markdownTable, pickSections, SECTIONS, summarize } from "./summary.js";

export const VERSION = "0.1.0";
const here = dirname(fileURLToPath(import.meta.url));

function readAsset(rel: string): string {
  for (const base of [join(here, ".."), join(here, "..", "..")]) {
    try {
      return readFileSync(join(base, rel), "utf8");
    } catch {}
  }
  return "{}";
}

type ToolResult = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

function ok(data: unknown, text?: string): ToolResult {
  const json = JSON.stringify(data);
  const content: ToolResult["content"] = [];
  if (text) content.push({ type: "text", text });
  content.push({ type: "text", text: json });
  return { content, structuredContent: data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : { result: data } };
}

function fail(e: unknown): ToolResult {
  const err: any = e;
  const code = err?.code && typeof err.code === "string" ? `${err.code}: ` : "";
  const path = err?.path ? ` (at ${err.path})` : "";
  return { content: [{ type: "text", text: `Error: ${code}${err?.message ?? String(e)}${path}` }], isError: true };
}

function wrap<A>(fn: (a: A) => Promise<ToolResult>) {
  return async (a: A) => {
    try {
      return await fn(a);
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
}

export function createServer(ctx: ServerDeps): McpServer {
  const { ds } = ctx;
  const server = new McpServer(
    { name: "eve-fit-mcp", version: VERSION },
    {
      capabilities: { tools: {}, resources: {}, prompts: {}, logging: {} },
      instructions:
        "EVE Online fitting tools backed by a deterministic dogma engine (Pyfa-parity numbers). Typical flow: search_types → compute_fit (EFT text, DNA or FitRequest JSON; names accepted) → compare_fits / what_if → suggest_modules / optimize_fit. Every tool is stateless: pass the whole fit each time. Skills default to all V unless `skills` is given. Read eve://guide/fitting for the workflow and eve://schema/fit-request for the request format.",
    },
  );

  const norm = (a: FitInput) => normalizeFit(ctx, a);
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
      });
    }),
  );

  server.registerTool(
    "get_ship",
    {
      title: "Ship layout",
      description:
        "Slots, hardpoints, rig size, CPU/powergrid/calibration, drone bay and bandwidth for a hull, plus the empty hull's computed stats with the given skills (default all V): what you have to work with before fitting.",
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
        "Full Pyfa-parity statistics for a fit: DPS/volley (per weapon, drones, fighters, applied vs a target profile), EHP/resists/tank, capacitor simulation, speed/align/signature/warp, targeting, resources and violations. detail=summary (default) returns a compact view + named metrics; detail=full returns the engine output (optionally only `sections`).",
      inputSchema: {
        ...fitInputShape,
        detail: z.enum(["summary", "full"]).optional(),
        sections: z.array(z.enum(SECTIONS)).optional().describe("with detail=full: only these top-level sections"),
        include_request: z.boolean().optional().describe("echo the normalised FitRequest"),
        options: z.record(z.string(), z.any()).optional().describe("engine options merged into the request (factor_reload, rah, include_attributes, cap_sim…)"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    wrap(async (a) => {
      const n = await norm(a);
      if (a.options) n.request.options = { ...((n.request as any).options ?? {}), ...a.options };
      const s = await calc(n.request);
      const body: Record<string, unknown> =
        a.detail === "full" ? (a.sections?.length ? pickSections(s, a.sections) : s) : summarize(ds, n.request, s);
      const out: Record<string, unknown> = { ...body, request_hash: n.hash, notes: n.notes, engine: (s as any).meta?.engine };
      if (a.include_request) out.request = n.request;
      return ok(out);
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
    wrap(async (a) => {
      const n = await norm(a);
      const goals = toGoals(a.goal as any);
      const budget = a.budget ?? Math.min(ctx.maxBatch * 4, 1600);
      const r = await optimize(ctx, n.request, goals, a.constraints, budget, a.slots as Slot[] | undefined, a.lock ?? []);
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
