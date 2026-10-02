// AI helpers built on batch evaluation: what-if scenarios, module suggestions, greedy optimisation,
// skill requirements. All of them only ever send complete stateless FitRequests to the engine.
import type { ContractError, FitRequest, FitStats } from "./adapters/types.js";
import { isContractError } from "./adapters/types.js";
import type { Dataset, Slot, TypeInfo } from "./dataset.js";
import { SLOTS } from "./dataset.js";
import { defaultState } from "./dna.js";
import { resolveModule, resolveQty, type Ctx } from "./fit.js";
import { goalScore, metric, round, type Goal } from "./metrics.js";
import { damageProfile, targetProfile } from "./profiles.js";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

export function toGoals(g: string | { metric: string; weight?: number }[]): Goal[] {
  return typeof g === "string" ? [{ metric: g, weight: 1 }] : g;
}

export function applyChange(ctx: Ctx, req0: FitRequest, ch: any): FitRequest {
  const ds = ctx.ds;
  const req: any = clone(req0);
  const mods: any[] = (req.modules ??= []);
  const needIdx = (arr: any[], what: string) => {
    if (ch.index === undefined || ch.index < 0 || ch.index >= arr.length) throw new Error(`${ch.op}: ${what} index ${ch.index} out of range (0..${arr.length - 1})`);
    return ch.index as number;
  };
  switch (ch.op) {
    case "add_module":
      mods.push(resolveModule(ds, ch.module, [], "add_module"));
      break;
    case "remove_module":
      mods.splice(needIdx(mods, "module"), 1);
      break;
    case "replace_module": {
      const i = needIdx(mods, "module");
      const old = mods[i];
      const m = resolveModule(ds, ch.module, [], "replace_module");
      // keep the old charge if the new module can load it (gun → gun swaps)
      if (m.charge_type_id === undefined && old.charge_type_id) {
        const t = ds.type(m.type_id)!;
        if (ds.compatibleCharges(t).some((c) => c.id === old.charge_type_id)) m.charge_type_id = old.charge_type_id;
      }
      mods[i] = m;
      break;
    }
    case "set_state":
      mods[needIdx(mods, "module")].state = ch.state;
      break;
    case "set_charge": {
      const i = needIdx(mods, "module");
      if (ch.charge === null) delete mods[i].charge_type_id;
      else mods[i].charge_type_id = ds.resolve(ch.charge, ["charge"]).id;
      break;
    }
    case "set_skill": {
      const t = ds.resolve(ch.skill, ["skill"]);
      req.character ??= {};
      req.character.skills ??= {};
      req.character.skills.levels = { ...(req.character.skills.levels ?? {}), [String(t.id)]: ch.level ?? 5 };
      break;
    }
    case "set_all_skills":
      req.character ??= {};
      req.character.skills = { default_level: ch.level ?? 5, levels: {} };
      break;
    case "add_drone": {
      const { t, quantity, spec } = resolveQty(ds, ch.drone, ["drone"], "add_drone");
      (req.drones ??= []).push({ type_id: t.id, quantity, active: spec.active ?? quantity });
      break;
    }
    case "remove_drone":
      req.drones.splice(needIdx(req.drones ?? [], "drone"), 1);
      break;
    case "set_drone_active":
      req.drones[needIdx(req.drones ?? [], "drone")].active = ch.active ?? 0;
      break;
    case "add_implant": {
      const t = ds.resolve(ch.type, ["implant"]);
      const slot = ds.attr(t, "implantness");
      req.implants = (req.implants ?? []).filter((x: number) => slot === undefined || ds.attr(ds.type(x)!, "implantness") !== slot);
      req.implants.push(t.id);
      break;
    }
    case "remove_implant": {
      const t = ds.resolve(ch.type, ["implant"]);
      req.implants = (req.implants ?? []).filter((x: number) => x !== t.id);
      break;
    }
    case "add_booster": {
      const t = ds.resolve(ch.type, ["booster", "implant"]);
      (req.boosters ??= []).push({ type_id: t.id, side_effects: [] });
      break;
    }
    case "set_damage_profile": {
      const p = typeof ch.profile === "string" ? damageProfile(ch.profile) : ch.profile;
      if (!p) throw new Error(`unknown damage profile ${ch.profile}`);
      req.damage_pattern = { em: p.em, thermal: p.thermal, kinetic: p.kinetic, explosive: p.explosive };
      break;
    }
    case "set_target_profile": {
      const p: any = typeof ch.profile === "string" ? targetProfile(ch.profile) : ch.profile;
      if (!p) throw new Error(`unknown target profile ${ch.profile}`);
      req.target_profile = { em: p.em ?? 0, thermal: p.thermal ?? 0, kinetic: p.kinetic ?? 0, explosive: p.explosive ?? 0, signature_radius: p.signature_radius ?? null, max_velocity: p.max_velocity ?? null, radius: p.radius ?? null };
      break;
    }
    case "set_option":
      if (!ch.option) throw new Error("set_option needs option");
      req.options = { ...(req.options ?? {}), [ch.option]: ch.value };
      break;
    default:
      throw new Error(`unknown change op ${ch.op}`);
  }
  return req;
}

export async function evalBatch(ctx: Ctx, reqs: FitRequest[]): Promise<(FitStats | ContractError)[]> {
  const out: (FitStats | ContractError)[] = [];
  const chunk = 200;
  for (let i = 0; i < reqs.length; i += chunk) out.push(...(await ctx.engine.batch(reqs.slice(i, i + chunk))));
  return out;
}

export interface CandidateFilter {
  meta_min?: number;
  meta_max?: number;
  tech_level?: number;
  group?: string;
  query?: string;
  exclude?: (number | string)[];
}

/** Published modules for a slot that pass the static fit check on this hull. */
export function candidateModules(ds: Dataset, ship: TypeInfo, slot: Slot, f: CandidateFilter = {}): TypeInfo[] {
  const exclude = new Set((f.exclude ?? []).map((x) => ds.resolve(x).id));
  const allowed = f.query ? new Set(ds.search(f.query, { kinds: ["module", "subsystem", "structure_module"], slot, limit: 200 }).map((h) => h.type_id)) : null;
  const g = f.group?.toLowerCase();
  const out: TypeInfo[] = [];
  for (const t of ds.types.values()) {
    if (!t.published || t.slot !== slot) continue;
    if (t.kind !== "module" && t.kind !== "subsystem" && t.kind !== "structure_module") continue;
    if (exclude.has(t.id) || (allowed && !allowed.has(t.id))) continue;
    if (g && !t.group.toLowerCase().includes(g)) continue;
    if (f.meta_min !== undefined && t.metaLevel < f.meta_min) continue;
    if (f.meta_max !== undefined && t.metaLevel > f.meta_max) continue;
    if (f.tech_level !== undefined && t.techLevel !== f.tech_level) continue;
    if (!ds.canFit(t, ship).ok) continue;
    out.push(t);
  }
  return out.sort((a, b) => a.groupId - b.groupId || a.metaLevel - b.metaLevel || a.id - b.id);
}

/** One representative per group (T2 if present, else highest meta): the coarse first pass. */
export function groupRepresentatives(cands: TypeInfo[]): TypeInfo[] {
  const best = new Map<number, TypeInfo>();
  const rank = (t: TypeInfo) => (t.techLevel === 2 ? 1000 : 0) + t.metaLevel;
  for (const t of cands) {
    const b = best.get(t.groupId);
    if (!b || rank(t) > rank(b)) best.set(t.groupId, t);
  }
  return [...best.values()];
}

/** Best-damage compatible charge (for weapons added without ammo). */
export function defaultCharge(ds: Dataset, mod: TypeInfo): number | undefined {
  const ch = ds.compatibleCharges(mod, 500);
  if (!ch.length) return undefined;
  const dmg = (t: TypeInfo) =>
    ["emDamage", "thermalDamage", "kineticDamage", "explosiveDamage"].reduce((a, n) => a + (ds.attr(t, n) ?? 0), 0) + (ds.attr(t, "capacitorBonus") ?? 0);
  return [...ch].sort((a, b) => dmg(b) - dmg(a) || a.metaLevel - b.metaLevel || a.id - b.id)[0].id;
}

function moduleEntry(ds: Dataset, t: TypeInfo, keepCharge?: number): any {
  const m: any = { type_id: t.id, slot: t.slot, state: defaultState(ds, t) };
  if (keepCharge && ds.compatibleCharges(t).some((c) => c.id === keepCharge)) m.charge_type_id = keepCharge;
  else {
    const c = defaultCharge(ds, t);
    if (c) m.charge_type_id = c;
  }
  return m;
}

export interface Scored {
  type_id: number;
  name: string;
  group: string;
  meta_level: number;
  score: number;
  goal: Record<string, { value: number | null; delta: number | null }>;
  fitting: { cpu_free: number | null; power_free: number | null };
  new_violations: string[];
  charge: string | null;
}

function violationCodes(s: any): string[] {
  return (s.violations ?? []).map((v: any) => v.code);
}

/** An overload that already exists may not get worse (otherwise "no new violations" lets CPU go ever more negative). */
function worsensOverload(s: FitStats, base: FitStats): boolean {
  for (const k of ["cpu_free", "power_free", "calibration_free"]) {
    const v = metric(k).get(s);
    const b = metric(k).get(base);
    if (v !== null && b !== null && v < 0 && v < b - 1e-9) return true;
  }
  return false;
}

export function checkConstraintKeys(c: any) {
  for (const k of [...Object.keys(c?.min ?? {}), ...Object.keys(c?.max ?? {})]) metric(k);
}

function passes(s: FitStats, c: any): boolean {
  for (const [k, v] of Object.entries<number>(c?.min ?? {})) if ((metric(k).get(s) ?? -Infinity) < v) return false;
  for (const [k, v] of Object.entries<number>(c?.max ?? {})) if ((metric(k).get(s) ?? Infinity) > v) return false;
  return true;
}

export interface SuggestArgs {
  base: FitRequest;
  baseStats: FitStats;
  goals: Goal[];
  slot: Slot;
  replaceIndex?: number;
  constraints?: any;
  top: number;
  budget: number;
}

/** Evaluate candidate modules for one slot (added, or replacing module `replaceIndex`) and rank them by goal. */
export async function suggest(ctx: Ctx, a: SuggestArgs): Promise<{ ranked: Scored[]; evaluated: number; candidates: number; strategy: string }> {
  const ds = ctx.ds;
  checkConstraintKeys(a.constraints);
  const req: any = a.base;
  const ship = ds.type(req.ship.type_id)!;
  const cur = a.replaceIndex !== undefined ? req.modules[a.replaceIndex] : undefined;
  const all = candidateModules(ds, ship, a.slot, a.constraints ?? {}).filter((t) => t.id !== cur?.type_id);
  let pool = all;
  let strategy = "exhaustive";
  if (all.length > a.budget) {
    // coarse pass: one module per group; fine pass: every variant of the best groups
    strategy = "group representatives, then variants of the best groups";
    const reps = groupRepresentatives(all).slice(0, Math.max(1, Math.floor(a.budget / 2)));
    const first = await score(ctx, a, reps, cur);
    const topGroups = new Set(first.ranked.slice(0, 6).map((r) => ds.type(r.type_id)!.groupId));
    const left = a.budget - reps.length;
    const variants = all.filter((t) => topGroups.has(t.groupId) && !reps.includes(t)).slice(0, Math.max(0, left));
    const second = await score(ctx, a, variants, cur);
    const ranked = [...first.ranked, ...second.ranked].sort((x, y) => y.score - x.score);
    return { ranked: ranked.slice(0, a.top), evaluated: reps.length + variants.length, candidates: all.length, strategy };
  }
  const r = await score(ctx, a, pool, cur);
  return { ranked: r.ranked.slice(0, a.top), evaluated: pool.length, candidates: all.length, strategy };
}

async function score(ctx: Ctx, a: SuggestArgs, cands: TypeInfo[], cur: any): Promise<{ ranked: Scored[] }> {
  const ds = ctx.ds;
  const baseViol = new Set(violationCodes(a.baseStats));
  const reqs = cands.map((t) => {
    const r: any = clone(a.base);
    const m = moduleEntry(ds, t, cur?.charge_type_id);
    if (a.replaceIndex !== undefined) r.modules[a.replaceIndex] = m;
    else r.modules.push(m);
    return r;
  });
  const res = await evalBatch(ctx, reqs);
  const ranked: Scored[] = [];
  res.forEach((s, i) => {
    if (isContractError(s)) return;
    const added = violationCodes(s).filter((c) => !baseViol.has(c));
    if (!a.constraints?.allow_violations && (added.length || worsensOverload(s, a.baseStats))) return;
    if (!passes(s, a.constraints)) return;
    const t = cands[i];
    const goal: Scored["goal"] = {};
    for (const g of a.goals) {
      const m = metric(g.metric);
      const v = m.get(s);
      const b = m.get(a.baseStats);
      goal[g.metric] = { value: round(v), delta: v !== null && b !== null ? round(v - b) : null };
    }
    const m = reqs[i].modules[a.replaceIndex ?? reqs[i].modules.length - 1];
    ranked.push({
      type_id: t.id,
      name: t.name,
      group: t.group,
      meta_level: t.metaLevel,
      score: round(goalScore(a.goals, s, a.baseStats), 5)!,
      goal,
      fitting: { cpu_free: round(metric("cpu_free").get(s), 2), power_free: round(metric("power_free").get(s), 2) },
      new_violations: added,
      charge: m.charge_type_id ? ds.type(m.charge_type_id)?.name ?? null : null,
    });
  });
  ranked.sort((x, y) => y.score - x.score || x.meta_level - y.meta_level || x.type_id - y.type_id);
  return { ranked };
}

export function freeSlots(stats: FitStats): Partial<Record<Slot, number>> {
  const out: Partial<Record<Slot, number>> = {};
  const sl: any = (stats as any).resources?.slots ?? {};
  for (const s of SLOTS) {
    const v = sl[s];
    if (v && v.total - v.used > 0) out[s] = v.total - v.used;
  }
  return out;
}

export interface OptimizeStep {
  step: number;
  action: string;
  score_after: number;
  goal_values: Record<string, number | null>;
}

/** Greedy improvement: fill free slots, then repeatedly apply the single best module swap until nothing helps. */
export async function optimize(ctx: Ctx, base: FitRequest, goals: Goal[], constraints: any, budget: number, slots?: Slot[], lockIndices: number[] = [], onProgress?: (evaluated: number, message: string) => void) {
  const ds = ctx.ds;
  let req: any = clone(base);
  const firstStats = await ctx.engine.calc(req);
  let stats = firstStats;
  let evaluated = 1;
  const trace: OptimizeStep[] = [];
  const perCall = Math.max(8, Math.min(60, Math.floor(budget / 12)));
  const gv = (s: FitStats) => Object.fromEntries(goals.map((g) => [g.metric, round(metric(g.metric).get(s))]));
  const slotOk = (s: Slot) => !slots || slots.includes(s);
  let step = 0;
  while (evaluated < budget) {
    const moves: { score: number; req: any; action: string }[] = [];
    // 1) fill free slots
    for (const [slot, n] of Object.entries(freeSlots(stats)) as [Slot, number][]) {
      if (!n || !slotOk(slot) || slot === "subsystem" || evaluated >= budget) continue;
      const r = await suggest(ctx, { base: req, baseStats: stats, goals, slot, constraints, top: 1, budget: Math.min(perCall, budget - evaluated) });
      evaluated += r.evaluated;
      const best = r.ranked[0];
      if (best && best.score > 1e-9) {
        const nr: any = clone(req);
        nr.modules.push(moduleEntry(ds, ds.type(best.type_id)!));
        moves.push({ score: best.score, req: nr, action: `add ${best.name} (${slot})` });
      }
    }
    // 2) swap existing modules
    if (!moves.length) {
      for (let i = 0; i < req.modules.length && evaluated < budget; i++) {
        if (lockIndices.includes(i)) continue;
        const t = ds.type(req.modules[i].type_id);
        if (!t?.slot || !slotOk(t.slot) || t.slot === "subsystem") continue;
        const r = await suggest(ctx, { base: req, baseStats: stats, goals, slot: t.slot, replaceIndex: i, constraints, top: 1, budget: Math.min(perCall, budget - evaluated) });
        evaluated += r.evaluated;
        const best = r.ranked[0];
        if (best && best.score > 1e-6) {
          const nr: any = clone(req);
          nr.modules[i] = moduleEntry(ds, ds.type(best.type_id)!, req.modules[i].charge_type_id);
          moves.push({ score: best.score, req: nr, action: `replace #${i} ${t.name} → ${best.name}` });
        }
      }
    }
    if (!moves.length) break;
    moves.sort((a, b) => b.score - a.score);
    const mv = moves[0];
    const ns = await ctx.engine.calc(mv.req);
    evaluated++;
    if (goalScore(goals, ns, stats) <= 1e-9) break;
    req = mv.req;
    stats = ns;
    trace.push({ step: ++step, action: mv.action, score_after: round(goalScore(goals, stats, firstStats), 5)!, goal_values: gv(stats) });
    onProgress?.(evaluated, `step ${step}: ${mv.action}`);
    if (step >= 40) break;
  }
  return { request: req, stats, firstStats, trace, evaluated };
}

export function characterLevel(req: any, skillId: number): number {
  const sk = req.character?.skills ?? {};
  const lv = sk.levels?.[String(skillId)];
  return lv ?? sk.default_level ?? 0;
}

export function skillRequirements(ds: Dataset, req: any) {
  const items: { what: string; t: TypeInfo }[] = [];
  const add = (id: number | undefined, what: string) => {
    const t = id !== undefined ? ds.type(id) : undefined;
    if (t) items.push({ what, t });
  };
  add(req.ship?.type_id, "ship");
  (req.modules ?? []).forEach((m: any, i: number) => {
    add(m.type_id, `module #${i}`);
    if (m.charge_type_id) add(m.charge_type_id, `charge of #${i}`);
  });
  for (const d of req.drones ?? []) add(d.type_id, "drone");
  for (const f of req.fighters ?? []) add(f.type_id, "fighter");
  for (const i of req.implants ?? []) add(i, "implant");
  for (const b of req.boosters ?? []) add(b.type_id, "booster");
  const need = new Map<number, { level: number; for: Set<string> }>();
  for (const { t } of items) {
    for (const [sid, lvl] of ds.skillTree(t)) {
      const e = need.get(sid) ?? { level: 0, for: new Set<string>() };
      e.level = Math.max(e.level, lvl);
      e.for.add(t.name);
      need.set(sid, e);
    }
  }
  const rows = [...need].map(([sid, e]) => {
    const st = ds.type(sid);
    const have = characterLevel(req, sid);
    return { skill_id: sid, skill: st?.name ?? String(sid), group: st?.group ?? null, required: e.level, character: have, missing: have < e.level, needed_for: [...e.for].sort().slice(0, 12) };
  });
  rows.sort((a, b) => Number(b.missing) - Number(a.missing) || (a.group ?? "").localeCompare(b.group ?? "") || a.skill.localeCompare(b.skill));
  return { skills: rows, missing: rows.filter((r) => r.missing).length, total: rows.length };
}
