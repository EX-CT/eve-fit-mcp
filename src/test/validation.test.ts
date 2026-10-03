// Fit validity through compute_fit / validate_fit: every Pyfa check the engine reports (codes as in eve-dogma-bench
// pending-1.11 ext val_* cases, which are Pyfa-backed), with module / skill names and fix hints from the MCP.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { call, connect, haveEngine, near } from "./helpers.js";

const codes = (r: any) => [...new Set<string>(r.violations.map((v: any) => v.code))].sort();
const byCode = (r: any, code: string) => r.violations.filter((v: any) => v.code === code);

describe("fit validity (Pyfa checks)", { skip: !haveEngine && "engine or dataset missing" }, () => {
  let c: Client;
  before(async () => {
    c = await connect();
  });
  after(async () => c?.close());

  test("mcp.validation.charge-validity: validate_fit flags charge group, size and capacity per module (bench ext val_charge_group, val_charge_size, val_charge_capacity)", async () => {
    const r = await call(c, "validate_fit", { fit: { ship: "Rifter", modules: ["200mm AutoCannon II, Antimatter Charge S", "200mm AutoCannon II, EMP M", "Small Capacitor Booster II, Cap Booster 400"] }, skills: 5 });
    assert.equal(r.valid, false);
    assert.deepEqual(codes(r), ["CHARGE_CAPACITY", "CHARGE_GROUP", "CHARGE_SIZE"]);
    assert.deepEqual(
      r.violations.map((v: any) => [v.code, v.module_index, v.module]),
      [
        ["CHARGE_GROUP", 0, "200mm AutoCannon II"],
        ["CHARGE_SIZE", 1, "200mm AutoCannon II"],
        ["CHARGE_CAPACITY", 2, "Small Capacitor Booster II"],
      ],
    );
    for (const v of r.violations) assert.match(v.hint, /compatible charges/);
    const ok = await call(c, "validate_fit", { fit: { ship: "Rifter", modules: ["200mm AutoCannon II, EMP S", "Small Capacitor Booster II, Cap Booster 50"] }, skills: 5 });
    assert.deepEqual(ok.violations, []);
    assert.equal(ok.valid, true);
  });

  test("mcp.validation.resource-overflow: CPU / powergrid / calibration / drone bandwidth overflow is flagged (bench ext val_cpu_power_overload, val_slots_mid_low_rig, val_drone_bandwidth)", async () => {
    const pg = await call(c, "validate_fit", { fit: { ship: "Rifter", modules: [...Array(3).fill({ name: "Medium Shield Extender II", state: "online" }), ...Array(3).fill("200mm AutoCannon II, EMP S")] }, skills: 5 });
    assert.deepEqual(codes(pg), ["POWER_OVERLOAD"]);
    assert.ok(pg.fitting.power.used > pg.fitting.power.total, JSON.stringify(pg.fitting.power));
    assert.match(byCode(pg, "POWER_OVERLOAD")[0].hint, /Reactor Control Unit|Power Diagnostic/);
    const over = await call(c, "validate_fit", {
      fit: {
        ship: "Rifter",
        modules: [
          "1MN Afterburner II",
          ...Array(3).fill({ name: "Medium Shield Extender II", state: "online" }),
          { name: "Damage Control II", state: "online" },
          ...Array(4).fill({ name: "Gyrostabilizer II", state: "online" }),
          ...Array(4).fill("Small Core Defense Field Extender I"),
        ],
      },
      skills: 5,
    });
    assert.deepEqual(codes(over), ["CPU_OVERLOAD", "POWER_OVERLOAD", "SLOTS_EXCEEDED"]);
    assert.ok(over.fitting.cpu.used > over.fitting.cpu.total);
    const cal = await call(c, "compute_fit", { fit: { ship: "Rifter", modules: Array(3).fill("Small Projectile Burst Aerator II") }, skills: 5 });
    assert.ok(cal.validation.codes.includes("CALIBRATION_OVERLOAD"), cal.validation.codes.join());
    assert.ok(cal.metrics.calibration_free < 0);
    const bw = await call(c, "validate_fit", { fit: { ship: "Vexor", drones: ["Ogre II x4"] }, skills: 5 });
    assert.deepEqual(codes(bw), ["DRONE_BANDWIDTH"]);
    assert.ok(bw.fitting.drone_bandwidth.used > bw.fitting.drone_bandwidth.total);
  });

  test("mcp.validation.ship-restriction: modules the hull cannot fit (command burst on a frigate, capital module on a cruiser) (bench ext val_ship_restriction_burst, val_capital_module_subcap)", async () => {
    const b = await call(c, "validate_fit", { fit: { ship: "Rifter", modules: [{ name: "Shield Command Burst I", state: "online" }] }, skills: 5 });
    assert.deepEqual(codes(b), ["POWER_OVERLOAD", "SHIP_RESTRICTION"]);
    const sr = byCode(b, "SHIP_RESTRICTION")[0];
    assert.equal(sr.module_index, 0);
    assert.equal(sr.module, "Shield Command Burst I");
    assert.match(sr.hint, /cannot be fitted to this hull/);
    const cap = await call(c, "validate_fit", { fit: { ship: "Vexor", modules: [{ name: "Capital Armor Repairer I", state: "online" }] }, skills: 5 });
    assert.deepEqual(codes(cap), ["POWER_OVERLOAD", "SHIP_RESTRICTION"]);
    assert.equal(byCode(cap, "SHIP_RESTRICTION")[0].module, "Capital Armor Repairer I");
    const rig = await call(c, "validate_fit", { fit: { ship: "Rifter", modules: ["Medium Core Defense Field Extender I"] }, skills: 5 });
    assert.deepEqual(codes(rig), ["RIG_SIZE"]);
  });

  test("mcp.validation.slots-hardpoints-groups: slots, hardpoints, max group fitted / active / online (bench ext val_slots_high, val_launcher_hardpoints, val_max_group_*)", async () => {
    const hi = await call(c, "validate_fit", { fit: { ship: "Rifter", modules: Array(4).fill("Salvager I") }, skills: 5 });
    assert.deepEqual(codes(hi), ["SLOTS_EXCEEDED"]);
    const la = await call(c, "validate_fit", { fit: { ship: "Rifter", modules: Array(3).fill("Rocket Launcher I") }, skills: 5 });
    assert.deepEqual(codes(la), ["LAUNCHER_HARDPOINTS"]);
    const dc = await call(c, "validate_fit", { fit: { ship: "Rifter", modules: Array(2).fill({ name: "Damage Control II", state: "online" }) }, skills: 5 });
    assert.deepEqual(codes(dc), ["MAX_GROUP_FITTED"]);
    assert.deepEqual(byCode(dc, "MAX_GROUP_FITTED").map((v: any) => v.module_index).sort(), [0, 1]);
    assert.match(byCode(dc, "MAX_GROUP_FITTED")[0].hint, /only a limited number of Damage Control II/);
    const ab = await call(c, "validate_fit", { fit: { ship: "Rifter", modules: Array(2).fill({ name: "1MN Afterburner II", state: "active" }) }, skills: 5 });
    assert.deepEqual(codes(ab), ["MAX_GROUP_ACTIVE"]);
    assert.match(byCode(ab, "MAX_GROUP_ACTIVE")[0].hint, /one module of this group can be active/);
    const bursts = await call(c, "validate_fit", { fit: { ship: "Claymore", modules: ["Shield Command Burst II", "Shield Command Burst II", "Skirmish Command Burst II", "Skirmish Command Burst II"].map((name) => ({ name, state: "online" })) }, skills: 5 });
    assert.deepEqual(codes(bursts), ["MAX_GROUP_ONLINE"]);
  });

  test("mcp.validation.missing-skills: missing skills name the skill and level (bench ext val_missing_skills_partial, val_missing_skills_all0)", async () => {
    const r = await call(c, "validate_fit", { fit: { ship: "Rifter", modules: Array(3).fill("200mm AutoCannon II, EMP S") }, skills: { default_level: 5, levels: { "Small Projectile Turret": 4 } } });
    assert.deepEqual(
      r.violations.map((v: any) => [v.code, v.skill_type_id, v.level, v.skill]),
      [["MISSING_SKILL", 3302, 5, "Small Projectile Turret"]],
    );
    assert.equal(r.violations[0].hint, "train Small Projectile Turret to 5 (skill_requirements lists the whole plan)");
    assert.deepEqual(r.missing_skills, ["Small Projectile Turret 5 (have 4)"]);
    const z = await call(c, "validate_fit", { fit: { ship: "Rifter", modules: ["200mm AutoCannon II, EMP S", "200mm AutoCannon II, EMP S", { name: "Damage Control II", state: "online" }] }, skills: 0 });
    assert.deepEqual(byCode(z, "MISSING_SKILL").map((v: any) => v.skill_type_id).sort((a: number, b: number) => a - b), [3300, 3302, 3312, 3327, 3329, 3392, 3394, 11084]);
  });

  test("mcp.validation.validate-false: options.validate=false skips the checks; validate_fit always checks (bench ext unit_val_validate_false)", async () => {
    const fit = { ship: "Rifter", modules: [...Array(4).fill("Salvager I"), ...Array(2).fill({ name: "Damage Control II", state: "online" })] };
    const on = await call(c, "compute_fit", { fit, skills: 5 });
    assert.deepEqual(on.validation, { validated: true, valid: false, codes: ["MAX_GROUP_FITTED", "SLOTS_EXCEEDED"] });
    const off = await call(c, "compute_fit", { fit, skills: 5, options: { validate: false } });
    assert.deepEqual(off.validation, { validated: false, valid: true, codes: [] });
    assert.deepEqual(off.violations, []);
    assert.equal(off.metrics.violations, 0);
    assert.equal(off.metrics.ehp, on.metrics.ehp, "skipping validation does not change the numbers");
    const v = await call(c, "validate_fit", { fit: { ...fit, options: { validate: false } }, skills: 5 });
    assert.deepEqual(codes(v), ["MAX_GROUP_FITTED", "SLOTS_EXCEEDED"]);
  });

  test("mcp.validation.allow-violations: an illegal fit is computed in full with its violations, and allow_violations keeps rule-breaking candidates (bench ext val_disable_restrictions_stats)", async () => {
    const fit = {
      ship: "Rifter",
      modules: [...Array(4).fill("200mm AutoCannon II, EMP S"), ...Array(2).fill({ name: "Damage Control II", state: "online" }), "Medium Core Defense Field Extender I"],
    };
    const r = await call(c, "compute_fit", { fit, skills: 5, detail: "full" });
    assert.deepEqual([...new Set(r.violations.map((v: any) => v.code))].sort(), ["MAX_GROUP_FITTED", "RIG_SIZE", "SLOTS_EXCEEDED", "TURRET_HARDPOINTS"]);
    near(r.offense.total.weapon_dps, 155.848, "weapon_dps (4 guns on 3 hardpoints, Pyfa computes all four)");
    near(r.offense.total.volley.total, 262.9935, "weapon_volley");
    near(r.defense.hp.shield, 646.875, "hp.shield (medium rig applied anyway)");
    near(r.defense.ehp.shield, 1143.9872001795286, "ehp.shield");
    near(r.resources.cpu.used, 87, "cpu_used");
    near(r.navigation.max_velocity, 456.25, "max_velocity");
    const base = { ship: "Rifter", modules: Array(3).fill("200mm AutoCannon II") };
    const strict = await call(c, "suggest_modules", { fit: base, slot: "low", goal: "ehp", top: 5, skills: 5 });
    assert.ok(strict.suggestions.length > 0 && strict.suggestions.every((s: any) => s.new_violations.length === 0), JSON.stringify(strict.suggestions.map((s: any) => s.new_violations)));
    const loose = await call(c, "suggest_modules", { fit: base, slot: "low", goal: "ehp", top: 5, skills: 5, constraints: { allow_violations: true } });
    assert.ok(loose.suggestions.some((s: any) => s.new_violations.includes("POWER_OVERLOAD")), JSON.stringify(loose.suggestions.map((s: any) => [s.name, s.new_violations])));
    assert.ok(loose.suggestions[0].goal.ehp.value > strict.suggestions[0].goal.ehp.value);
  });
});
