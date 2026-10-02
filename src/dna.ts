// Ship DNA (`shipID:typeID;qty:…::`), the in-game/zKillboard link format. Pure data mapping, no engine needed.
import type { Dataset, Slot, TypeInfo } from "./dataset.js";
import type { FitRequest } from "./adapters/types.js";

export function parseDna(ds: Dataset, dna: string): FitRequest {
  let s = dna.trim();
  const m = /fitting:([0-9:;_]+)/i.exec(s); // <url=fitting:…> / fitting:… links
  if (m) s = m[1];
  s = s.replace(/:+$/, "");
  const parts = s.split(":").filter(Boolean);
  if (!parts.length) throw new Error("empty DNA string");
  const shipId = Number(parts[0].split(";")[0]);
  const ship = ds.type(shipId);
  if (!ship || (ship.kind !== "ship" && ship.kind !== "structure")) throw new Error(`DNA: ${parts[0]} is not a ship type id`);
  const modules: any[] = [];
  const charges: { t: TypeInfo; qty: number }[] = [];
  const drones: any[] = [];
  const fighters: any[] = [];
  const implants: number[] = [];
  const boosters: any[] = [];
  const cargo: any[] = [];
  for (const p of parts.slice(1)) {
    const [idStr, qStr] = p.split(";");
    const id = Number(idStr.replace(/_$/, ""));
    const qty = Math.max(1, Number(qStr ?? 1) || 1);
    const t = ds.type(id);
    if (!t) throw new Error(`DNA: unknown type id ${idStr}`);
    switch (t.kind) {
      case "module":
      case "subsystem":
      case "structure_module":
        for (let i = 0; i < qty; i++) modules.push({ type_id: id, ...(t.slot ? { slot: t.slot } : {}), state: defaultState(ds, t) });
        break;
      case "charge":
        charges.push({ t, qty });
        break;
      case "drone":
        drones.push({ type_id: id, quantity: qty, active: qty });
        break;
      case "fighter":
        fighters.push({ type_id: id, quantity: qty, active: true });
        break;
      case "implant":
        implants.push(id);
        break;
      case "booster":
        boosters.push({ type_id: id, side_effects: [] });
        break;
      default:
        cargo.push({ type_id: id, quantity: qty });
    }
  }
  // load each charge into the modules that take it (client behaviour when importing a fit with ammo)
  for (const { t, qty } of charges) {
    let used = false;
    for (const mod of modules) {
      if (mod.charge_type_id) continue;
      const mt = ds.type(mod.type_id)!;
      if (ds.compatibleCharges(mt).some((c) => c.id === t.id)) {
        mod.charge_type_id = t.id;
        used = true;
      }
    }
    if (!used || qty > 1) cargo.push({ type_id: t.id, quantity: qty });
  }
  const req: FitRequest = { schema_version: 1, ship: { type_id: shipId }, modules, drones, fighters, implants, boosters, cargo };
  return req;
}

/** Same rule as the engines' EFT import: activatable modules (an effect of category 1, or a capacitor need)
 * start active, except rigs and subsystems; passive modules ignore the difference. */
export function defaultState(ds: Dataset, t: TypeInfo): "active" | "online" {
  if (t.slot === "rig" || t.slot === "subsystem") return "online";
  const activatable = t.effects.some(([e]) => ds.effectCategory.get(e) === 1) || (ds.attr(t, "capacitorNeed") ?? 0) !== 0;
  return activatable ? "active" : "online";
}

const DNA_SLOT_ORDER: Slot[] = ["subsystem", "high", "mid", "low", "rig", "service"];

export function exportDna(ds: Dataset, req: FitRequest): string {
  const r = req as any;
  const counts = new Map<number, number>();
  const order: number[] = [];
  const add = (id: number, n: number) => {
    if (!counts.has(id)) order.push(id);
    counts.set(id, (counts.get(id) ?? 0) + n);
  };
  const mods: any[] = r.modules ?? [];
  const slotOf = (m: any): Slot | null => m.slot ?? ds.type(m.type_id)?.slot ?? null;
  for (const s of DNA_SLOT_ORDER) for (const m of mods) if (slotOf(m) === s) add(m.type_id, 1);
  for (const m of mods) if (!slotOf(m)) add(m.type_id, 1);
  for (const d of r.drones ?? []) add(d.type_id, d.quantity ?? 1);
  for (const f of r.fighters ?? []) add(f.type_id, f.quantity ?? 1);
  for (const i of r.implants ?? []) add(typeof i === "number" ? i : i.type_id, 1);
  for (const b of r.boosters ?? []) add(b.type_id, 1);
  const chargeCounts = new Map<number, number>();
  for (const m of mods) if (m.charge_type_id) chargeCounts.set(m.charge_type_id, (chargeCounts.get(m.charge_type_id) ?? 0) + 1);
  for (const c of r.cargo ?? []) chargeCounts.set(c.type_id, (chargeCounts.get(c.type_id) ?? 0) + (c.quantity ?? 1));
  for (const [id, n] of chargeCounts) add(id, n);
  const body = order.map((id) => `${id};${counts.get(id)}`).join(":");
  return `${r.ship.type_id}:${body}::`;
}

/** Multibuy / shopping list text: "Name xN" lines, hull first. */
export function exportMultibuy(ds: Dataset, req: FitRequest): string {
  const r = req as any;
  const counts = new Map<number, number>();
  const add = (id: number, n: number) => counts.set(id, (counts.get(id) ?? 0) + n);
  add(r.ship.type_id, 1);
  for (const m of r.modules ?? []) {
    add(m.type_id, 1);
    if (m.charge_type_id) add(m.charge_type_id, 1);
  }
  for (const d of r.drones ?? []) add(d.type_id, d.quantity ?? 1);
  for (const f of r.fighters ?? []) add(f.type_id, f.quantity ?? 1);
  for (const i of r.implants ?? []) add(typeof i === "number" ? i : i.type_id, 1);
  for (const b of r.boosters ?? []) add(b.type_id, 1);
  for (const c of r.cargo ?? []) add(c.type_id, c.quantity ?? 1);
  return [...counts].map(([id, n]) => `${ds.type(id)?.name ?? id} x${n}`).join("\n");
}
