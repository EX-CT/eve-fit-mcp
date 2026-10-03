// Integration tests: the real MCP server over stdio, the real engine (F = eve-fit by default; EVE_DOGMA_BIN picks another), the real dataset.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { basename } from "node:path";
import { call, callErr, connect, ENGINE_BIN, haveEngine, RIFTER_EFT } from "./helpers.js";

describe(`eve-fit-mcp (rpc adapter, ${basename(ENGINE_BIN)})`, { skip: !haveEngine && "engine or dataset missing" }, () => {
  let c: Client;
  before(async () => {
    c = await connect();
  });
  after(async () => {
    await c?.close();
  });

  test("mcp.integration.list-tools: lists every tool with a JSON schema", async () => {
    const { tools } = await c.listTools();
    const names = tools.map((t) => t.name).sort();
    for (const n of ["search_types", "get_type", "get_ship", "list_presets", "parse_fit", "export_fit", "validate_fit", "compute_fit", "compare_fits", "what_if", "suggest_modules", "optimize_fit", "skill_requirements", "evaluate_profiles", "engine_info", "suggest_charges", "sweep", "suggest_drones"])
      assert.ok(names.includes(n), `missing tool ${n}`);
    for (const t of tools) {
      assert.equal(t.inputSchema.type, "object", t.name);
      assert.ok(t.description && t.description.length > 30, `${t.name} needs a description`);
    }
  });

  test("mcp.integration.engine-info: engine_info reports the same dataset", async () => {
    const r = await call(c, "engine_info", {});
    assert.equal(r.dataset_match, true);
    assert.equal(r.adapter, "rpc");
    assert.match(r.engine.engine, /eve-dogma/);
  });

  test("mcp.integration.search: search: exact, jargon, chinese, filters, fuzzy", async () => {
    let r = await call(c, "search_types", { query: "Rifter" });
    assert.equal(r.results[0].type_id, 587);
    assert.equal(r.results[0].match, "exact");
    r = await call(c, "search_types", { query: "mwd", kinds: ["module"], limit: 5 });
    assert.ok(r.results.every((h: any) => /Microwarpdrive/.test(h.name)), JSON.stringify(r.results.map((h: any) => h.name)));
    r = await call(c, "search_types", { query: "裂谷级" });
    assert.equal(r.results[0].type_id, 587);
    r = await call(c, "search_types", { query: "", kinds: ["module"], slot: "rig", fits_ship: "Rifter", limit: 200 });
    assert.ok(r.count > 10);
    assert.ok(r.results.every((h: any) => h.slot === "rig" && /^Small /.test(h.name)), "frigate rigs are small");
    r = await call(c, "search_types", { query: "Gyrostablizer" });
    assert.equal(r.results[0].match, "fuzzy");
    assert.match(r.results[0].name, /Gyrostabilizer/);
  });

  test("mcp.integration.get-type-ship: get_type and get_ship", async () => {
    const t = await call(c, "get_type", { type: "200mm AutoCannon II" });
    assert.equal(t.slot, "high");
    assert.equal(t.hardpoint, "turret");
    assert.ok(t.charges.some((x: any) => x.name === "Republic Fleet EMP S"));
    assert.ok(t.required_skills.some((s: any) => s.skill === "Small Autocannon Specialization"));
    const s = await call(c, "get_ship", { ship: "Rifter" });
    assert.equal(s.base_layout.slots.high, 3);
    assert.equal(s.base_layout.hardpoints.turret, 3);
    assert.ok(s.with_skills.resources.cpu.total > s.base_layout.resources.cpu, "skills raise CPU");
  });

  test("mcp.integration.get-ship-traits: get_ship lists the hull traits (role + per-skill bonus lines, en/zh) and the bonus shows in the numbers (Cerberus, T2)", async () => {
    const s = await call(c, "get_ship", { ship: "Cerberus" });
    const roles = s.traits.role.map((x: any) => x.line);
    assert.ok(roles.includes("50% reduction in Microwarpdrive signature radius penalty"), roles.join(" | "));
    assert.ok(roles.includes("Can fit Assault Damage Controls"), "bonus-less role line has no amount");
    const hac = s.traits.skills.find((x: any) => x.skill === "Heavy Assault Cruisers");
    const cc = s.traits.skills.find((x: any) => x.skill === "Caldari Cruiser");
    assert.ok(hac && cc, JSON.stringify(s.traits.skills.map((x: any) => x.skill)));
    assert.equal(hac.skill_id, 16591);
    assert.deepEqual(
      hac.per_level.map((x: any) => [x.bonus, x.unit, x.line]),
      [
        [7.5, "%", "7.5% bonus to Shield Booster amount"],
        [5, "%", "5% bonus to Rapid Light Missile, Heavy Missile and Heavy Assault Missile Launcher rate of fire"],
      ],
    );
    assert.equal(cc.per_level[0].line, "2.5% bonus to Light Missile, Heavy Missile and Heavy Assault Missile damage");
    assert.ok(hac.per_level.every((x: any) => x.text_zh && !/[<>]/.test(x.text_zh) && !/[<>]/.test(x.text)), "markup stripped");
    assert.deepEqual(s.traits.misc, []);
    // the HAC rate-of-fire line per level: launcher DPS at HAC V / HAC IV = (1 - 4*5%) / (1 - 5*5%)
    const fit = { ship: "Cerberus", modules: ["Heavy Assault Missile Launcher II, Scourge Heavy Assault Missile"] };
    const v = await call(c, "compute_fit", { fit, skills: 5 });
    const iv = await call(c, "compute_fit", { fit, skills: { default_level: 5, levels: { "Heavy Assault Cruisers": 4 } } });
    const ratio = v.metrics.weapon_dps / iv.metrics.weapon_dps;
    assert.ok(Math.abs(ratio - 0.8 / 0.75) < 1e-3, `HAC V/IV dps ratio ${ratio}`);
    const r = await call(c, "get_ship", { ship: "Rifter" });
    assert.ok(r.traits.skills.some((x: any) => x.skill === "Minmatar Frigate" && x.per_level.length >= 2));
  });

  // Pyfa EFT import states are F behaviour (eve-dogma-rs, frozen, imports every activatable as active): only for the default engine.
  test("mcp.integration.eft-import-states: EFT import states (regression: F eft_parse fix, eve-dogma 1dc951b): weapons active, MJD/cloak online, /OFFLINE offline", { skip: basename(ENGINE_BIN) !== "eve-fit" && "Pyfa EFT states are checked on engine F (eve-fit) only" }, async () => {
    // RIFTER_EFT (3x 200mm AC II, Gyro II, 2 rigs, Warrior II): weapon 196.66 + drone 16.09 = 212.75 DPS, identical on F
    // (eve-dogma 1dc951b) and eve-dogma-rs. Before the fix F parsed the turrets "online": weapon DPS 0, total 16.09.
    const r = await call(c, "compute_fit", { eft: RIFTER_EFT, detail: "full", sections: ["offense"] });
    const w = r.offense.total.weapon_dps;
    assert.ok(Math.abs(w - 196.658) < 0.01, `weapon dps ${w}`);
    assert.ok(Math.abs(r.offense.total.dps.total - 212.746) < 0.01, `dps ${r.offense.total.dps.total}`);
    const p = await call(c, "parse_fit", {
      eft: "[Rifter, states]\nGyrostabilizer II /OFFLINE\n\nLarge Micro Jump Drive\n5MN Microwarpdrive II\n\n200mm AutoCannon II, Republic Fleet EMP S\nPrototype Cloaking Device I\n\n\nWarrior II x2",
    });
    const st = Object.fromEntries(p.items.modules.map((m: any) => [m.name, m.state]));
    assert.deepEqual(st, {
      "Gyrostabilizer II": "offline",
      "Large Micro Jump Drive": "online",
      "5MN Microwarpdrive II": "active",
      "200mm AutoCannon II": "active",
      "Prototype Cloaking Device I": "online",
    });
    assert.equal(p.request.drones[0].active, 2);
  });

  test("mcp.integration.compute-fit-summary: compute_fit from EFT: summary with metrics", async () => {
    const r = await call(c, "compute_fit", { eft: RIFTER_EFT });
    assert.equal(r.ship.name, "Rifter");
    assert.ok(r.offense.dps > 150 && r.offense.dps < 300, `dps ${r.offense.dps}`);
    assert.equal(r.offense.weapons.length, 3);
    assert.ok(r.metrics.ehp > 3000);
    assert.match(r.request_hash, /^[0-9a-f]{64}$/);
    assert.ok(r.notes.some((n: string) => /level 5/.test(n)));
  });

  test("mcp.integration.input-formats-agree: EFT, DNA and lenient JSON give the same numbers", async () => {
    const a = await call(c, "compute_fit", { eft: RIFTER_EFT });
    const dna = (await call(c, "export_fit", { eft: RIFTER_EFT, format: "dna" })).text;
    assert.match(dna, /^587:/);
    const b = await call(c, "compute_fit", { dna });
    assert.equal(b.metrics.dps, a.metrics.dps);
    assert.equal(b.metrics.ehp, a.metrics.ehp);
    const lenient = {
      ship: "Rifter",
      modules: [
        "Damage Control II",
        "Gyrostabilizer II",
        "Small Ancillary Armor Repairer, Nanite Repair Paste",
        "200mm Steel Plates II",
        "5MN Microwarpdrive II",
        "Warp Scrambler II",
        "Stasis Webifier II",
        "200mm AutoCannon II, Republic Fleet EMP S",
        { name: "200mm AutoCannon II", charge: "Republic Fleet EMP S" },
        { name: "200mm AutoCannon II", charge: "Republic Fleet EMP S" },
        "Small Projectile Burst Aerator I",
        "Small Projectile Collision Accelerator I",
      ],
      drones: ["Warrior II x1"],
    };
    const j = await call(c, "compute_fit", { fit: lenient });
    assert.equal(j.metrics.dps, a.metrics.dps);
    assert.equal(j.metrics.ehp, a.metrics.ehp);
  });

  test("mcp.integration.skills: skills change the numbers; all_0 is weaker", async () => {
    const v = await call(c, "compute_fit", { eft: RIFTER_EFT });
    const z = await call(c, "compute_fit", { eft: RIFTER_EFT, skills: "all_0" });
    assert.ok(z.metrics.dps < v.metrics.dps);
    const g4 = await call(c, "compute_fit", { eft: RIFTER_EFT, skills: { default_level: 5, levels: { Gunnery: 4 } } });
    assert.ok(g4.metrics.dps < v.metrics.dps);
  });

  test("mcp.integration.full-detail-sections: full detail with sections", async () => {
    const r = await call(c, "compute_fit", { eft: RIFTER_EFT, detail: "full", sections: ["capacitor", "navigation"] });
    assert.deepEqual(Object.keys(r).filter((k) => !["request_hash", "notes", "engine"].includes(k)).sort(), ["capacitor", "navigation"]);
    assert.equal(typeof r.capacitor.stable, "boolean");
    // Rifter, all V: capacitor 250 * 1.25 (Capacitor Management) * 0.8 (5MN MWD II capacitor penalty) = 250 GJ,
    // recharge 125 s * 0.75 (Capacitor Systems Operation) = 93.75 s, peak recharge 2.5 C / T; MWD + ancillary repairer drain it
    assert.equal(r.capacitor.capacity, 250);
    assert.equal(r.capacitor.recharge_time_s, 93.75);
    assert.ok(Math.abs(r.capacitor.peak_recharge_gj_s - (2.5 * 250) / 93.75) < 1e-5, String(r.capacitor.peak_recharge_gj_s));
    assert.ok(r.capacitor.use_gj_s > 0);
    assert.ok(Math.abs(r.capacitor.delta_gj_s - (r.capacitor.peak_recharge_gj_s - r.capacitor.use_gj_s + (r.capacitor.injected_gj_s ?? 0))) < 1e-3, JSON.stringify(r.capacitor));
    if (r.capacitor.stable) assert.ok(r.capacitor.stable_percent > 0 && r.capacitor.stable_percent <= 100);
    else assert.ok(r.capacitor.depletes_in_s > 0, JSON.stringify(r.capacitor));
  });

  test("mcp.integration.validate-fit: validate_fit names modules and hints", async () => {
    const r = await call(c, "validate_fit", { fit: { ship: "Rifter", modules: ["Large Shield Extender II", "200mm AutoCannon II", "200mm AutoCannon II", "200mm AutoCannon II", "200mm AutoCannon II"] } });
    assert.equal(r.valid, false);
    const codes = r.violations.map((v: any) => v.code);
    assert.ok(codes.includes("TURRET_HARDPOINTS") || codes.includes("SLOTS_EXCEEDED"), codes.join());
    assert.ok(r.violations.every((v: any) => typeof v.hint === "string"));
  });

  test("mcp.integration.actionable-errors: actionable errors", async () => {
    let e = await callErr(c, "compute_fit", { fit: { ship: "Rifterr", modules: [] } });
    assert.match(e, /did you mean 'Rifter'/);
    e = await callErr(c, "compute_fit", { eft: RIFTER_EFT, dna: "587::" });
    assert.match(e, /exactly one/);
    e = await callErr(c, "compute_fit", { fit: { ship: 587, modules: [{ type_id: 1 }] } });
    assert.match(e, /unknown type id 1/);
  });

  test("mcp.integration.export-roundtrip: export EFT round-trips", async () => {
    const eft = (await call(c, "export_fit", { eft: RIFTER_EFT, format: "eft", name: "rt" })).text;
    assert.match(eft, /^\[Rifter, rt\]/);
    const a = await call(c, "compute_fit", { eft: RIFTER_EFT });
    const b = await call(c, "compute_fit", { eft });
    assert.equal(a.metrics.dps, b.metrics.dps);
    const mb = (await call(c, "export_fit", { eft: RIFTER_EFT, format: "multibuy" })).text;
    assert.match(mb, /200mm AutoCannon II x3/);
  });

  test("mcp.integration.compare-fits: compare_fits builds a delta table", async () => {
    const r = await call(c, "compare_fits", {
      fits: [
        { eft: RIFTER_EFT, label: "EMP" },
        { eft: RIFTER_EFT.replaceAll("Republic Fleet EMP S", "Barrage S"), label: "Barrage" },
      ],
      metrics: ["dps", "weapon_range", "ehp"],
    });
    assert.deepEqual(r.fits, ["EMP", "Barrage"]);
    const range = r.rows.find((x: any) => x.metric === "weapon_range");
    assert.ok(range.values[1] > range.values[0], "Barrage reaches further");
    assert.match(r.table, /\| metric \| EMP \| Barrage \|/);
    assert.equal(r.rows.find((x: any) => x.metric === "ehp").delta[1], 0);
  });

  test("mcp.integration.what-if: what_if scenarios", async () => {
    const r = await call(c, "what_if", {
      eft: RIFTER_EFT,
      changes: [
        { op: "set_state", index: 4, state: "offline" },
        { op: "remove_module", index: 1 },
        { op: "set_skill", skill: "Small Projectile Turret", level: 3 },
        { op: "add_implant", type: "Eifyr and Co. 'Gunslinger' Small Projectile Turret SP-606" },
      ],
      metrics: ["dps", "speed", "cap_stability"],
    });
    const [mwdOff, noGyro, lowSkill] = r.results;
    assert.ok(mwdOff.metrics.speed.delta < 0, "MWD offline is slower");
    assert.ok(noGyro.metrics.dps.delta < 0);
    assert.ok(lowSkill.metrics.dps.delta < 0);
    assert.ok(r.results[3].metrics.dps.delta > 0, "damage implant adds dps");
    assert.match(r.table, /base/);
  });

  test("mcp.integration.suggest-modules: suggest_modules ranks by goal and respects constraints", async () => {
    const r = await call(c, "suggest_modules", { eft: RIFTER_EFT, replace_index: 1, goal: "dps", top: 5 });
    assert.equal(r.slot, "low");
    assert.ok(r.suggestions.length > 0);
    assert.ok(r.suggestions[0].goal.dps.delta > 0);
    for (let i = 1; i < r.suggestions.length; i++) assert.ok(r.suggestions[i - 1].score >= r.suggestions[i].score);
    const t2 = await call(c, "suggest_modules", { eft: RIFTER_EFT, replace_index: 1, goal: "ehp", constraints: { meta_max: 5 }, top: 3 });
    assert.ok(t2.suggestions.every((s: any) => s.meta_level <= 5));
    assert.ok(t2.suggestions[0].goal.ehp.delta > 0);
    // overloaded base (CPU): candidates may not make the overload worse; metric floors are enforced
    const c3 = await call(c, "suggest_modules", { eft: RIFTER_EFT, replace_index: 4, goal: "tank", constraints: { min: { cap_stability: 0 } }, top: 5 });
    assert.ok(c3.suggestions.length > 0);
    assert.ok(c3.suggestions.every((x: any) => x.fitting.cpu_free >= -29.75 - 1e-6), JSON.stringify(c3.suggestions.map((x: any) => x.fitting)));
    const bad = await callErr(c, "suggest_modules", { eft: RIFTER_EFT, replace_index: 4, goal: "tank", constraints: { min: { nope: 1 } } });
    assert.match(bad, /unknown metric/);
  });

  test("mcp.integration.optimize-fit: optimize_fit improves a goal within budget", async () => {
    const r = await call(c, "optimize_fit", { eft: RIFTER_EFT, goal: "ehp", slots: ["low"], budget: 150, lock: [0] });
    assert.ok(r.evaluated <= 150 + 5);
    const row = r.comparison.find((x: any) => x.metric === "ehp");
    assert.ok(row.after >= row.before);
    if (r.improved) assert.ok(row.after > row.before);
    assert.equal(r.request.modules[0].type_id, 2048, "locked DCU kept");
    assert.match(r.eft ?? "", /^\[Rifter/);
  });

  test("mcp.integration.suggest-drones: suggest_drones respects bandwidth, bay and skills", async () => {
    const r = await call(c, "suggest_drones", { eft: "[Vexor, v]\nDrone Damage Amplifier II\n\n\n\n\nHammerhead II x5", top: 5 });
    assert.equal(r.drone_bandwidth, 75);
    assert.equal(r.max_active, 5);
    assert.equal(r.current[0].drone, "Hammerhead II");
    assert.ok(r.ranked.length === 5 && r.ranked[0].goal.dps > 300);
    for (const x of r.ranked) assert.ok(x.active >= 1 && x.active <= 5 && x.quantity >= x.active, x.drone);
    const low = await call(c, "suggest_drones", { eft: "[Vexor, v]", skills: 3, top: 50 });
    assert.equal(low.max_active, 3);
    const firstMissing = low.ranked.findIndex((x: any) => x.missing_skills.length > 0);
    if (firstMissing >= 0) assert.ok(low.ranked.slice(firstMissing).every((x: any) => x.missing_skills.length > 0), "usable drones first");
    const err = await callErr(c, "suggest_drones", { eft: "[Rifter, r]" });
    assert.match(err, /no drone bay/);
  });

  test("mcp.integration.optimize-progress: optimize_fit sends progress notifications when asked", async () => {
    const seen: any[] = [];
    const res: any = await c.callTool({ name: "optimize_fit", arguments: { eft: RIFTER_EFT, goal: "dps", budget: 200 } }, undefined, { onprogress: (p) => seen.push(p) });
    assert.ok(!res.isError);
    const r = res.structuredContent ?? JSON.parse(res.content[res.content.length - 1].text);
    if (r.improved) {
      assert.ok(seen.length >= 1, "progress notifications");
      assert.equal(seen[0].total, 200);
      assert.ok(seen[0].progress <= 200);
      assert.match(seen[0].message, /^step 1:/);
    }
  });

  test("mcp.integration.skill-requirements-presets: skill_requirements and presets", async () => {
    const r = await call(c, "skill_requirements", { eft: RIFTER_EFT, skills: 0 });
    assert.ok(r.missing > 5);
    assert.ok(r.skills.some((s: any) => s.skill === "Minmatar Frigate" && s.missing));
    const ok = await call(c, "skill_requirements", { eft: RIFTER_EFT });
    assert.equal(ok.missing, 0);
    const p = await call(c, "list_presets", { kind: "all" });
    assert.ok(p.implant_sets.length >= 20);
    assert.ok(p.damage_profiles.find((d: any) => d.name === "guristas"));
  });

  test("mcp.integration.profiles-implant-sets: damage / target profiles and implant sets apply", async () => {
    const r = await call(c, "evaluate_profiles", { eft: RIFTER_EFT, target_profiles: ["frigate", "battleship"], damage_profiles: ["em", "explosive"] });
    const [frig, bs] = r.applied_dps;
    assert.ok(frig.applied_dps <= bs.applied_dps, "small guns apply at least as well to battleships");
    const [em, ex] = r.ehp;
    assert.notEqual(em.ehp, ex.ehp);
    const base = await call(c, "compute_fit", { eft: RIFTER_EFT });
    const snake = await call(c, "compute_fit", { eft: RIFTER_EFT, implant_set: "High-grade Snake" });
    assert.ok(snake.metrics.speed > base.metrics.speed);
  });

  test("mcp.integration.suggest-charges: suggest_charges ranks ammo per weapon type", async () => {
    const r = await call(c, "suggest_charges", { eft: RIFTER_EFT, goal: "weapon_range", top: 3 });
    assert.deepEqual(r.weapons.map((w: any) => w.weapon).sort(), ["200mm AutoCannon II", "Small Ancillary Armor Repairer"]);
    const w = r.weapons.find((x: any) => x.weapon === "200mm AutoCannon II");
    assert.deepEqual(w.modules, [7, 8, 9]);
    assert.ok(w.candidates > 5);
    assert.match(w.ranked[0].charge, /Barrage|Tremor|Spike|Carbonized|Nuclear/);
    const d = await call(c, "suggest_charges", { eft: RIFTER_EFT, top: 1, module_index: 7 });
    assert.equal(d.weapons.length, 1);
    assert.ok(d.weapons[0].ranked[0].dps >= 200);
  });

  test("mcp.integration.sweep: sweep gives graph series", async () => {
    const r = await call(c, "sweep", { eft: RIFTER_EFT, x: "target_signature", values: [20, 40, 400], target_profile: "frigate" });
    const pts = r.series[0].points;
    assert.equal(pts.length, 3);
    assert.ok(pts[0][1] <= pts[2][1], "bigger targets take more damage");
    const sk = await call(c, "sweep", { eft: RIFTER_EFT, x: "skill_level", y: ["dps"] });
    const v = sk.series[0].points.map((p: any) => p[1]);
    assert.equal(v.length, 6);
    for (let i = 1; i < v.length; i++) assert.ok(v[i] >= v[i - 1]);
  });

  test("mcp.integration.resources-prompts: resources and prompts", async () => {
    const { resources } = await c.listResources();
    assert.ok(resources.some((r) => r.uri === "eve://schema/fit-request"));
    const meta = await c.readResource({ uri: "eve://dataset/meta" });
    assert.match((meta.contents[0] as any).text, /sde_build/);
    const t = await c.readResource({ uri: "eve://type/587" });
    assert.match((t.contents[0] as any).text, /Rifter/);
    const lay = await c.readResource({ uri: "eve://ship/587/layout" });
    assert.match((lay.contents[0] as any).text, /hardpoints/);
    const schema = await c.readResource({ uri: "eve://schema/fit-request" });
    assert.ok(JSON.parse((schema.contents[0] as any).text).properties?.ship);
    const guide = await c.readResource({ uri: "eve://guide/fitting" });
    assert.match((guide.contents[0] as any).text, /Typical loop/);
    const { prompts } = await c.listPrompts();
    assert.deepEqual(prompts.map((p) => p.name).sort(), ["compare_options", "explain_stat", "fit_for_role", "review_fit"]);
    const p = await c.getPrompt({ name: "fit_for_role", arguments: { ship: "Rifter", activity: "solo PvP" } });
    assert.match((p.messages[0].content as any).text, /Rifter/);
  });
});
