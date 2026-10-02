// Engine-free unit tests: dataset index, DNA, metrics, command templates, fit normalisation.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { before, describe, test } from "node:test";
import type { EngineAdapter } from "../adapters/types.js";
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

  test("slots, hardpoints, kinds", () => {
    const ac = ds.byExactName("200mm AutoCannon II")!;
    assert.equal(ac.slot, "high");
    assert.equal(ac.hardpoint, "turret");
    assert.equal(ds.byExactName("Damage Control II")!.slot, "low");
    assert.equal(ds.byExactName("Rifter")!.kind, "ship");
    assert.equal(ds.byExactName("Hobgoblin II")!.kind, "drone");
  });

  test("canFit: rig size and ship restrictions", () => {
    const rifter = ds.byExactName("Rifter")!;
    assert.equal(ds.canFit(ds.byExactName("Small Trimark Armor Pump I")!, rifter).ok, true);
    assert.equal(ds.canFit(ds.byExactName("Large Trimark Armor Pump I")!, rifter).ok, false);
  });

  test("resolve gives suggestions", () => {
    assert.throws(() => ds.resolve("Rifterr", ["ship"]), /did you mean 'Rifter'/);
    assert.equal(ds.resolve("587").id, 587);
    assert.equal(ds.resolve("dc", ["module"]).group, "Damage Control");
  });

  test("skill tree includes prerequisites", () => {
    const tree = ds.skillTree(ds.byExactName("200mm AutoCannon II")!);
    const names = [...tree.keys()].map((id) => ds.type(id)!.name);
    assert.ok(names.includes("Small Autocannon Specialization"));
    assert.ok(names.includes("Gunnery"), "prerequisite of the specialization");
  });

  test("implant sets", () => {
    const sets = implantSets(ds);
    const crystal = sets.find((s) => s.name === "High-grade Crystal")!;
    assert.equal(crystal.implants.length, 6);
    assert.match(crystal.implants[0].name, /Alpha$/);
  });

  test("DNA round trip with charges loaded", () => {
    const req: any = parseDna(ds, "587:2889;3:2048;1:21898;3:2488;2::");
    assert.equal(req.ship.type_id, 587);
    assert.equal(req.modules.length, 4);
    assert.equal(req.modules.filter((m: any) => m.charge_type_id === 21898).length, 3);
    assert.deepEqual(req.drones, [{ type_id: 2488, quantity: 2, active: 2 }]);
    const dna = exportDna(ds, req);
    const again: any = parseDna(ds, dna);
    assert.deepEqual(again.modules.map((m: any) => m.type_id).sort(), req.modules.map((m: any) => m.type_id).sort());
  });

  test("lenient fit normalisation and hash", async () => {
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
});

test("metrics and goal score", () => {
  const s: any = { offense: { total: { dps: { total: 110 } } }, navigation: { align_time_s: 4 } };
  const b: any = { offense: { total: { dps: { total: 100 } } }, navigation: { align_time_s: 5 } };
  assert.equal(metric("dps").get(s), 110);
  assert.ok(Math.abs(goalScore([{ metric: "dps" }], s, b) - 0.1) < 1e-12);
  assert.ok(goalScore([{ metric: "align" }], s, b) > 0, "lower align is better");
  assert.throws(() => metric("nope"), /unknown metric/);
});
