// Engine stats exposed by compute_fit (summary blocks, named metrics, detail=full sections), with values checked against
// Pyfa through eve-dogma-bench pending-1.11 (core cases/ and ext/ expected files; the case is named in each test).
// The full corpus runs through the MCP in CI as well (tools/mcp-dogma-bench.py, suite mcp-bench).
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { call, connect, EXCT_RIFTER, haveEngine, near } from "./helpers.js";

describe("engine stats through compute_fit (Pyfa values)", { skip: !haveEngine && "engine or dataset missing" }, () => {
  let c: Client;
  let full: any;
  let sum: any;
  before(async () => {
    c = await connect();
    full = await call(c, "compute_fit", { fit: EXCT_RIFTER, skills: 5, detail: "full" });
    sum = await call(c, "compute_fit", { fit: EXCT_RIFTER, skills: 5 });
  });
  after(async () => c?.close());

  test("mcp.stats.defense-values: HP, resists per layer and EHP of a known fit (bench exct_rifter)", () => {
    const d = full.defense;
    near(d.hp.shield, 562.5, "hp.shield");
    near(d.hp.armor, 1312.5, "hp.armor");
    near(d.hp.hull, 437.5, "hp.hull");
    near(d.resonance.armor.em, 0.34, "res.armor.em");
    near(d.resonance.armor.thermal, 0.5525, "res.armor.thermal");
    near(d.resonance.armor.kinetic, 0.6375, "res.armor.kinetic");
    near(d.resonance.armor.explosive, 0.49725, "res.armor.explosive");
    near(d.resonance.shield.em, 0.875, "res.shield.em");
    near(d.resonance.shield.explosive, 0.4375, "res.shield.explosive");
    near(d.resonance.hull.em, 0.402, "res.hull.em");
    near(d.ehp.shield, 886.6995073891625, "ehp.shield");
    near(d.ehp.armor, 2589.715131335553, "ehp.armor");
    near(d.ehp.hull, 1088.3084577114428, "ehp.hull");
    near(d.tank.raw.passive_shield, 3.0, "tank.passive");
    assert.deepEqual(sum.defense.resists_percent.armor, { em: 66, thermal: 44.8, kinetic: 36.3, explosive: 50.3 });
    near(sum.metrics.hp, 2312.5, "metrics.hp");
  });

  test("mcp.stats.capacitor-values: capacitor capacity, recharge, peak, simulated stable % (bench exct_rifter)", () => {
    const cap = full.capacitor;
    near(cap.capacity, 312.5, "cap_capacity");
    near(cap.recharge_time_s, 93.75, "cap_recharge_s");
    near(cap.peak_recharge_gj_s, (2.5 * 312.5) / 93.75, "peak recharge = 2.5 C / T");
    assert.equal(cap.stable, true);
    near(cap.stable_percent, 83.49598710843377, "cap_stable_percent");
    assert.deepEqual(
      { capacity_gj: sum.capacitor.capacity_gj, recharge_time_s: sum.capacitor.recharge_time_s, stable: sum.capacitor.stable, stable_percent: sum.capacitor.stable_percent },
      { capacity_gj: 312.5, recharge_time_s: 93.75, stable: true, stable_percent: 83.5 },
    );
    near(sum.metrics.cap_stable_percent, 83.496, "metric cap_stable_percent", 1e-5);
  });

  test("mcp.stats.navigation-values: speed, align, agility, mass, signature, warp (bench exct_rifter)", () => {
    const n = full.navigation;
    near(n.max_velocity, 1148.5220290723812, "max_velocity");
    near(n.align_time_s, 5.245170868083969, "align_time_s");
    near(n.mass, 1668250, "mass");
    near(n.signature_radius, 35, "signature_radius");
    near(n.warp_speed_au_s, 5, "warp_speed");
    near(-Math.log(0.25) * n.agility * n.mass / 1e6, n.align_time_s, "align = ln4 * agility * mass / 1e6");
    assert.equal(n.warp_scramble_status, 0);
    assert.ok(n.max_warp_distance_au > 0);
    assert.equal(sum.navigation.mass_kg, 1668250);
    assert.equal(sum.navigation.signature_radius, 35);
    assert.equal(sum.navigation.agility, 2.268);
    near(sum.metrics.align, 5.245, "metric align", 1e-3);
  });

  test("mcp.stats.targeting-values: lock range, scan resolution, targets, sensor strength, lock times, probe size (bench exct_rifter, probe_rifter)", () => {
    const t = full.targeting;
    near(t.max_range_m, 28125, "max_target_range");
    near(t.scan_resolution, 825, "scan_resolution");
    near(t.sensor_strength, 9.6, "scan_strength");
    assert.equal(t.max_targets, 4);
    assert.equal(t.sensor_type, "ladar");
    near(t.probe_size, 35 / 9.6, "probe_size = sig / sensor strength");
    // lock time (Pyfa): 40000 / (scanRes * asinh(sig)^2)
    near(t.lock_time_s.sig_40m, 40000 / (825 * Math.asinh(40) ** 2), "lock time vs 40 m");
    assert.equal(sum.targeting.probe_size, 3.646);
    assert.equal(sum.metrics.probe_size, 3.646);
    assert.equal(sum.metrics.max_targets, 4);
  });

  test("mcp.stats.illegal-fit-computed: a fit with violations is still computed in full (Pyfa 'disable fitting restrictions'; bench exct_rifter)", () => {
    assert.deepEqual(sum.validation, { validated: true, valid: false, codes: ["CALIBRATION_OVERLOAD", "CPU_OVERLOAD", "DRONE_BANDWIDTH", "SLOTS_EXCEEDED"] });
    near(full.offense.total.weapon_dps, 243.12956327613847, "weapon_dps");
    near(full.offense.total.drone_dps, 32.175, "drone_dps");
    near(full.resources.cpu.used, 190, "cpu_used");
    near(full.resources.calibration.used, 675, "calibration_used");
    assert.equal(sum.metrics.violations, sum.violations.length);
    assert.ok(sum.violations.every((v: any) => typeof v.hint === "string"), JSON.stringify(sum.violations));
  });

  test("mcp.stats.mining: mining yield of modules and drones (bench ext mining_venture)", async () => {
    const fit = { ship: "Venture", modules: ["Miner II", "Miner II", { name: "Mining Laser Upgrade II", state: "online" }], drones: ["Mining Drone II x2"] };
    const r = await call(c, "compute_fit", { fit, skills: 5 });
    near(r.mining.total_m3_s, 11.104, "summary total", 1e-3);
    near(r.mining.modules_m3_s, 8.835, "summary modules", 1e-3);
    near(r.mining.drones_m3_s, 2.269, "summary drones", 1e-3);
    near(r.mining.m3_per_hour, Math.round(11.1037109375 * 3600), "m3/h", 1e-3);
    near(r.metrics.mining_yield, 11.104, "metric mining_yield", 1e-3);
    const f = await call(c, "compute_fit", { fit, skills: 5, detail: "full", sections: ["mining"] });
    near(f.mining.modules_m3_s, 8.8349609375, "modules_m3_s");
    near(f.mining.drones_m3_s, 2.26875, "drones_m3_s");
    near(f.mining.modules_drain_m3_s, 11.410937500000001, "modules_drain_m3_s");
    near(f.mining.drones_drain_m3_s, 3.0401249999999997, "drones_drain_m3_s");
    assert.equal(sum.mining, null, "a combat fit mines nothing");
    assert.equal(sum.metrics.mining_yield, 0);
  });

  test("mcp.stats.remote-repair: outgoing remote shield repair and cap transfer (bench ext rr_basilisk)", async () => {
    const r = await call(c, "compute_fit", { fit: { ship: "Basilisk", modules: [...Array(4).fill("Large Remote Shield Booster II"), "Large Remote Capacitor Transmitter II"] }, skills: 5 });
    assert.deepEqual(r.remote_repair, { armor_per_s: 0, capacitor_per_s: 70.2, hull_per_s: 0, shield_per_s: 340 });
    assert.equal(r.metrics.remote_rep, 340);
    assert.equal(r.metrics.remote_shield_rep, 340);
    assert.equal(r.metrics.cap_transfer, 70.2);
    const f = await call(c, "compute_fit", { fit: { ship: "Basilisk", modules: ["Large Remote Shield Booster II"] }, skills: 5, detail: "full", sections: ["outgoing"] });
    near(f.outgoing.current.shield_per_s, 85, "one booster = 340 / 4");
    assert.equal(sum.remote_repair, null);
  });

  test("mcp.stats.remote-repair-spool: mutadaptive remote armor repairer spool range (bench ext rr_zarmazd_spool)", async () => {
    const fit = { ship: "Zarmazd", modules: ["Heavy Mutadaptive Remote Armor Repairer II", "Large Remote Armor Repairer II", "Large Remote Armor Repairer II"] };
    const r = await call(c, "compute_fit", { fit, skills: 5 });
    near(r.remote_repair.armor_per_s, 597.3, "current (default spool = full, Pyfa)", 1e-3);
    near(r.remote_repair.spool_min.armor_per_s, 341.3, "spool 0", 1e-3);
    near(r.remote_repair.spool_max.armor_per_s, 597.3, "spool 1", 1e-3);
    near(r.metrics.remote_armor_rep, 597.333, "metric remote_armor_rep", 1e-5);
    near(r.metrics.remote_rep_spooled, 597.333, "metric remote_rep_spooled", 1e-5);
    const z = await call(c, "compute_fit", { fit, skills: 5, options: { default_spool: { type: "spool_scale", amount: 0 } } });
    near(z.remote_repair.armor_per_s, 341.3, "options.default_spool 0 lowers current", 1e-3);
  });

  test("mcp.stats.bombing: bombs needed to kill per bomb type and Covert Ops level (bench ext bomb_rifter)", async () => {
    const r = await call(c, "compute_fit", { fit: { ship: "Rifter" }, skills: 5 });
    assert.deepEqual(r.bombing.covert_ops_5, { em: 4.2, thermal: 3.6, kinetic: 3.7, explosive: 3.8 });
    assert.deepEqual(r.bombing.covert_ops_0, { em: 5.2, thermal: 4.4, kinetic: 4.7, explosive: 4.8 });
    assert.equal(r.metrics.bombs_to_kill, 3.6);
    const f = await call(c, "compute_fit", { fit: { ship: "Rifter" }, skills: 5, detail: "full", sections: ["bombing"] });
    assert.equal(f.bombing.kinetic.covert_ops_3, 4.1);
    assert.ok(sum.metrics.bombs_to_kill > r.metrics.bombs_to_kill, "the plated exct_rifter takes more bombs than an empty hull");
  });

  test("mcp.stats.overheat: overheated modules get the heat bonus and a burnout estimate", async () => {
    const fit = (state: string) => ({ ship: "Rifter", modules: [{ name: "1MN Afterburner II", state }, { name: "Stasis Webifier II", state }] });
    const act = await call(c, "compute_fit", { fit: fit("active"), skills: 5 });
    const hot = await call(c, "compute_fit", { fit: fit("overheated"), skills: 5 });
    assert.ok(hot.navigation.max_velocity > act.navigation.max_velocity * 1.05, `overheated AB ${hot.navigation.max_velocity} vs ${act.navigation.max_velocity}`);
    assert.equal(act.heat, null);
    assert.equal(hot.heat.length, 2);
    for (const h of hot.heat) assert.ok(h.burn_cycles > 0 && h.burnout_s > 0, JSON.stringify(h));
    assert.equal(hot.metrics.heat_burnout_s, Math.min(...hot.heat.map((h: any) => h.burnout_s)));
    const f = await call(c, "compute_fit", { fit: fit("overheated"), skills: 5, detail: "full", sections: ["modules"] });
    assert.ok(f.modules.every((m: any) => m.state === "overheated" && m.heat.burnout_s > 0));
  });

  test("mcp.stats.drone-fighter-hp: per-drone and per-fighter HP / EHP / shield recharge (bench ext dehp_vexor_hobgoblin, fehp_thanatos_firbolg)", async () => {
    const d = await call(c, "compute_fit", { fit: { ship: "Vexor", drones: ["Hobgoblin II x5"] }, skills: 5, detail: "full", sections: ["drones"] });
    const it = d.drones.items[0];
    near(it.hp.shield, 112.5, "drone hp.shield");
    near(it.hp.armor, 202.5, "drone hp.armor");
    near(it.ehp.armor, 300, "drone ehp.armor");
    near(it.shield_peak_recharge_hp_s, 2.25, "drone shield recharge");
    const f = await call(c, "compute_fit", { fit: { ship: "Thanatos", fighters: [{ name: "Firbolg II", quantity: 6, active: true }] }, skills: 5, detail: "full", sections: ["fighters"] });
    const fi = f.fighters.items[0];
    near(fi.hp.shield, 5104.6875, "fighter hp.shield");
    near(fi.ehp.shield, 5751.760563380282, "fighter ehp.shield");
    near(fi.shield_peak_recharge_hp_s, 18.231026785714285, "fighter shield recharge");
  });
  test("mcp.stats.utility-modules: utility modules without stats (scanners, cloak, probe launcher) fit, cost resources, change nothing else", async () => {
    const base = { ship: "Heron", modules: [] as unknown[] };
    const util = { ship: "Heron", modules: ["Cargo Scanner I", "Ship Scanner I", "Prototype Cloaking Device I /online", "Core Probe Launcher I"] };
    const b = await call(c, "compute_fit", { fit: base, detail: "full" });
    const u = await call(c, "compute_fit", { fit: util, detail: "full" });
    assert.equal(u.modules.length, 4);
    assert.deepEqual(u.violations ?? [], [], JSON.stringify(u.violations));
    assert.ok(u.resources.cpu.used > b.resources.cpu.used && u.resources.power.used > b.resources.power.used, "they cost CPU / PG");
    assert.equal(u.offense.total.dps.total, 0);
    assert.equal(u.defense.ehp.total, b.defense.ehp.total, "no tank change");
    assert.equal(u.navigation.max_velocity, b.navigation.max_velocity, "online cloak: no speed change");
  });
});
