// Fit input normalisation: everything an agent might hand us (EFT text, DNA, a FitRequest, or a lenient
// FitRequest with names instead of ids) becomes a strict contract FitRequest with ids, plus notes about
// what was assumed. Engines are stateless, so the normalised request is all that is needed to replay.
import { createHash } from "node:crypto";
import type { EngineAdapter, FitRequest } from "./adapters/types.js";
import type { Dataset, Kind, TypeInfo } from "./dataset.js";
import { defaultState, parseDna } from "./dna.js";
import { damageProfile, findImplantSet, skillPreset, targetProfile } from "./profiles.js";

export interface FitInput {
  fit?: unknown;
  eft?: string;
  dna?: string;
  skills?: string | number | { default_level?: number; levels?: Record<string, number> };
  damage_profile?: string | Record<string, number | string>;
  target_profile?: string | Record<string, number | string | null>;
  implant_set?: string;
}

export interface Normalized {
  request: FitRequest;
  notes: string[];
  hash: string;
}

export interface Ctx {
  ds: Dataset;
  engine: EngineAdapter;
  defaultSkillLevel: number;
  maxBatch: number;
}

const MODULE_KINDS: Kind[] = ["module", "subsystem", "structure_module"];

function ref(v: any): number | string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "number" || typeof v === "string") return v;
  return v.type_id ?? v.name ?? v.type;
}

/** Canonical JSON (sorted keys) → sha256, the replay/caching key for a request. */
export function requestHash(req: unknown): string {
  const canon = (v: any): any =>
    Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v;
  return createHash("sha256").update(JSON.stringify(canon(req))).digest("hex");
}

function parseModuleString(ds: Dataset, s: string) {
  // EFT-style "Module Name, Charge Name /offline" (also /online, /active, /overheated or /overheat) or "Name x5"
  let text = s.trim();
  let state: string | undefined;
  const m = /\s*\/(offline|online|active|overheated|overheat)$/i.exec(text);
  if (m) {
    state = m[1].toLowerCase() === "overheat" ? "overheated" : m[1].toLowerCase();
    text = text.slice(0, m.index);
  }
  const [name, charge] = text.split(/\s*,\s*/, 2);
  return { name, charge, state };
}

export function resolveModule(ds: Dataset, m: any, notes: string[], where: string) {
  let spec: any = m;
  if (typeof m === "string") {
    const p = parseModuleString(ds, m);
    spec = { name: p.name, charge: p.charge, state: p.state };
  } else if (typeof m === "number") spec = { type_id: m };
  const r = ref(spec);
  if (r === undefined) throw new Error(`${where}: module needs type_id or name`);
  const t = ds.resolve(r, MODULE_KINDS);
  const out: any = { type_id: t.id };
  if (spec.slot) out.slot = spec.slot;
  else if (t.slot) out.slot = t.slot;
  out.state = spec.state ?? defaultState(ds, t);
  const cref = spec.charge_type_id ?? spec.charge ?? spec.charge_name;
  if (cref !== undefined && cref !== null && cref !== "") {
    const c = ds.resolve(typeof cref === "object" ? ref(cref)! : cref, ["charge"]);
    out.charge_type_id = c.id;
  }
  if (spec.mutation) out.mutation = spec.mutation;
  if (spec.spool) out.spool = spec.spool;
  return out;
}

export function resolveQty(ds: Dataset, d: any, kinds: Kind[], where: string) {
  if (typeof d === "string") {
    const m = /^(.*?)\s+x\s*(\d+)$/i.exec(d.trim());
    const t = ds.resolve(m ? m[1] : d, kinds);
    return { t, quantity: m ? Number(m[2]) : 1, spec: {} as any };
  }
  if (typeof d === "number") return { t: ds.resolve(d, kinds), quantity: 1, spec: {} as any };
  const r = ref(d);
  if (r === undefined) throw new Error(`${where}: needs type_id or name`);
  return { t: ds.resolve(r, kinds), quantity: d.quantity ?? d.count ?? 1, spec: d };
}

function ensureSkills(req: any, ctx: Ctx, input: FitInput | undefined, notes: string[]) {
  req.character ??= {};
  req.character.skills ??= {};
  const sk = req.character.skills;
  const given = input?.skills;
  if (given !== undefined) {
    if (typeof given === "number") sk.default_level = given;
    else if (typeof given === "string") {
      const p = skillPreset(given);
      if (!p) throw new Error(`unknown skill preset '${given}' (use all_0 … all_5 or a number)`);
      sk.default_level = p.default_level;
    } else {
      if (given.default_level !== undefined) sk.default_level = given.default_level;
      if (given.levels) sk.levels = { ...(sk.levels ?? {}), ...given.levels };
    }
  }
  if (sk.default_level === undefined || sk.default_level === null) {
    sk.default_level = ctx.defaultSkillLevel;
    notes.push(`no skills given: assumed every skill at level ${ctx.defaultSkillLevel}`);
  }
  if (sk.levels) {
    // skill names → ids (engines accept ids; names are a convenience)
    const lv: Record<string, number> = {};
    for (const [k, v] of Object.entries<number>(sk.levels)) {
      const t = /^\d+$/.test(k) ? ctx.ds.type(+k) : ctx.ds.resolve(k, ["skill"]);
      if (!t) throw new Error(`unknown skill id ${k}`);
      lv[String(t.id)] = v;
    }
    sk.levels = lv;
  }
}

function applyProfiles(req: any, ctx: Ctx, input: FitInput | undefined, notes: string[]) {
  const dp = input?.damage_profile;
  if (dp !== undefined) {
    if (typeof dp === "string") {
      const p = damageProfile(dp);
      if (!p) throw new Error(`unknown damage profile '${dp}' (see list_presets)`);
      req.damage_pattern = { em: p.em, thermal: p.thermal, kinetic: p.kinetic, explosive: p.explosive };
    } else req.damage_pattern = dp;
  }
  const tp = input?.target_profile;
  if (tp !== undefined) {
    if (typeof tp === "string") {
      const p = targetProfile(tp);
      if (!p) throw new Error(`unknown target profile '${tp}' (see list_presets)`);
      req.target_profile = { em: p.em, thermal: p.thermal, kinetic: p.kinetic, explosive: p.explosive, signature_radius: p.signature_radius, max_velocity: p.max_velocity, radius: p.radius ?? null };
    } else req.target_profile = "builtin" in tp ? tp : { em: 0, thermal: 0, kinetic: 0, explosive: 0, ...tp };
  }
  if (input?.implant_set) {
    const s = findImplantSet(ctx.ds, input.implant_set);
    if (!s) throw new Error(`unknown implant set '${input.implant_set}' (see list_presets kind=implant_sets)`);
    const ids = new Set<number>((req.implants ?? []).map((x: any) => (typeof x === "number" ? x : x.type_id)));
    for (const i of s.implants) ids.add(i.type_id);
    req.implants = [...ids];
    notes.push(`implant set ${s.name} added`);
  }
}

/** Lenient FitRequest (names allowed anywhere) → strict FitRequest. Recurses into projected and booster fits. */
export function resolveRequest(ctx: Ctx, fit: any, notes: string[], depth = 0, where = ""): FitRequest {
  const ds = ctx.ds;
  if (!fit || typeof fit !== "object") throw new Error(`${where || "fit"}: expected an object`);
  const req: any = JSON.parse(JSON.stringify(fit));
  req.schema_version ??= 1;
  const sref = ref(req.ship);
  if (sref === undefined) throw new Error(`${where}/ship: required (type_id or name)`);
  const ship = ds.resolve(sref, ["ship", "structure"]);
  const mode = typeof req.ship === "object" ? req.ship.mode_type_id ?? req.ship.mode : undefined;
  req.ship = { type_id: ship.id };
  if (mode !== undefined && mode !== null) req.ship.mode_type_id = typeof mode === "number" ? mode : ds.resolve(mode).id;
  req.modules = (req.modules ?? []).map((m: any, i: number) => resolveModule(ds, m, notes, `${where}/modules/${i}`));
  req.drones = (req.drones ?? []).map((d: any, i: number) => {
    const { t, quantity, spec } = resolveQty(ds, d, ["drone"], `${where}/drones/${i}`);
    const o: any = { type_id: t.id, quantity, active: spec.active ?? quantity };
    if (spec.mutation) o.mutation = spec.mutation;
    return o;
  });
  req.fighters = (req.fighters ?? []).map((d: any, i: number) => {
    const { t, quantity, spec } = resolveQty(ds, d, ["fighter"], `${where}/fighters/${i}`);
    const size = ds.attr(t, "fighterSquadronMaxSize");
    const o: any = { type_id: t.id, quantity: spec.quantity ?? size ?? quantity, active: spec.active ?? true };
    if (spec.abilities) o.abilities = spec.abilities;
    return o;
  });
  req.implants = (req.implants ?? []).map((x: any) => ds.resolve(ref(x)!, ["implant"]).id);
  req.boosters = (req.boosters ?? []).map((b: any) => {
    const t = ds.resolve(ref(b)!, ["booster", "implant"]);
    return { type_id: t.id, side_effects: (typeof b === "object" && b.side_effects) || [] };
  });
  req.cargo = (req.cargo ?? []).map((c: any, i: number) => {
    const { t, quantity } = resolveQty(ds, c, [], `${where}/cargo/${i}`);
    return { type_id: t.id, quantity };
  });
  if (Array.isArray(req.projected) && req.projected.length) {
    req.projected = req.projected.map((p: any, i: number) => {
      const w = `${where}/projected/${i}`;
      const o = { ...p };
      if (p.kind === "fit") {
        if (depth >= 1) throw new Error(`${w}: projected fits cannot nest`);
        if (!p.fit || typeof p.fit !== "object") throw new Error(`${w}/fit: expected a FitRequest`);
        o.fit = resolveRequest(ctx, p.fit, notes, depth + 1, `${w}/fit`);
        ensureSkills(o.fit, ctx, undefined, []);
      } else if (p.kind === "module") o.module = resolveModule(ds, p.module, notes, `${w}/module`);
      else if (p.kind === "drone") {
        const { t, quantity, spec } = resolveQty(ds, p.drone, ["drone"], `${w}/drone`);
        o.drone = { ...spec, type_id: t.id, quantity };
        delete o.drone.name;
      } else if (p.kind === "fighter") {
        const { t, quantity, spec } = resolveQty(ds, p.fighter, ["fighter"], `${w}/fighter`);
        // no quantity on an object = engine default (full squadron, Pyfa); only "Name xN" strings set one
        o.fighter = { ...spec, type_id: t.id };
        if (typeof p.fighter !== "object" || spec.quantity !== undefined) o.fighter.quantity = spec.quantity ?? quantity;
        delete o.fighter.name;
      }
      return o;
    });
  }
  if (Array.isArray(req.fleet?.booster_fits) && req.fleet.booster_fits.length) {
    if (depth >= 1) throw new Error(`${where}/fleet/booster_fits: booster fits cannot nest`);
    req.fleet.booster_fits = req.fleet.booster_fits.map((b: any, i: number) => {
      const r = resolveRequest(ctx, b, notes, depth + 1, `${where}/fleet/booster_fits/${i}`);
      ensureSkills(r, ctx, undefined, []);
      return r;
    });
  }
  if (req.environment?.effect_type_ids) req.environment.effect_type_ids = req.environment.effect_type_ids.map((x: any) => ds.resolve(ref(x)!).id);
  return req;
}

/** Any accepted input → normalised request. Exactly one of fit / eft / dna. */
export async function normalizeFit(ctx: Ctx, input: FitInput): Promise<Normalized> {
  const notes: string[] = [];
  const given = [input.fit !== undefined, !!input.eft, !!input.dna].filter(Boolean).length;
  if (given !== 1) throw new Error("give exactly one of `fit` (FitRequest JSON, names allowed), `eft` (EFT text) or `dna` (ship DNA)");
  let base: any;
  if (input.eft) base = await ctx.engine.eftParse(input.eft);
  else if (input.dna) base = parseDna(ctx.ds, input.dna);
  else base = typeof input.fit === "string" ? parseFitString(input.fit as string) : input.fit;
  if (base && typeof base === "object" && base.character?.skills?.default_level === null) delete base.character.skills.default_level;
  const req = resolveRequest(ctx, base, notes);
  ensureSkills(req, ctx, input, notes);
  applyProfiles(req, ctx, input, notes);
  return { request: req, notes, hash: requestHash(req) };
}

function parseFitString(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    throw new Error("`fit` is a string but not JSON; pass EFT text as `eft` or DNA as `dna`");
  }
}

export function moduleName(ds: Dataset, req: FitRequest, idx: number | null | undefined): string | null {
  if (idx === null || idx === undefined) return null;
  const m = (req as any).modules?.[idx];
  return m ? ds.type(m.type_id)?.name ?? String(m.type_id) : null;
}

export function typeName(ds: Dataset, id: number | null | undefined): string | null {
  if (id === null || id === undefined) return null;
  return ds.type(id)?.name ?? String(id);
}

export type { TypeInfo };
