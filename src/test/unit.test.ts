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
import { applyPriceInputs } from "../pricing-input.js";
import { batchTable, prepareBatch } from "../batch.js";
import { goalScore, metric } from "../metrics.js";
import { implantSets } from "../profiles.js";
import { DATASET } from "./helpers.js";
import { withPricesFlag, engineErrorFrom } from "../adapters/types.js";
import { resolvePriceFile } from "../price-file.js";

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
    const st: any = (await normalizeFit(ctx, { fit: { ship: "Rifter", modules: ["200mm AutoCannon II, EMP S /overheat", "Prototype Cloaking Device I /online", "Damage Control II /active"] } })).request;
    assert.deepEqual(st.modules.map((m: any) => m.state), ["overheated", "online", "active"]);
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

  test("mcp.unit.price-inputs: docs/23 price_overrides / prices / price go onto the FitRequest; names resolved, no pricing math", () => {
    const req: Record<string, any> = { ship: { type_id: 587 }, options: { validate: true } };
    applyPriceInputs(ds, req, {
      price_overrides: [{ type_id: "Rifter", price: 0 }, { type_id: 2873, multiplier: 0.9 }, { group_id: 55, price: 250000 }, { category_id: 8, multiplier: 1.1 }],
      prices: { isk: { "587": 350000 }, use_snapshot: false },
      price: true,
    });
    assert.deepEqual(req.price_overrides, [{ type_id: 587, price: 0 }, { type_id: 2873, multiplier: 0.9 }, { group_id: 55, price: 250000 }, { category_id: 8, multiplier: 1.1 }]);
    assert.deepEqual(req.prices, { isk: { "587": 350000 }, use_snapshot: false });
    assert.deepEqual(req.options, { validate: true, price: true });
    if (ds.marketGroups.size) {
      const r: Record<string, any> = {};
      applyPriceInputs(ds, r, { price_overrides: [{ market_group_id: "Ship Equipment", multiplier: 0.9 }] });
      assert.equal(r.price_overrides[0].market_group_id, 9);
    }
    // malformed entries are the engine's to judge (BAD_PRICE_OVERRIDE); only a non-list is rejected here
    assert.throws(() => applyPriceInputs(ds, {}, { price_overrides: {} as never }), (e: any) => e.code === "BAD_PRICE_OVERRIDE");
    const untouched: Record<string, any> = { ship: { type_id: 587 } };
    applyPriceInputs(ds, untouched, {});
    assert.deepEqual(untouched, { ship: { type_id: 587 } });
  });

  test("mcp.unit.batch-prepare: compute_batch normalises fit sources and names only; the rest of the BatchRequest is verbatim", async () => {
    const ctx = { ds, engine: noEngine, defaultSkillLevel: 5, maxBatch: 10 };
    const input = {
      fits: [
        { id: "a", fit: { ship: "Rifter", modules: ["125mm Gatling AutoCannon II, EMP S"] }, price_overrides: [{ type_id: "Rifter", price: 0 }] },
        { id: "b", fit: "587:2873;1::", skills: 3 },
      ],
      prices: { isk: { "587": 350000 } },
      price_overrides: [{ category_id: 8, multiplier: 1.1 }],
      fields: ["offense.total.dps.total", "price.total_isk"],
      sort_by: [{ field: "offense.total.dps.total", order: "desc" }],
      top_n: 1,
    };
    const { request: r, notes } = await prepareBatch(ctx, input);
    assert.equal(r.batch_version, 1);
    assert.equal(r.fits[0].fit.ship.type_id, 587);
    assert.equal(r.fits[0].fit.modules[0].type_id, 2873);
    assert.equal(r.fits[0].fit.modules[0].charge_type_id, ds.byExactName("EMP S")!.id);
    assert.equal(r.fits[0].fit.character.skills.default_level, 5);
    assert.deepEqual(r.fits[0].price_overrides, [{ type_id: 587, price: 0 }]);
    assert.equal(r.fits[1].fit.character.skills.default_level, 3);
    assert.ok(!("skills" in r.fits[1]));
    for (const k of ["prices", "price_overrides", "fields", "sort_by", "top_n"]) assert.deepEqual(r[k], (input as any)[k], k);
    assert.ok(Array.isArray(notes));
    // base + variants: swap_type names resolved, JSON Patch ops verbatim, per-variant overrides resolved
    const v = await prepareBatch(ctx, {
      base: { ship: "Rifter", modules: ["125mm Gatling AutoCannon I"] },
      variants: [{ id: "t2", patch: [{ op: "swap_type", from: "125mm Gatling AutoCannon I", to: "125mm Gatling AutoCannon II" }] }, { id: "heat", patch: [{ op: "replace", path: "/modules/0/state", value: "overheated" }], price_overrides: [{ type_id: "Rifter", price: 1 }] }],
      product: { axes: [{ name: "ammo", sweep: { path: "/modules/0/charge_type_id", values: [12608, 12614] } }] },
      deltas: true,
    }, 4);
    assert.equal(v.request.base.character.skills.default_level, 4);
    assert.deepEqual(v.request.variants[0].patch, [{ op: "swap_type", from: ds.byExactName("125mm Gatling AutoCannon I")!.id, to: 2873 }]);
    assert.deepEqual(v.request.variants[1].patch, [{ op: "replace", path: "/modules/0/state", value: "overheated" }]);
    assert.deepEqual(v.request.variants[1].price_overrides, [{ type_id: 587, price: 1 }]);
    assert.deepEqual(v.request.product.axes[0], { name: "ammo", sweep: { path: "/modules/0/charge_type_id", values: [12608, 12614] } });
    await assert.rejects(prepareBatch(ctx, { fits: [{ id: "x" }] }), (e: any) => e.code === "BATCH_BAD_REQUEST");
    // a fit the MCP cannot normalise goes to the engine unchanged (per-fit error in place, docs/23), with a note
    const bad = await prepareBatch(ctx, { fits: [{ fit: { ship: 999999999 } }] });
    assert.deepEqual(bad.request.fits[0].fit, { ship: 999999999 });
    assert.ok(bad.notes.some((n) => /^fits\/0\/fit: UNKNOWN_TYPE: .*passed to the engine unchanged/.test(n)), bad.notes.join("; "));
    await assert.rejects(prepareBatch(ctx, { base: { ship: 999999999 }, variants: [] }), (e: any) => e.code === "UNKNOWN_TYPE" && e.path === "base");
  });

  test("mcp.unit.batch-table: markdown view of a BatchResponse (values, deltas, per-fit errors)", () => {
    const t = batchTable({ form: "variants", total: 2, errors: 1, matched: 2, results: [
      { index: 0, id: "t2", label: "T2", stats: { "offense.total.dps.total": 211.3456 }, delta: { "offense.total.dps.total": 12.4 } },
      { index: 1, id: "bad", label: "bad", error: { code: "PATCH_FAILED", message: "/modules/9" } },
    ] });
    assert.match(t, /2 expanded, 1 errors/);
    assert.match(t, /\| 0 \| t2 \| T2 \| 211\.346 \(\+12\.4\) \|/);
    assert.match(t, /error PATCH_FAILED: \/modules\/9/);
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

test("mcp.unit.prices-flag: --prices FILE goes right after the binary (global flag), replaces an earlier one, null removes it", () => {
  assert.deepEqual(withPricesFlag(["eve-fit", "--dataset", "d.gz", "serve-stdio"], "/p.json"), ["eve-fit", "--prices", "/p.json", "--dataset", "d.gz", "serve-stdio"]);
  assert.deepEqual(withPricesFlag(["eve-fit", "--prices", "/a", "calc"], "/b"), ["eve-fit", "--prices", "/b", "calc"]);
  assert.deepEqual(withPricesFlag(["eve-fit", "--prices", "/a", "calc"], null), ["eve-fit", "calc"]);
});

test("mcp.unit.engine-error-details: engine error objects keep their extra fields (count, limit, reason) as details", () => {
  const e = engineErrorFrom({ code: "BATCH_TOO_LARGE", message: "too many", count: 2406, limit: 2000 });
  assert.deepEqual([e.code, e.message, e.path, e.details], ["BATCH_TOO_LARGE", "too many", undefined, { count: 2406, limit: 2000 }]);
  assert.equal(engineErrorFrom({ code: "X", message: "m", path: "fits/1" }).details, undefined);
});

test("mcp.unit.price-file-resolve: path / URL / latest (release asset, cache, offline)", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const d = mkdtempSync(join(tmpdir(), "efm-pf-"));
  writeFileSync(join(d, "m.json"), "{}");
  assert.equal((await resolvePriceFile(join(d, "m.json"), { cacheDir: d })).origin, "path");
  await assert.rejects(resolvePriceFile(join(d, "none.json"), { cacheDir: d }), /BAD_PRICES|not found/);
  const calls: string[] = [];
  const fake = (async (url: string) => {
    calls.push(url);
    if (url.endsWith("/releases/latest")) return new Response(JSON.stringify({ tag_name: "prices-jita44-20261003T070857Z", assets: [{ name: "prices-jita44-20261003T070857Z.json", size: 2, browser_download_url: "https://dl/x.json" }, { name: "prices-jita44-20261003T070857Z.json.gz", size: 3, browser_download_url: "https://dl/x.json.gz" }] }));
    if (url === "https://dl/x.json.gz") return new Response(new Uint8Array([1, 2, 3]));
    if (url === "https://h/p.json") return new Response("{}");
    return new Response("no", { status: 404 });
  }) as unknown as typeof fetch;
  const r = await resolvePriceFile("latest", { cacheDir: d, fetch: fake });
  assert.deepEqual([r.origin, r.release, r.path.endsWith("prices-jita44-20261003T070857Z.json.gz")], ["release", "prices-jita44-20261003T070857Z", true], "the .json.gz asset is preferred");
  await resolvePriceFile("latest", { cacheDir: d, fetch: fake });
  assert.equal(calls.filter((u) => u === "https://dl/x.json.gz").length, 1, "same size: not downloaded again");
  const off = await resolvePriceFile("latest", { cacheDir: d, offline: true, fetch: fake });
  assert.equal(off.origin, "release-cache");
  const down = await resolvePriceFile("latest", { cacheDir: d, fetch: (async () => new Response("x", { status: 503 })) as unknown as typeof fetch });
  assert.equal(down.origin, "release-cache", "network failure falls back to the newest cached snapshot");
  await assert.rejects(resolvePriceFile("latest", { cacheDir: join(d, "empty"), offline: true }), /PRICES_FETCH_FAILED|no cached/);
  assert.equal((await resolvePriceFile("https://h/p.json", { cacheDir: d, fetch: fake })).origin, "url");
});
