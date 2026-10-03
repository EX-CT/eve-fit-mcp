// Named metrics over FitStats: the vocabulary shared by summaries, compare_fits, what_if, suggest/optimise goals.
import type { FitStats } from "./adapters/types.js";

export interface Metric {
  key: string;
  label: string;
  unit: string;
  /** +1: bigger is better, -1: smaller is better, 0: neutral. */
  better: 1 | -1 | 0;
  get: (s: FitStats) => number | null;
  group: string;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const path = (s: any, p: string): unknown => p.split(".").reduce((o, k) => (o == null ? undefined : o[k]), s);
const P = (p: string) => (s: FitStats) => num(path(s, p));
const sum = (o: any, keys: string[]) => (o ? keys.reduce((a, k) => a + (num(o[k]) ?? 0), 0) : null);
const TANK = ["passive_shield", "shield_repair", "armor_repair", "hull_repair"];
const ACTIVE = ["shield_repair", "armor_repair", "hull_repair"];
const avgResist = (layer: string) => (s: FitStats) => {
  const r = path(s, `defense.resonance.${layer}`) as any;
  if (!r) return null;
  const v = ["em", "thermal", "kinetic", "explosive"].map((k) => num(r[k]) ?? 1);
  return 100 * (1 - v.reduce((a, b) => a + b, 0) / 4);
};
const free = (k: string) => (s: FitStats) => {
  const r = path(s, `resources.${k}`) as any;
  return r ? (num(r.total) ?? 0) - (num(r.used) ?? 0) : null;
};

export const METRICS: Metric[] = [
  { key: "dps", label: "DPS (total)", unit: "HP/s", better: 1, group: "offense", get: P("offense.total.dps.total") },
  { key: "volley", label: "Volley (total)", unit: "HP", better: 1, group: "offense", get: P("offense.total.volley.total") },
  { key: "weapon_dps", label: "Weapon DPS", unit: "HP/s", better: 1, group: "offense", get: P("offense.total.weapon_dps") },
  { key: "drone_dps", label: "Drone DPS", unit: "HP/s", better: 1, group: "offense", get: P("offense.total.drone_dps") },
  { key: "fighter_dps", label: "Fighter DPS", unit: "HP/s", better: 1, group: "offense", get: P("offense.total.fighter_dps") },
  { key: "applied_dps", label: "DPS vs target profile", unit: "HP/s", better: 1, group: "offense", get: P("offense.vs_target_profile.dps") },
  {
    key: "weapon_range",
    label: "Longest weapon optimal+falloff",
    unit: "m",
    better: 1,
    group: "offense",
    get: (s) => {
      const w: any[] = (s as any).offense?.weapons ?? [];
      let best: number | null = null;
      for (const x of w) {
        const r = (num(x.optimal_m) ?? num(x.range_m) ?? 0) + (num(x.falloff_m) ?? 0);
        if (r > (best ?? -1)) best = r;
      }
      return best;
    },
  },
  { key: "ehp", label: "EHP (total)", unit: "HP", better: 1, group: "defense", get: P("defense.ehp.total") },
  { key: "shield_ehp", label: "Shield EHP", unit: "HP", better: 1, group: "defense", get: P("defense.ehp.shield") },
  { key: "armor_ehp", label: "Armor EHP", unit: "HP", better: 1, group: "defense", get: P("defense.ehp.armor") },
  { key: "hull_ehp", label: "Hull EHP", unit: "HP", better: 1, group: "defense", get: P("defense.ehp.hull") },
  { key: "hp", label: "Raw HP (total)", unit: "HP", better: 1, group: "defense", get: P("defense.hp.total") },
  { key: "shield_resist", label: "Avg shield resist", unit: "%", better: 1, group: "defense", get: avgResist("shield") },
  { key: "armor_resist", label: "Avg armor resist", unit: "%", better: 1, group: "defense", get: avgResist("armor") },
  { key: "hull_resist", label: "Avg hull resist", unit: "%", better: 1, group: "defense", get: avgResist("hull") },
  {
    key: "tank",
    label: "Sustained effective tank (incl. passive)",
    unit: "EHP/s",
    better: 1,
    group: "defense",
    get: (s: any) => sum(s.defense?.tank?.sustained_effective ?? s.defense?.tank?.effective, TANK),
  },
  {
    key: "active_tank",
    label: "Sustained effective active repair",
    unit: "EHP/s",
    better: 1,
    group: "defense",
    get: (s: any) => sum(s.defense?.tank?.sustained_effective ?? s.defense?.tank?.effective, ACTIVE),
  },
  { key: "burst_tank", label: "Effective tank (cap ignored)", unit: "EHP/s", better: 1, group: "defense", get: (s: any) => sum(s.defense?.tank?.effective, TANK) },
  { key: "cap_delta", label: "Cap delta (avg)", unit: "GJ/s", better: 1, group: "capacitor", get: P("capacitor.delta_gj_s") },
  {
    key: "cap_stability",
    label: "Cap: stable % (stable) or -seconds to empty",
    unit: "score",
    better: 1,
    group: "capacitor",
    get: (s: any) => {
      const c = s.capacitor;
      if (!c) return null;
      if (c.stable) return num(c.stable_percent) ?? 100;
      const t = num(c.depletes_in_s);
      return t === null ? null : -10000 / Math.max(t, 1);
    },
  },
  { key: "cap_stable_percent", label: "Cap stable at", unit: "%", better: 1, group: "capacitor", get: (s: any) => (s.capacitor?.stable ? num(s.capacitor.stable_percent) : null) },
  { key: "cap_lasts_s", label: "Cap lasts", unit: "s", better: 1, group: "capacitor", get: (s: any) => (s.capacitor?.stable ? null : num(s.capacitor?.depletes_in_s)) },
  { key: "speed", label: "Max velocity", unit: "m/s", better: 1, group: "navigation", get: P("navigation.max_velocity") },
  { key: "align", label: "Align time", unit: "s", better: -1, group: "navigation", get: P("navigation.align_time_s") },
  { key: "signature", label: "Signature radius", unit: "m", better: -1, group: "navigation", get: P("navigation.signature_radius") },
  { key: "warp_speed", label: "Warp speed", unit: "AU/s", better: 1, group: "navigation", get: P("navigation.warp_speed_au_s") },
  { key: "mass", label: "Mass", unit: "kg", better: 0, group: "navigation", get: P("navigation.mass") },
  { key: "lock_range", label: "Targeting range", unit: "m", better: 1, group: "targeting", get: P("targeting.max_range_m") },
  { key: "scan_resolution", label: "Scan resolution", unit: "mm", better: 1, group: "targeting", get: P("targeting.scan_resolution") },
  { key: "sensor_strength", label: "Sensor strength", unit: "points", better: 1, group: "targeting", get: P("targeting.sensor_strength") },
  { key: "max_targets", label: "Max locked targets", unit: "", better: 1, group: "targeting", get: P("targeting.max_targets") },
  { key: "cpu_free", label: "CPU left", unit: "tf", better: 1, group: "fitting", get: free("cpu") },
  { key: "power_free", label: "Powergrid left", unit: "MW", better: 1, group: "fitting", get: free("power") },
  { key: "calibration_free", label: "Calibration left", unit: "", better: 1, group: "fitting", get: free("calibration") },
  { key: "probe_size", label: "Probe size (sig / sensor strength)", unit: "", better: -1, group: "targeting", get: P("targeting.probe_size") },
  { key: "mining_yield", label: "Mining yield (modules + drones)", unit: "m3/s", better: 1, group: "mining", get: P("mining.total_m3_s") },
  { key: "mining_modules", label: "Mining yield (modules)", unit: "m3/s", better: 1, group: "mining", get: P("mining.modules_m3_s") },
  { key: "mining_drones", label: "Mining yield (drones)", unit: "m3/s", better: 1, group: "mining", get: P("mining.drones_m3_s") },
  { key: "remote_rep", label: "Outgoing remote repair (shield+armor+hull)", unit: "HP/s", better: 1, group: "remote", get: (s: any) => sum(s.outgoing?.current, ["shield_per_s", "armor_per_s", "hull_per_s"]) },
  { key: "remote_shield_rep", label: "Outgoing remote shield repair", unit: "HP/s", better: 1, group: "remote", get: P("outgoing.current.shield_per_s") },
  { key: "remote_armor_rep", label: "Outgoing remote armor repair", unit: "HP/s", better: 1, group: "remote", get: P("outgoing.current.armor_per_s") },
  { key: "remote_hull_rep", label: "Outgoing remote hull repair", unit: "HP/s", better: 1, group: "remote", get: P("outgoing.current.hull_per_s") },
  { key: "remote_rep_spooled", label: "Outgoing remote repair at full spool", unit: "HP/s", better: 1, group: "remote", get: (s: any) => sum(s.outgoing?.spool_max, ["shield_per_s", "armor_per_s", "hull_per_s"]) },
  { key: "cap_transfer", label: "Outgoing capacitor transfer", unit: "GJ/s", better: 1, group: "remote", get: P("outgoing.current.capacitor_per_s") },
  {
    key: "bombs_to_kill",
    label: "Fewest bombs to kill (best bomb type, Covert Ops V)",
    unit: "bombs",
    better: 1,
    group: "defense",
    get: (s: any) => {
      const b = s.bombing;
      if (!b) return null;
      const v = ["em", "thermal", "kinetic", "explosive"].map((k) => num(b[k]?.covert_ops_5)).filter((x): x is number => x !== null);
      return v.length ? Math.min(...v) : null;
    },
  },
  {
    key: "heat_burnout_s",
    label: "First overheated module burns out after",
    unit: "s",
    better: 1,
    group: "heat",
    get: (s: any) => {
      const v = ((s.modules ?? []) as any[]).map((m) => num(m?.heat?.burnout_s)).filter((x): x is number => x !== null);
      return v.length ? Math.min(...v) : null;
    },
  },
  { key: "drone_control_range", label: "Drone control range", unit: "m", better: 1, group: "drones", get: P("drones.control_range_m") },
  { key: "violations", label: "Fitting violations", unit: "", better: -1, group: "fitting", get: (s: any) => (Array.isArray(s.violations) ? s.violations.length : 0) },
];

export const METRIC_KEYS = METRICS.map((m) => m.key) as [string, ...string[]];
const BY_KEY = new Map(METRICS.map((m) => [m.key, m]));

export function metric(key: string): Metric {
  const m = BY_KEY.get(key);
  if (!m) throw new Error(`unknown metric '${key}'; known: ${METRIC_KEYS.join(", ")}`);
  return m;
}

export const DEFAULT_COMPARE = ["dps", "volley", "applied_dps", "ehp", "tank", "cap_stability", "speed", "align", "signature", "lock_range", "scan_resolution", "cpu_free", "power_free", "violations"];

export function round(v: number | null, d = 3): number | null {
  if (v === null) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

/** Goal = weighted sum of metrics (each normalised by the baseline so units don't matter). */
export interface Goal {
  metric: string;
  weight?: number;
}

export function goalScore(goals: Goal[], s: FitStats, base: FitStats): number {
  let score = 0;
  for (const g of goals) {
    const m = metric(g.metric);
    const v = m.get(s) ?? 0;
    const b = m.get(base) ?? 0;
    const scale = Math.max(Math.abs(b), 1e-9) || 1;
    const dir = m.better === 0 ? 1 : m.better;
    score += (g.weight ?? 1) * dir * ((v - b) / (Math.abs(b) > 1e-9 ? scale : 1));
  }
  return score;
}
