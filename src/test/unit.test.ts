// Engine-free unit tests: dataset index, DNA, metrics, command templates, fit normalisation.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { before, describe, test } from "node:test";
import type { EngineAdapter } from "../adapters/types.js";
import { loadConfig } from "../config.js";
import { Dataset } from "../dataset.js";
import { exportDna, parseDna } from "../dna.js";
import { normalizeFit, requestHash } from "../fit.js";
import { goalScore, metric } from "../metrics.js";
import { implantSets } from "../profiles.js";
import { DATASET } from "./helpers.js";

const noEngine = { kind: "none" } as unknown as EngineAdapter;

describe("dataset index", { skip: !existsSync(DATASET) && "dataset missing" }, () => {
  let ds: Dataset;
  before(() => {
    ds = new Dataset(DATASET);
  });

  test("mcp.unit.slots-hardpoints: slots, hardpoints, kinds", () => {
    const ac = ds.byExactName("200mm AutoCannon II")!;
    assert.equal(ac.slot, "high");
    assert.equal(ac.hardpoint, "turret");
    assert.equal(ds.byExactName("Damage Control II")!.slot, "low");
    assert.equal(ds.byExactName("Rifter")!.kind, "ship");
    assert.equal(ds.byExactName("Hobgoblin II")!.kind, "drone");
  });

  test("mcp.unit.can-fit: canFit: rig size and ship restrictions", () => {
    const rifter = ds.byExactName("Rifter")!;
    assert.equal(ds.canFit(ds.byExactName("Small Trimark Armor Pump I")!, rifter).ok, true);
    assert.equal(ds.canFit(ds.byExactName("Large Trimark Armor Pump I")!, rifter).ok, false);
  });

  test("mcp.unit.resolve-suggestions: resolve gives suggestions", () => {
    assert.throws(() => ds.resolve("Rifterr", ["ship"]), /did you mean 'Rifter'/);
    assert.equal(ds.resolve("587").id, 587);
    assert.equal(ds.resolve("dc", ["module"]).group, "Damage Control");
  });

  test("mcp.unit.skill-tree: skill tree includes prerequisites", () => {
    const tree = ds.skillTree(ds.byExactName("200mm AutoCannon II")!);
    const names = [...tree.keys()].map((id) => ds.type(id)!.name);
    assert.ok(names.includes("Small Autocannon Specialization"));
    assert.ok(names.includes("Gunnery"), "prerequisite of the specialization");
  });

  test("mcp.unit.implant-sets: implant sets", () => {
    const sets = implantSets(ds);
    const crystal = sets.find((s) => s.name === "High-grade Crystal")!;
    assert.equal(crystal.implants.length, 6);
    assert.match(crystal.implants[0].name, /Alpha$/);
  });

  test("mcp.unit.dna-roundtrip: DNA round trip with charges loaded", () => {
    const req: any = parseDna(ds, "587:2889;3:2048;1:21898;3:2488;2::");
    assert.equal(req.ship.type_id, 587);
    assert.equal(req.modules.length, 4);
    assert.equal(req.modules.filter((m: any) => m.charge_type_id === 21898).length, 3);
    assert.deepEqual(req.drones, [{ type_id: 2488, quantity: 2, active: 2 }]);
    const dna = exportDna(ds, req);
    const again: any = parseDna(ds, dna);
    assert.deepEqual(again.modules.map((m: any) => m.type_id).sort(), req.modules.map((m: any) => m.type_id).sort());
  });

  test("mcp.unit.lenient-normalise: lenient fit normalisation and hash", async () => {
    const ctx = { ds, engine: noEngine, defaultSkillLevel: 5, maxBatch: 10 };
    const a = await normalizeFit(ctx, { fit: { ship: "Rifter", modules: ["200mm AutoCannon II, EMP S", "Damage Control II /offline"], drones: ["Warrior II x2"], implants: ["High-grade Snake Alpha"] }, skills: { default_level: 4, levels: { Gunnery: 5 } } });
    const r: any = a.request;
    assert.equal(r.modules[0].charge_type_id, ds.byExactName("EMP S")!.id);
    assert.equal(r.modules[1].state, "offline");
    assert.equal(r.drones[0].quantity, 2);
    assert.equal(r.character.skills.default_level, 4);
    assert.equal(r.character.skills.levels[String(ds.byExactName("Gunnery")!.id)], 5);
    const b = await normalizeFit(ctx, { fit: JSON.parse(JSON.stringify(r)) });
    assert.equal(a.hash, b.hash);
    assert.equal(requestHash({ b: 1, a: 2 }), requestHash({ a: 2, b: 1 }));
  });

  // regressions from eve3's bench run through MCP 8c6b93d (tools/mcp_batch.py): 13 core / 4 ext / 2 ext-unit cases
  // sent `fleet: {booster_fits: []}` inside projected / booster fits and were rejected as "cannot nest"
  test("mcp.unit.empty-nested-arrays: empty fleet.booster_fits / projected / buffs are accepted at every depth", async () => {
    const ctx = { ds, engine: noEngine, defaultSkillLevel: 5, maxBatch: 10 };
    const empty = { booster_fits: [], buffs: [] };
    const inner = { ship: { type_id: 587 }, modules: [], fleet: empty, projected: [] };
    const a = await normalizeFit(ctx, {
      fit: { ship: "Rifter", modules: [], fleet: { booster_fits: [inner], buffs: [] }, projected: [{ kind: "fit", fit: inner }] },
    });
    const r: any = a.request;
    assert.equal(r.fleet.booster_fits.length, 1);
    assert.deepEqual(r.fleet.booster_fits[0].fleet.booster_fits, []);
    assert.deepEqual(r.projected[0].fit.fleet.booster_fits, []);
    assert.deepEqual(r.projected[0].fit.projected, []);
    // a non-empty nested list is still an error (the contract allows one level)
    await assert.rejects(normalizeFit(ctx, { fit: { ship: "Rifter", projected: [{ kind: "fit", fit: { ...inner, projected: [{ kind: "fit", fit: inner }] } }] } }), /cannot nest/);
  });

  // projected fighters without a quantity became 1 fighter; the engine's default is the full squadron
  test("mcp.unit.projected-fighter-default-quantity: no quantity is left to the engine (full squadron); explicit counts kept", async () => {
    const ctx = { ds, engine: noEngine, defaultSkillLevel: 5, maxBatch: 10 };
    const id = ds.byExactName("Templar II")!.id;
    const a: any = (await normalizeFit(ctx, { fit: { ship: "Rifter", projected: [{ kind: "fighter", fighter: { type_id: id } }, { kind: "fighter", fighter: { type_id: id, quantity: 4 } }, { kind: "fighter", fighter: "Templar II x3" }] } })).request;
    assert.equal(a.projected[0].fighter.type_id, id);
    assert.ok(!("quantity" in a.projected[0].fighter), JSON.stringify(a.projected[0]));
    assert.equal(a.projected[1].fighter.quantity, 4);
    assert.equal(a.projected[2].fighter.quantity, 3);
  });
});

test("mcp.unit.metrics-goal-score: metrics and goal score", () => {
  const s: any = { offense: { total: { dps: { total: 110 } } }, navigation: { align_time_s: 4 } };
  const b: any = { offense: { total: { dps: { total: 100 } } }, navigation: { align_time_s: 5 } };
  assert.equal(metric("dps").get(s), 110);
  assert.ok(Math.abs(goalScore([{ metric: "dps" }], s, b) - 0.1) < 1e-12);
  assert.ok(goalScore([{ metric: "align" }], s, b) > 0, "lower align is better");
  assert.throws(() => metric("nope"), /unknown metric/);
});

test("mcp.unit.default-engine: default engine is F (eve-fit from EX-CT/eve-dogma); EVE_DOGMA_BIN selects another", () => {
  assert.equal(loadConfig({}).bin, "eve-fit");
  assert.equal(loadConfig({ EVE_DOGMA_BIN: "eve-dogma-f" }).bin, "eve-dogma-f");
  assert.equal(loadConfig({ EVE_DOGMA_BIN: "/opt/eve-dogma-rs/eve-dogma" }).bin, "/opt/eve-dogma-rs/eve-dogma");
  assert.equal(loadConfig({}).rpcCmd, "{bin} --dataset {dataset} serve-stdio");
});

test("mcp.unit.test-ids: every test title starts with a unique stable id mcp.<file>.<slug>", () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const seen = new Set<string>();
  for (const f of readdirSync(dir).filter((x) => /\.test\.[jt]s$/.test(x))) {
    const file = f.replace(/\.test\.[jt]s$/, "");
    for (const m of readFileSync(`${dir}/${f}`, "utf8").matchAll(/\btest\(\s*(["'`])(.*?)\1/g)) {
      const id = /^(mcp\.([a-z]+)\.[a-z0-9]+(?:-[a-z0-9]+)*): \S/.exec(m[2]);
      assert.ok(id, `${f}: test title without id: ${m[2]}`);
      assert.equal(id![2], file, `${f}: id ${id![1]} names the wrong file`);
      assert.ok(!seen.has(id![1]), `duplicate test id ${id![1]}`);
      seen.add(id![1]);
    }
  }
  assert.ok(seen.size >= 50, `only ${seen.size} ids found`);
});
