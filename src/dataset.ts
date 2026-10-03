// In-process index over the same dataset-<build>.json.gz the engine uses (exct-eve-dataset v1).
// The engine computes; this index answers "what exists" questions quickly and engine-independently:
// search with category/slot/ship filters, jargon aliases and Chinese names, attribute names and units,
// required skills, ship slot layouts, compatible charges, and module candidates for the AI helpers.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

/** An Error carrying an engine contract error code (UNKNOWN_TYPE, BAD_REQUEST, ...), shown as "CODE: message". */
export const codedError = (code: string, message: string, path?: string) => Object.assign(new Error(message), { code, ...(path ? { path } : {}) });

export type Kind =
  | "ship"
  | "module"
  | "charge"
  | "drone"
  | "fighter"
  | "implant"
  | "booster"
  | "subsystem"
  | "skill"
  | "structure"
  | "structure_module";
export type Slot = "high" | "mid" | "low" | "rig" | "subsystem" | "service";

export const KINDS: Kind[] = [
  "ship",
  "module",
  "charge",
  "drone",
  "fighter",
  "implant",
  "booster",
  "subsystem",
  "skill",
  "structure",
  "structure_module",
];
export const SLOTS: Slot[] = ["high", "mid", "low", "rig", "subsystem", "service"];

const KIND_BY_CATEGORY: Record<number, Kind> = {
  6: "ship",
  7: "module",
  8: "charge",
  18: "drone",
  87: "fighter",
  20: "implant",
  32: "subsystem",
  16: "skill",
  65: "structure",
  66: "structure_module",
};

const SLOT_BY_EFFECT: Record<string, Slot> = {
  hiPower: "high",
  medPower: "mid",
  loPower: "low",
  rigSlot: "rig",
  subSystem: "subsystem",
  serviceSlot: "service",
};

export interface AttrInfo {
  id: number;
  name: string;
  display: string | null;
  unit: string | null;
  highIsGood: boolean;
  published: boolean;
  stackable: boolean;
  defaultValue: number;
}

export interface TypeInfo {
  id: number;
  name: string;
  nameZh: string | null;
  groupId: number;
  group: string;
  categoryId: number;
  category: string;
  kind: Kind | null;
  published: boolean;
  metaLevel: number;
  metaGroup: number | null;
  techLevel: number | null;
  marketGroup: number | null;
  /** SDE variationParentTypeID (the T1 base item of a meta family), null for the base itself */
  variationParent: number | null;
  slot: Slot | null;
  hardpoint: "turret" | "launcher" | null;
  mass: number;
  volume: number;
  capacity: number;
  radius: number | null;
  attrs: Record<string, number>;
  effects: [number, boolean][];
}

export interface MarketGroupInfo {
  id: number;
  name: string;
  nameZh: string | null;
  parent: number | null;
  hasTypes: boolean;
  /** child group ids / published type ids in this dataset (the dataset holds fitting-relevant types only) */
  children: number[];
  types: number[];
}

export interface SearchOptions {
  kinds?: Kind[];
  slot?: Slot;
  group?: string;
  metaMin?: number;
  metaMax?: number;
  techLevel?: number;
  fitsShip?: number;
  includeUnpublished?: boolean;
  limit?: number;
}

export interface SearchHit {
  type_id: number;
  name: string;
  name_zh: string | null;
  kind: Kind | null;
  group: string;
  category: string;
  slot: Slot | null;
  hardpoint: "turret" | "launcher" | null;
  meta_level: number;
  tech_level: number | null;
  match: "exact" | "prefix" | "word" | "substring" | "tokens" | "alias" | "fuzzy";
  score: number;
}

/** Player jargon → name fragment. Matched on whole query tokens (case-insensitive). */
export const JARGON: Record<string, string> = {
  mwd: "Microwarpdrive",
  ab: "Afterburner",
  lse: "Large Shield Extender",
  mse: "Medium Shield Extender",
  sse: "Small Shield Extender",
  dc: "Damage Control",
  dcu: "Damage Control",
  rah: "Reactive Armor Hardener",
  sebo: "Sensor Booster",
  tp: "Target Painter",
  web: "Stasis Webifier",
  scram: "Warp Scrambler",
  point: "Warp Disruptor",
  disruptor: "Warp Disruptor",
  neut: "Energy Neutralizer",
  nos: "Energy Nosferatu",
  asb: "Ancillary Shield Booster",
  aar: "Ancillary Armor Repairer",
  eanm: "Energized Adaptive Nano Membrane",
  plate: "Armor Plate",
  bcs: "Ballistic Control System",
  gyro: "Gyrostabilizer",
  magstab: "Magnetic Field Stabilizer",
  hs: "Heat Sink",
  dda: "Drone Damage Amplifier",
  te: "Tracking Enhancer",
  tc: "Tracking Computer",
  cpr: "Capacitor Power Relay",
  pdu: "Power Diagnostic System",
  pds: "Power Diagnostic System",
  rcu: "Reactor Control Unit",
  copro: "Co-Processor",
  nano: "Nanofiber Internal Structure",
  ists: "Inertial Stabilizers",
  istab: "Inertial Stabilizers",
  od: "Overdrive Injector System",
  capbooster: "Capacitor Booster",
  mjd: "Micro Jump Drive",
  damp: "Remote Sensor Dampener",
  td: "Tracking Disruptor",
  gd: "Guidance Disruptor",
  sar: "Small Armor Repairer",
  mar: "Medium Armor Repairer",
  lar: "Large Armor Repairer",
  ssb: "Small Shield Booster",
  msb: "Medium Shield Booster",
  lsb: "Large Shield Booster",
  xlsb: "X-Large Shield Booster",
  xlasb: "X-Large Ancillary Shield Booster",
  invul: "Multispectrum Shield Hardener",
  invuln: "Multispectrum Shield Hardener",
  ccc: "Capacitor Control Circuit",
  trimark: "Trimark Armor Pump",
  bdc: "Bulkhead",
  lsa: "Cargohold Optimization",
  ecm: "ECM",
  cloak: "Cloaking Device",
  cyno: "Cynosural Field Generator",
  hyperspatial: "Hyperspatial Velocity Optimizer",
  polycarb: "Polycarbon Engine Housing",
  sbu: "Shield Boost Amplifier",
  cdfe: "Core Defense Field Extender",
  ewar: "ECM",
};

const SKILL_ATTRS: [string, string][] = [
  ["requiredSkill1", "requiredSkill1Level"],
  ["requiredSkill2", "requiredSkill2Level"],
  ["requiredSkill3", "requiredSkill3Level"],
  ["requiredSkill4", "requiredSkill4Level"],
  ["requiredSkill5", "requiredSkill5Level"],
  ["requiredSkill6", "requiredSkill6Level"],
];

export function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[’'`´"]/g, "")
    .replace(/[-_/,.()[\]]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function lev(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

interface RawTrait {
  bonus: number | null;
  importance?: number;
  text: string;
  text_zh?: string | null;
  unit: number | null;
}
interface RawTraits {
  role?: RawTrait[];
  skills?: Record<string, RawTrait[]>;
  misc?: RawTrait[];
}
export interface TraitLine {
  bonus: number | null;
  unit: string | null;
  text: string;
  text_zh: string | null;
  /** e.g. "5% bonus to Medium Hybrid Turret damage" */
  line: string;
}
export interface ShipTraits {
  role: TraitLine[];
  skills: { skill_id: number; skill: string; per_level: TraitLine[] }[];
  misc: TraitLine[];
}
const stripTags = (s: string) => s.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();

export class Dataset {
  readonly path: string;
  /** sha256 of the file as given (gz) */
  readonly sha256: string;
  /** sha256 of the decompressed JSON (what engines report as meta.dataset_sha256) */
  readonly jsonSha256: string;
  readonly sdeBuild: number | null;
  readonly format: string;
  readonly types = new Map<number, TypeInfo>();
  readonly attrs = new Map<number, AttrInfo>();
  readonly attrByName = new Map<string, AttrInfo>();
  readonly effectNames = new Map<number, string>();
  readonly effectCategory = new Map<number, number>();
  readonly groups = new Map<number, { name: string; category: number }>();
  readonly categories = new Map<number, string>();
  readonly dbuffs = new Map<number, string>();
  /** Market-group tree (pipeline `market_groups`, r4+); empty for older datasets. */
  readonly marketGroups = new Map<number, MarketGroupInfo>();
  readonly metaGroups = new Map<number, { name: string; nameZh: string | null }>();
  /** Ship bonus text (pipeline `traits`, r5+): role / per-skill / misc bonus lines; empty for older datasets. */
  readonly traits = new Map<number, RawTraits>();
  /** Dogma unit id -> display suffix (pipeline `units`, r5+). */
  readonly units = new Map<number, string>();
  private byName = new Map<string, TypeInfo>();
  private normNames: { t: TypeInfo; en: string; zh: string }[] = [];
  readonly loadMs: number;

  constructor(path: string) {
    const t0 = performance.now();
    this.path = path;
    const raw = readFileSync(path);
    this.sha256 = createHash("sha256").update(raw).digest("hex");
    const plain = path.endsWith(".gz") ? gunzipSync(raw) : raw;
    this.jsonSha256 = path.endsWith(".gz") ? createHash("sha256").update(plain).digest("hex") : this.sha256;
    const json = plain.toString("utf8");
    const d = JSON.parse(json);
    this.format = `${d.format ?? "?"} v${d.format_version ?? "?"}`;
    this.sdeBuild = d.sde?.build ?? null;
    for (const [id, c] of Object.entries<any>(d.categories ?? {})) this.categories.set(+id, c.name);
    for (const [id, g] of Object.entries<any>(d.groups ?? {})) this.groups.set(+id, { name: g.name, category: g.category });
    for (const [id, e] of Object.entries<any>(d.effects ?? {})) {
      this.effectNames.set(+id, e.name);
      this.effectCategory.set(+id, e.category ?? 0);
    }
    for (const [id, b] of Object.entries<any>(d.dbuffs ?? {})) this.dbuffs.set(+id, b.name);
    const zhI18n = d.names_i18n?.zh ?? {};
    for (const [id, g] of Object.entries<any>(d.market_groups ?? {}))
      this.marketGroups.set(+id, { id: +id, name: g.name, nameZh: zhI18n.market_groups?.[id] ?? null, parent: g.parent ?? null, hasTypes: !!g.has_types, children: [], types: [] });
    for (const [id, g] of Object.entries<any>(d.meta_groups ?? {})) this.metaGroups.set(+id, { name: g.name, nameZh: zhI18n.meta_groups?.[id] ?? null });
    for (const [id, a] of Object.entries<any>(d.attributes ?? {})) {
      const info: AttrInfo = {
        id: +id,
        name: a.name,
        display: a.display ?? null,
        unit: a.unit ?? null,
        highIsGood: !!a.high_is_good,
        published: !!a.published,
        stackable: !!a.stackable,
        defaultValue: a.default ?? 0,
      };
      this.attrs.set(+id, info);
      this.attrByName.set(a.name, info);
    }
    const zh: Record<string, string> = d.names?.zh ?? {};
    const turret = this.effectId("turretFitted");
    const launcher = this.effectId("launcherFitted");
    for (const [id, t] of Object.entries<any>(d.types ?? {})) {
      const g = this.groups.get(t.group);
      const cat = t.category ?? g?.category ?? -1;
      let slot: Slot | null = null;
      let hardpoint: TypeInfo["hardpoint"] = null;
      const effects: [number, boolean][] = (t.effects ?? []).map((e: [number, number]) => [e[0], !!e[1]]);
      for (const [eid] of effects) {
        const s = SLOT_BY_EFFECT[this.effectNames.get(eid) ?? ""];
        if (s) slot = s;
        if (eid === turret) hardpoint = "turret";
        if (eid === launcher) hardpoint = "launcher";
      }
      let kind: Kind | null = KIND_BY_CATEGORY[cat] ?? null;
      const groupName = g?.name ?? String(t.group);
      if (kind === "implant" && /booster/i.test(groupName)) kind = "booster";
      const info: TypeInfo = {
        id: +id,
        name: t.name,
        nameZh: zh[id] ?? null,
        groupId: t.group,
        group: groupName,
        categoryId: cat,
        category: this.categories.get(cat) ?? String(cat),
        kind,
        published: !!t.published,
        metaLevel: t.meta_level ?? 0,
        metaGroup: t.meta_group ?? null,
        techLevel: t.tech_level ?? null,
        marketGroup: t.market_group ?? null,
        variationParent: t.variation_parent ?? null,
        slot,
        hardpoint,
        mass: t.mass ?? 0,
        volume: t.volume ?? 0,
        capacity: t.capacity ?? 0,
        radius: t.radius ?? null,
        attrs: t.attrs ?? {},
        effects,
      };
      this.types.set(info.id, info);
      const key = norm(info.name);
      const prev = this.byName.get(key);
      if (!prev || (!prev.published && info.published)) this.byName.set(key, info);
      if (info.nameZh) {
        const kz = norm(info.nameZh);
        if (!this.byName.has(kz)) this.byName.set(kz, info);
      }
      this.normNames.push({ t: info, en: key, zh: info.nameZh ? norm(info.nameZh) : "" });
    }
    this.normNames.sort((a, b) => a.t.id - b.t.id);
    for (const g of this.marketGroups.values()) if (g.parent !== null) this.marketGroups.get(g.parent)?.children.push(g.id);
    for (const t of this.types.values()) if (t.published && t.marketGroup !== null) this.marketGroups.get(t.marketGroup)?.types.push(t.id);
    for (const [id, u] of Object.entries<any>(d.units ?? {})) if (u?.display) this.units.set(+id, u.display);
    for (const [id, tr] of Object.entries<any>(d.traits ?? {})) this.traits.set(+id, tr);
    this.loadMs = performance.now() - t0;
  }

  /** Ship traits (Pyfa / show-info "Traits"): role bonuses, bonuses per level of each hull skill, misc lines. */
  shipTraits(t: TypeInfo): ShipTraits | null {
    const tr = this.traits.get(t.id);
    if (!tr) return null;
    const lines = (xs: RawTrait[] | undefined): TraitLine[] =>
      [...(xs ?? [])].sort((a, b) => (a.importance ?? 0) - (b.importance ?? 0)).map((x) => {
        const text = stripTags(x.text ?? "");
        const unit = x.unit !== null && x.unit !== undefined ? this.units.get(x.unit) ?? "" : "";
        const amount = x.bonus === null || x.bonus === undefined ? "" : `${+x.bonus}${unit === "%" ? "%" : unit ? ` ${unit}` : ""} `;
        return { bonus: x.bonus ?? null, unit: unit || null, text, text_zh: x.text_zh ? stripTags(x.text_zh) : null, line: `${amount}${text}` };
      });
    return {
      role: lines(tr.role),
      skills: Object.entries(tr.skills ?? {}).map(([sid, xs]) => ({ skill_id: +sid, skill: this.type(+sid)?.name ?? sid, per_level: lines(xs) })),
      misc: lines(tr.misc),
    };
  }

  /** Does an engine-reported dataset hash refer to this file? (engines hash either the gz file or the JSON) */
  sameDataset(sha?: string): boolean | null {
    if (!sha) return null;
    return sha === this.sha256 || sha === this.jsonSha256;
  }

  effectId(name: string): number | undefined {
    for (const [id, n] of this.effectNames) if (n === name) return id;
    return undefined;
  }

  attrId(name: string): number | undefined {
    return this.attrByName.get(name)?.id;
  }

  /** Base (unmodified) attribute value by name; undefined when the type does not carry it. */
  attr(t: TypeInfo, name: string): number | undefined {
    const id = this.attrId(name);
    if (id === undefined) return undefined;
    return t.attrs[String(id)];
  }

  type(id: number): TypeInfo | undefined {
    return this.types.get(id);
  }

  /** Exact (normalised, en or zh) name lookup. */
  byExactName(name: string): TypeInfo | undefined {
    return this.byName.get(norm(name));
  }

  /** id, numeric string, or name → type; throws an actionable error with suggestions. */
  resolve(ref: number | string, want?: Kind[]): TypeInfo {
    if (typeof ref === "number" || /^\d+$/.test(String(ref).trim())) {
      const t = this.types.get(Number(ref));
      if (!t) throw codedError("UNKNOWN_TYPE", `unknown type id ${ref}`);
      return t;
    }
    const s = String(ref).trim();
    const exact = this.byExactName(s);
    if (exact && (!want || (exact.kind && want.includes(exact.kind)))) return exact;
    const hits = this.search(s, { kinds: want, limit: 5 });
    if (hits.length && (hits[0].match === "alias" || hits[0].match === "exact")) return this.types.get(hits[0].type_id)!;
    const what = want ? want.join("/") : "type";
    if (exact) throw codedError("BAD_REQUEST", `'${s}' is a ${exact.kind ?? exact.category}, expected ${what}`);
    const sugg = hits.map((h) => `'${h.name}' (${h.type_id})`).join(", ");
    throw codedError("UNKNOWN_TYPE", `no ${what} named '${s}'${sugg ? `; did you mean ${sugg}?` : ""}`);
  }

  private expandAliases(q: string): string | null {
    const toks = q.split(" ");
    let changed = false;
    const out = toks.map((t) => {
      const a = JARGON[t];
      if (a) {
        changed = true;
        return norm(a);
      }
      return t;
    });
    return changed ? out.join(" ") : null;
  }

  search(query: string, o: SearchOptions = {}): SearchHit[] {
    const q = norm(query);
    const limit = Math.min(Math.max(o.limit ?? 20, 1), 200);
    const alias = this.expandAliases(q);
    const qTokens = q.split(" ").filter(Boolean);
    const aTokens = alias ? alias.split(" ").filter(Boolean) : [];
    const fitShip = o.fitsShip !== undefined ? this.types.get(o.fitsShip) : undefined;
    const groupQ = o.group ? norm(o.group) : null;
    const hits: { t: TypeInfo; score: number; match: SearchHit["match"] }[] = [];
    const fuzzy: { t: TypeInfo; d: number }[] = [];
    for (const { t, en, zh } of this.normNames) {
      if (!o.includeUnpublished && !t.published) continue;
      if (o.kinds?.length ? !t.kind || !o.kinds.includes(t.kind) : !t.kind) continue;
      if (o.slot && t.slot !== o.slot) continue;
      if (groupQ && !norm(t.group).includes(groupQ)) continue;
      if (o.metaMin !== undefined && t.metaLevel < o.metaMin) continue;
      if (o.metaMax !== undefined && t.metaLevel > o.metaMax) continue;
      if (o.techLevel !== undefined && t.techLevel !== o.techLevel) continue;
      if (fitShip && !this.canFit(t, fitShip).ok) continue;
      if (!q) {
        hits.push({ t, score: 1, match: "substring" });
        continue;
      }
      let score = 0;
      let match: SearchHit["match"] = "substring";
      for (const name of zh ? [en, zh] : [en]) {
        let s = 0;
        let m: SearchHit["match"] = "substring";
        if (name === q) [s, m] = [1000, "exact"];
        else if (name.startsWith(q)) [s, m] = [800, "prefix"];
        else if (alias && (name === alias || name.startsWith(alias) || (" " + name).includes(" " + alias))) [s, m] = [name === alias ? 900 : 700, "alias"];
        else if ((" " + name).includes(" " + q)) [s, m] = [650, "word"];
        else if (name.includes(q)) [s, m] = [500, "substring"];
        else if (qTokens.length > 1 && qTokens.every((x) => name.includes(x))) [s, m] = [300, "tokens"];
        else if (aTokens.length > 1 && aTokens.every((x) => name.includes(x))) [s, m] = [280, "tokens"];
        if (s > score) [score, match] = [s, m];
      }
      if (score) {
        // shorter names first within a band (a query "Damage Control" prefers "Damage Control II" over
        // "Damage Control Burst Charge"), then meta level, then type id
        hits.push({ t, score: score - Math.min(en.length, 99) / 100, match });
      } else if (q.length >= 4 && fuzzy.length < 2000) {
        const d = lev(q, en.slice(0, q.length + 2), 2);
        if (d <= 2) fuzzy.push({ t, d });
      }
    }
    if (!hits.length && fuzzy.length) {
      fuzzy.sort((a, b) => a.d - b.d || a.t.name.length - b.t.name.length || a.t.id - b.t.id);
      for (const f of fuzzy.slice(0, limit)) hits.push({ t: f.t, score: 100 - f.d * 10, match: "fuzzy" });
    }
    hits.sort((a, b) => b.score - a.score || a.t.metaLevel - b.t.metaLevel || a.t.id - b.t.id);
    return hits.slice(0, limit).map(({ t, score, match }) => this.hit(t, match, score));
  }

  hit(t: TypeInfo, match: SearchHit["match"] = "exact", score = 0): SearchHit {
    return {
      type_id: t.id,
      name: t.name,
      name_zh: t.nameZh,
      kind: t.kind,
      group: t.group,
      category: t.category,
      slot: t.slot,
      hardpoint: t.hardpoint,
      meta_level: t.metaLevel,
      tech_level: t.techLevel,
      match,
      score: Math.round(score * 100) / 100,
    };
  }

  requiredSkills(t: TypeInfo): { skill_id: number; skill: string; level: number }[] {
    const out: { skill_id: number; skill: string; level: number }[] = [];
    for (const [s, l] of SKILL_ATTRS) {
      const sid = this.attr(t, s);
      if (!sid) continue;
      out.push({ skill_id: sid, skill: this.types.get(sid)?.name ?? String(sid), level: this.attr(t, l) ?? 1 });
    }
    return out;
  }

  /** Transitive skill requirements (max level per skill), prerequisites included. */
  skillTree(t: TypeInfo): Map<number, number> {
    const need = new Map<number, number>();
    const visit = (x: TypeInfo, depth: number) => {
      if (depth > 12) return;
      for (const r of this.requiredSkills(x)) {
        if ((need.get(r.skill_id) ?? 0) < r.level) need.set(r.skill_id, r.level);
        const st = this.types.get(r.skill_id);
        if (st) visit(st, depth + 1);
      }
    };
    visit(t, 0);
    return need;
  }

  shipLayout(ship: TypeInfo) {
    const a = (n: string) => this.attr(ship, n) ?? 0;
    return {
      slots: {
        high: a("hiSlots"),
        mid: a("medSlots"),
        low: a("lowSlots"),
        rig: a("rigSlots"),
        subsystem: ship.groupId && this.isT3C(ship) ? 4 : 0,
        service: a("serviceSlots"),
      },
      hardpoints: { turret: a("turretSlotsLeft"), launcher: a("launcherSlotsLeft") },
      rig_size: this.attr(ship, "rigSize") ?? null,
      resources: {
        cpu: a("cpuOutput"),
        power: a("powerOutput"),
        calibration: a("upgradeCapacity"),
        drone_bandwidth: a("droneBandwidth"),
        drone_bay_m3: a("droneCapacity"),
        cargo_m3: ship.capacity,
      },
      fighter_tubes: a("fighterTubes"),
    };
  }

  isT3C(ship: TypeInfo): boolean {
    return ship.group === "Strategic Cruiser";
  }

  /** Static fit check (ship restrictions, rig size, slot/hardpoint presence). The engine has the final word. */
  canFit(mod: TypeInfo, ship: TypeInfo): { ok: boolean; reason?: string } {
    if (mod.kind === "drone") return (this.attr(ship, "droneCapacity") ?? 0) > 0 ? { ok: true } : { ok: false, reason: "ship has no drone bay" };
    if (mod.kind === "fighter") return (this.attr(ship, "fighterTubes") ?? 0) > 0 ? { ok: true } : { ok: false, reason: "ship has no fighter tubes" };
    if (mod.kind !== "module" && mod.kind !== "subsystem" && mod.kind !== "structure_module") return { ok: true };
    const groups: number[] = [];
    const types: number[] = [];
    for (let i = 1; i <= 20; i++) {
      const g = this.attr(mod, `canFitShipGroup${String(i).padStart(2, "0")}`);
      if (g) groups.push(g);
    }
    for (let i = 1; i <= 12; i++) {
      const t = this.attr(mod, `canFitShipType${i}`);
      if (t) types.push(t);
    }
    if ((groups.length || types.length) && !groups.includes(ship.groupId) && !types.includes(ship.id))
      return { ok: false, reason: `${mod.name} can only be fitted to specific ships` };
    const lay = this.shipLayout(ship);
    if (mod.slot && mod.slot !== "subsystem" && (lay.slots as any)[mod.slot] <= 0 && !this.isT3C(ship))
      return { ok: false, reason: `${ship.name} has no ${mod.slot} slots` };
    if (mod.slot === "subsystem") {
      const fits = this.attr(mod, "fitsToShipType");
      if (fits && fits !== ship.id) return { ok: false, reason: `${mod.name} is for another strategic cruiser` };
      if (!this.isT3C(ship)) return { ok: false, reason: `${ship.name} takes no subsystems` };
    }
    if (mod.slot === "rig") {
      const rs = this.attr(mod, "rigSize");
      if (rs !== undefined && lay.rig_size !== null && rs !== lay.rig_size) return { ok: false, reason: `rig size ${rs} ≠ ship rig size ${lay.rig_size}` };
    }
    if (mod.hardpoint && (lay.hardpoints as any)[mod.hardpoint] <= 0 && !this.isT3C(ship))
      return { ok: false, reason: `${ship.name} has no ${mod.hardpoint} hardpoints` };
    return { ok: true };
  }

  /** Charges a module can load (charge group + size + capacity, like the client). */
  compatibleCharges(mod: TypeInfo, limit = 200): TypeInfo[] {
    const groups = new Set<number>();
    for (let i = 1; i <= 5; i++) {
      const g = this.attr(mod, `chargeGroup${i}`);
      if (g) groups.add(g);
    }
    if (!groups.size) return [];
    const size = this.attr(mod, "chargeSize");
    const out: TypeInfo[] = [];
    for (const t of this.types.values()) {
      if (!t.published || !groups.has(t.groupId)) continue;
      const cs = this.attr(t, "chargeSize");
      if (size !== undefined && cs !== undefined && cs !== size) continue;
      if (mod.capacity > 0 && t.volume > mod.capacity) continue;
      out.push(t);
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out.slice(0, limit);
  }

  /** Published skills (category 16). */
  skills(): TypeInfo[] {
    return [...this.types.values()].filter((t) => t.kind === "skill" && t.published).sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
  }

  /** Named attribute map with units: { name: {id, value, unit, display} }. */
  namedAttrs(t: TypeInfo, opts: { publishedOnly?: boolean } = {}) {
    const out: Record<string, { id: number; value: number; unit: string | null; display: string | null }> = {};
    for (const [id, v] of Object.entries(t.attrs)) {
      const a = this.attrs.get(+id);
      if (opts.publishedOnly && a && !a.published) continue;
      out[a?.name ?? id] = { id: +id, value: v, unit: a?.unit ?? null, display: a?.display ?? null };
    }
    return out;
  }
}
