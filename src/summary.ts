// Compact, AI-friendly views of FitStats (full stats stay available via sections / detail=full).
import type { FitRequest, FitStats } from "./adapters/types.js";
import type { Dataset } from "./dataset.js";
import { METRICS, round } from "./metrics.js";

export const SECTIONS = ["meta", "ship", "resources", "modules", "offense", "defense", "capacitor", "navigation", "targeting", "drones", "fighters", "mining", "outgoing", "bombing", "violations", "warnings", "attributes", "price", "provenance"] as const;

const r1 = (v: unknown, d = 2) => (typeof v === "number" && Number.isFinite(v) ? round(v, d) : v ?? null);
const pct = (res: any) =>
  res ? Object.fromEntries(["em", "thermal", "kinetic", "explosive"].map((k) => [k, typeof res[k] === "number" ? round(100 * (1 - res[k]), 1) : null])) : null;
const ur = (o: any) => (o ? { used: r1(o.used), total: r1(o.total) } : null);

export function describeViolations(ds: Dataset, req: FitRequest, stats: FitStats) {
  const mods: any[] = (req as any).modules ?? [];
  return ((stats as any).violations ?? []).map((v: any) => {
    const m = v.module_index !== null && v.module_index !== undefined ? mods[v.module_index] : undefined;
    const t = m ? ds.type(m.type_id) : undefined;
    const skill = typeof v.skill_type_id === "number" ? ds.type(v.skill_type_id)?.name ?? null : undefined;
    return { ...v, module: t?.name ?? null, ...(skill !== undefined ? { skill } : {}), hint: hintFor(v.code, t?.name, t?.slot, skill ?? undefined, v.level) };
  });
}

function hintFor(code: string, name?: string, slot?: string | null, skill?: string, level?: number): string | undefined {
  switch (code) {
    case "CPU_OVERLOAD":
      return "drop or downgrade a CPU-heavy module, or fit a Co-Processor / CPU rig";
    case "POWER_OVERLOAD":
      return "use smaller weapons/plates/extenders, or fit a Reactor Control Unit / Power Diagnostic System / Ancillary Current Router rig";
    case "CALIBRATION_OVERLOAD":
      return "rigs need more calibration than the hull has: use T1 rigs or fewer rigs";
    case "SLOTS_EXCEEDED":
      return `more ${slot ?? ""} modules than ${slot ?? ""} slots; remove one`;
    case "TURRET_HARDPOINTS":
    case "LAUNCHER_HARDPOINTS":
      return "more weapons than hardpoints; remove one or use the other weapon system";
    case "RIG_SIZE":
      return `${name ?? "rig"} is the wrong size for this hull; search with fits_ship to get the right size`;
    case "SHIP_RESTRICTION":
    case "NOT_FITTABLE":
      return `${name ?? "module"} cannot be fitted to this hull; search_types with fits_ship lists modules that can`;
    case "DRONE_BANDWIDTH":
      return "lower the active drone count or use smaller drones";
    case "MISSING_SKILL":
      return skill ? `train ${skill}${level ? ` to ${level}` : ""} (skill_requirements lists the whole plan)` : "skill_requirements lists what to train";
    case "MAX_GROUP_FITTED":
    case "MAX_TYPE_FITTED":
      return `only a limited number of ${name ?? "this module"} can be fitted; remove the extra ones`;
    case "MAX_GROUP_ONLINE":
    case "MAX_GROUP_ACTIVE":
      return `only one module of this group can be ${code === "MAX_GROUP_ONLINE" ? "online" : "active"} at a time; set the others offline/online`;
    case "CHARGE_GROUP":
    case "CHARGE_SIZE":
    case "CHARGE_CAPACITY":
      return `wrong ammo for ${name ?? "the module"}; get_type on the module lists compatible charges`;
    default:
      return undefined;
  }
}

/** One screen of the numbers people look at first. */
export function summarize(ds: Dataset, req: FitRequest, s: FitStats) {
  const st: any = s;
  const metrics: Record<string, number | null> = {};
  for (const m of METRICS) metrics[m.key] = round(m.get(s), 3);
  const cap = st.capacitor ?? {};
  return {
    ship: st.ship,
    offense: st.offense
      ? {
          dps: r1(st.offense.total?.dps?.total),
          volley: r1(st.offense.total?.volley?.total),
          weapon_dps: r1(st.offense.total?.weapon_dps),
          drone_dps: r1(st.offense.total?.drone_dps),
          fighter_dps: r1(st.offense.total?.fighter_dps),
          dps_by_type: st.offense.total?.dps ? Object.fromEntries(Object.entries<any>(st.offense.total.dps).map(([k, v]) => [k, r1(v)])) : null,
          vs_target_profile: st.offense.vs_target_profile ?? null,
          weapons: (st.offense.weapons ?? []).map((w: any) => ({
            module_index: w.module_index,
            name: w.name,
            charge: w.charge_type_id ? ds.type(w.charge_type_id)?.name ?? w.charge_type_id : null,
            kind: w.kind,
            dps: r1(w.dps?.total),
            volley: r1(w.volley?.total),
            optimal_m: r1(w.optimal_m ?? w.range_m, 0),
            falloff_m: r1(w.falloff_m, 0),
          })),
        }
      : null,
    defense: st.defense
      ? {
          ehp: Object.fromEntries(Object.entries<any>(st.defense.ehp ?? {}).map(([k, v]) => [k, r1(v, 0)])),
          hp: Object.fromEntries(Object.entries<any>(st.defense.hp ?? {}).map(([k, v]) => [k, r1(v, 0)])),
          resists_percent: {
            shield: pct(st.defense.resonance?.shield),
            armor: pct(st.defense.resonance?.armor),
            hull: pct(st.defense.resonance?.hull),
          },
          tank_ehp_s: st.defense.tank?.sustained_effective ?? st.defense.tank?.effective ?? null,
          damage_pattern: st.defense.damage_pattern ?? null,
        }
      : null,
    capacitor: {
      capacity_gj: r1(cap.capacity),
      recharge_time_s: r1(cap.recharge_time_s),
      stable: cap.stable ?? null,
      stable_percent: r1(cap.stable_percent, 1),
      depletes_in_s: r1(cap.depletes_in_s, 0),
      delta_gj_s: r1(cap.delta_gj_s),
      use_gj_s: r1(cap.use_gj_s),
      peak_recharge_gj_s: r1(cap.peak_recharge_gj_s),
    },
    navigation: st.navigation
      ? {
          max_velocity: r1(st.navigation.max_velocity, 1),
          align_time_s: r1(st.navigation.align_time_s),
          signature_radius: r1(st.navigation.signature_radius, 1),
          agility: r1(st.navigation.agility, 4),
          mass_kg: r1(st.navigation.mass, 0),
          warp_speed_au_s: r1(st.navigation.warp_speed_au_s),
          max_warp_distance_au: r1(st.navigation.max_warp_distance_au, 1),
          warp_scramble_status: st.navigation.warp_scramble_status,
        }
      : null,
    targeting: st.targeting
      ? {
          max_range_m: r1(st.targeting.max_range_m, 0),
          scan_resolution: r1(st.targeting.scan_resolution, 1),
          max_targets: st.targeting.max_targets,
          sensor: `${r1(st.targeting.sensor_strength)} ${st.targeting.sensor_type ?? ""}`.trim(),
          probe_size: r1(st.targeting.probe_size, 3),
          lock_time_s: st.targeting.lock_time_s ? Object.fromEntries(Object.entries<any>(st.targeting.lock_time_s).filter(([, v]) => v !== null).map(([k, v]) => [k, r1(v)])) : null,
        }
      : null,
    fitting: st.resources
      ? {
          cpu: ur(st.resources.cpu),
          power: ur(st.resources.power),
          calibration: ur(st.resources.calibration),
          drone_bandwidth: ur(st.resources.drone_bandwidth),
          slots: Object.fromEntries(Object.entries<any>(st.resources.slots ?? {}).filter(([, v]) => v?.total || v?.used).map(([k, v]) => [k, ur(v)])),
          hardpoints: Object.fromEntries(Object.entries<any>(st.resources.hardpoints ?? {}).map(([k, v]) => [k, ur(v)])),
        }
      : null,
    mining: miningSummary(st.mining),
    remote_repair: outgoingSummary(st.outgoing),
    bombing: bombingSummary(st.bombing),
    heat: heatSummary(st.modules),
    validation: {
      validated: (req as any).options?.validate !== false,
      valid: !(st.violations ?? []).length,
      codes: [...new Set<string>((st.violations ?? []).map((v: any) => v.code))].sort(),
    },
    violations: describeViolations(ds, req, s),
    warnings: st.warnings ?? [],
    // docs/23 §6: the engine's price block (only when prices were asked for) and docs/22 §2.3 provenance (sde_build,
    // sde_hash, price_source, snapshot_time, …; on every result since eve-dogma 8bde0ba), verbatim
    ...(st.price !== undefined ? { price: st.price } : {}),
    ...(st.provenance !== undefined ? { provenance: st.provenance } : {}),
    metrics,
  };
}

const nz = (o: any) => !!o && Object.values<any>(o).some((v) => typeof v === "number" && Math.abs(v) > 1e-9);
const rd = (o: any, d = 2) => (o ? Object.fromEntries(Object.entries<any>(o).map(([k, v]) => [k, r1(v, d)])) : null);

/** Ore/ice/gas yield (engine `mining`); null when the fit mines nothing. */
export function miningSummary(m: any) {
  if (!nz(m)) return null;
  return {
    total_m3_s: r1(m.total_m3_s, 3),
    modules_m3_s: r1(m.modules_m3_s, 3),
    drones_m3_s: r1(m.drones_m3_s, 3),
    m3_per_hour: r1((m.total_m3_s ?? 0) * 3600, 0),
    drain_m3_s: r1((m.modules_drain_m3_s ?? 0) + (m.drones_drain_m3_s ?? 0), 3),
  };
}

/** Outgoing remote repair / cap transfer (engine `outgoing`); null when the fit repairs nothing. */
export function outgoingSummary(o: any) {
  if (!o || !(nz(o.current) || nz(o.spool_max))) return null;
  const spooled = JSON.stringify(o.spool_min) !== JSON.stringify(o.spool_max);
  return { ...rd(o.current, 1), ...(spooled ? { spool_min: rd(o.spool_min, 1), spool_max: rd(o.spool_max, 1) } : {}) };
}

/** Bombs needed to kill the fit, per bomb damage type, at Covert Ops 0 and V (engine `bombing`). */
export function bombingSummary(b: any) {
  if (!b) return null;
  const at = (lvl: number) => Object.fromEntries(["em", "thermal", "kinetic", "explosive"].map((k) => [k, b[k]?.[`covert_ops_${lvl}`] ?? null]));
  return { covert_ops_5: at(5), covert_ops_0: at(0) };
}

/** Overheated modules with cycles / seconds until burnout (engine `modules[].heat`). */
export function heatSummary(mods: any[] | undefined) {
  const hot = (mods ?? []).filter((m) => m?.heat);
  if (!hot.length) return null;
  return hot.map((m) => ({ module_index: m.module_index, name: m.name, burn_cycles: m.heat.burn_cycles, burnout_s: r1(m.heat.burnout_s, 1) }));
}

export function pickSections(s: FitStats, sections: string[]) {
  const out: Record<string, unknown> = {};
  for (const k of sections) if (k in (s as any)) out[k] = (s as any)[k];
  return out;
}

/** Markdown table: rows = metrics, columns = fits, plus delta vs the first fit. */
export function markdownTable(headers: string[], rows: (string | number | null)[][]): string {
  const fmt = (v: string | number | null) => (v === null || v === undefined ? "–" : typeof v === "number" ? String(round(v, 2)) : v);
  const line = (r: (string | number | null)[]) => `| ${r.map(fmt).join(" | ")} |`;
  return [line(headers), `|${headers.map(() => "---").join("|")}|`, ...rows.map(line)].join("\n");
}
