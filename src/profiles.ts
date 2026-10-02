// Built-in presets: skill levels, incoming damage profiles, target profiles, and implant sets derived from the dataset.
import type { Dataset, TypeInfo } from "./dataset.js";

export interface DamageProfile {
  name: string;
  em: number;
  thermal: number;
  kinetic: number;
  explosive: number;
  note?: string;
}

export interface TargetProfile {
  name: string;
  signature_radius: number;
  max_velocity: number;
  radius?: number | null;
  em: number;
  thermal: number;
  kinetic: number;
  explosive: number;
  note?: string;
}

/** Incoming damage patterns (relative weights). NPC entries are rounded community figures, labelled approximate. */
export const DAMAGE_PROFILES: DamageProfile[] = [
  { name: "uniform", em: 25, thermal: 25, kinetic: 25, explosive: 25, note: "engine default" },
  { name: "em", em: 100, thermal: 0, kinetic: 0, explosive: 0 },
  { name: "thermal", em: 0, thermal: 100, kinetic: 0, explosive: 0 },
  { name: "kinetic", em: 0, thermal: 0, kinetic: 100, explosive: 0 },
  { name: "explosive", em: 0, thermal: 0, kinetic: 0, explosive: 100 },
  { name: "em_thermal", em: 50, thermal: 50, kinetic: 0, explosive: 0, note: "lasers" },
  { name: "kinetic_thermal", em: 0, thermal: 50, kinetic: 50, explosive: 0, note: "hybrids" },
  { name: "explosive_kinetic", em: 0, thermal: 0, kinetic: 50, explosive: 50, note: "projectiles (typical)" },
  { name: "angel_cartel", em: 7, thermal: 9, kinetic: 22, explosive: 62, note: "approximate" },
  { name: "blood_raiders", em: 50, thermal: 48, kinetic: 2, explosive: 0, note: "approximate" },
  { name: "guristas", em: 0, thermal: 18, kinetic: 82, explosive: 0, note: "approximate" },
  { name: "sanshas_nation", em: 53, thermal: 47, kinetic: 0, explosive: 0, note: "approximate" },
  { name: "serpentis", em: 0, thermal: 55, kinetic: 45, explosive: 0, note: "approximate" },
  { name: "rogue_drones", em: 30, thermal: 30, kinetic: 25, explosive: 15, note: "approximate" },
  { name: "mordus_legion", em: 0, thermal: 30, kinetic: 70, explosive: 0, note: "approximate" },
  { name: "triglavian", em: 0, thermal: 60, kinetic: 0, explosive: 40, note: "approximate" },
  { name: "sleepers", em: 30, thermal: 25, kinetic: 25, explosive: 20, note: "approximate" },
];

/** Target profiles for applied DPS (`offense.vs_target_profile`). Resists are fractions 0..1 (0 = none). */
export const TARGET_PROFILES: TargetProfile[] = [
  { name: "ideal", signature_radius: 1e9, max_velocity: 0, em: 0, thermal: 0, kinetic: 0, explosive: 0, note: "infinite sig, stationary: raw DPS" },
  { name: "frigate", signature_radius: 35, max_velocity: 400, em: 0, thermal: 0, kinetic: 0, explosive: 0 },
  { name: "frigate_mwd", signature_radius: 175, max_velocity: 2500, em: 0, thermal: 0, kinetic: 0, explosive: 0 },
  { name: "destroyer", signature_radius: 65, max_velocity: 300, em: 0, thermal: 0, kinetic: 0, explosive: 0 },
  { name: "cruiser", signature_radius: 125, max_velocity: 220, em: 0, thermal: 0, kinetic: 0, explosive: 0 },
  { name: "cruiser_mwd", signature_radius: 625, max_velocity: 1300, em: 0, thermal: 0, kinetic: 0, explosive: 0 },
  { name: "battlecruiser", signature_radius: 270, max_velocity: 160, em: 0, thermal: 0, kinetic: 0, explosive: 0 },
  { name: "battleship", signature_radius: 400, max_velocity: 110, em: 0, thermal: 0, kinetic: 0, explosive: 0 },
  { name: "capital", signature_radius: 3000, max_velocity: 60, em: 0, thermal: 0, kinetic: 0, explosive: 0 },
  { name: "structure", signature_radius: 20000, max_velocity: 0, em: 0, thermal: 0, kinetic: 0, explosive: 0 },
];

export interface SkillPreset {
  name: string;
  default_level: number;
  description: string;
}

export const SKILL_PRESETS: SkillPreset[] = [
  { name: "all_5", default_level: 5, description: "every published skill at V (Pyfa 'All 5')" },
  { name: "all_4", default_level: 4, description: "every published skill at IV" },
  { name: "all_3", default_level: 3, description: "every published skill at III" },
  { name: "all_2", default_level: 2, description: "every published skill at II" },
  { name: "all_1", default_level: 1, description: "every published skill at I" },
  { name: "all_0", default_level: 0, description: "no skills trained (engine default when skills are omitted)" },
];

export function skillPreset(name: string): SkillPreset | undefined {
  const n = name.toLowerCase().replace(/[\s-]+/g, "_");
  return SKILL_PRESETS.find((p) => p.name === n || p.name === `all_${n}` || p.name.replace("_", "") === n);
}

export function damageProfile(name: string): DamageProfile | undefined {
  const n = name.toLowerCase().replace(/[\s'-]+/g, "_");
  return DAMAGE_PROFILES.find((p) => p.name === n || p.name.startsWith(n));
}

export function targetProfile(name: string): TargetProfile | undefined {
  const n = name.toLowerCase().replace(/[\s-]+/g, "_");
  return TARGET_PROFILES.find((p) => p.name === n);
}

export interface ImplantSet {
  name: string;
  grade: string;
  implants: { type_id: number; name: string; slot: number | null }[];
}

const GREEK = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Omega"];

/** Pirate implant sets (Low/Mid/High-grade X Alpha…Omega) found in the dataset. */
export function implantSets(ds: Dataset): ImplantSet[] {
  const sets = new Map<string, ImplantSet>();
  const re = new RegExp(`^(Low-grade|Mid-grade|High-grade) (.+) (${GREEK.join("|")})$`);
  for (const t of ds.types.values()) {
    if (t.kind !== "implant" || !t.published) continue;
    const m = re.exec(t.name);
    if (!m) continue;
    const key = `${m[1]} ${m[2]}`;
    let s = sets.get(key);
    if (!s) sets.set(key, (s = { name: key, grade: m[1], implants: [] }));
    s.implants.push({ type_id: t.id, name: t.name, slot: ds.attr(t, "implantness") ?? null });
  }
  const order = (n: string) => GREEK.indexOf(n.split(" ").pop()!);
  const out = [...sets.values()].filter((s) => s.implants.length >= 5);
  for (const s of out) s.implants.sort((a, b) => order(a.name) - order(b.name));
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function findImplantSet(ds: Dataset, name: string): ImplantSet | undefined {
  const n = name.toLowerCase().replace(/[_]+/g, " ").trim();
  const sets = implantSets(ds);
  return sets.find((s) => s.name.toLowerCase() === n) ?? sets.find((s) => s.name.toLowerCase().includes(n));
}

export function implantSlot(ds: Dataset, t: TypeInfo): number | null {
  return ds.attr(t, "implantness") ?? null;
}
