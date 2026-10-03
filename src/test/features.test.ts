// Milestone tools (docs/20 P1-7): graphs (engine graph RPC, CONTRACT-GRAPHS 0.2), market tree, prices; plus dedicated
// passthrough tests (mutations, overrides, projected, fleet, environment, fighters). Real server, real engine, real dataset;
// prices against a local mock of ESI / Fuzzwork (no internet in tests).
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { after, before, describe, test } from "node:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Dataset } from "../dataset.js";
import { browseMarket, resolveGroup, variations } from "../market.js";
import { fitItems, PriceService, priceConfig } from "../prices.js";
import { call, callErr, connect, DATASET, GO_BIN, haveEngine, RIFTER_EFT } from "./helpers.js";

const ds = existsSync(DATASET) ? new Dataset(DATASET) : null;
const hasMarket = !!ds && ds.marketGroups.size > 0;

// ------------------------------------------------------------------------------------------- market (index only)
describe("market tree (MKT-001, variations)", { skip: !hasMarket && "dataset without market_groups (needs eve-sde-pipeline r4+)" }, () => {
  test("mcp.features.market-roots: roots and path resolution", () => {
    const root = browseMarket(ds!, {});
    const names = root.children.map((c) => c.name);
    for (const n of ["Ships", "Ship Equipment", "Drones", "Ammunition & Charges", "Implants & Boosters"]) assert.ok(names.includes(n), `root ${n} missing: ${names}`);
    assert.ok(!names.includes("Blueprints & Reactions"), "empty groups are hidden");
    assert.ok(browseMarket(ds!, { include_empty: true }).children.length > root.children.length);
    const g = resolveGroup(ds!, "Ship Equipment/Turrets & Launchers/Projectile Turrets/Autocannons/Small");
    const r = browseMarket(ds!, { group: g.id });
    assert.deepEqual(r.group!.path.map((p) => p.name).slice(0, 2), ["Ship Equipment", "Turrets & Launchers"]);
    assert.ok(r.types.some((t) => t.name === "200mm AutoCannon II" && t.meta_group === "Tech II"));
    assert.ok(r.group!.name_zh, "zh market group name");
  });
  test("mcp.features.market-meta-filter: meta filter, depth, ambiguity", () => {
    const g = resolveGroup(ds!, "Projectile Turrets/Autocannons/Small");
    const t2 = browseMarket(ds!, { group: g.id, meta_groups: ["T2"] });
    assert.ok(t2.types.length > 0 && t2.types.every((t) => t.meta_group === "Tech II"), JSON.stringify(t2.types));
    const deep = browseMarket(ds!, { group: "Ship Equipment", depth: 2 });
    assert.ok(deep.children.some((c) => c.children?.some((cc) => cc.children?.length)));
    assert.throws(() => resolveGroup(ds!, "Small"), /ambiguous/);
    assert.throws(() => browseMarket(ds!, { group: g.id, meta_groups: ["Nope"] }), /unknown meta group/);
  });
  test("mcp.features.market-variations: variations (meta family)", () => {
    const v = variations(ds!, ds!.resolve("200mm AutoCannon II")).map((x) => x.name);
    assert.ok(v.includes("200mm AutoCannon I") && v.includes("200mm AutoCannon II"), v.join(", "));
    assert.ok(v.some((n) => /Republic Fleet|Domination/.test(n)), v.join(", "));
    assert.equal(v[0], "200mm AutoCannon I");
  });
});

// ------------------------------------------------------------------------------------------- prices (mock sources)
type Mock = { server: Server; url: string; hits: string[]; down: boolean };
async function mockMarket(): Promise<Mock> {
  const m: Mock = { server: null as any, url: "", hits: [], down: false };
  m.server = createServer((req, res) => {
    m.hits.push(req.url ?? "");
    if (m.down) return void (res.writeHead(503), res.end());
    if (req.url?.startsWith("/esi/markets/prices/")) {
      res.writeHead(200, { "content-type": "application/json", expires: new Date(Date.now() + 3600_000).toUTCString() });
      // Rifter 500k, 200mm AC II 100k, EMP S 50, Warrior II 20k; everything else unpriced
      return void res.end(JSON.stringify([
        { type_id: 587, average_price: 500000, adjusted_price: 480000 },
        { type_id: 2889, average_price: 100000, adjusted_price: 90000 },
        { type_id: 21898, average_price: 50 },
        { type_id: 2488, adjusted_price: 20000 },
      ]));
    }
    if (req.url?.startsWith("/fw/aggregates/")) {
      const u = new URL(req.url, "http://x");
      const out: Record<string, unknown> = {};
      for (const id of (u.searchParams.get("types") ?? "").split(",")) out[id] = { sell: { percentile: id === "587" ? "600000" : "0" }, buy: { percentile: id === "587" ? "550000" : "0" } };
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ ...out, system: u.searchParams.get("system") }));
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => m.server.listen(0, "127.0.0.1", () => r()));
  m.url = `http://127.0.0.1:${(m.server.address() as any).port}`;
  return m;
}

describe("prices (PRC-001..003): sources, cache, offline", () => {
  let m: Mock;
  let dir: string;
  before(async () => {
    m = await mockMarket();
    dir = mkdtempSync(join(tmpdir(), "eve-fit-prices-"));
  });
  after(() => {
    m.server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const env = (extra: Record<string, string> = {}) =>
    priceConfig({ EVE_FIT_ESI_URL: `${m.url}/esi`, EVE_FIT_FUZZWORK_URL: `${m.url}/fw`, EVE_FIT_PRICE_CACHE: dir, ...extra } as any);

  test("mcp.features.prices-esi: esi: average price, adjusted fallback, one request then cached (memory and disk)", async () => {
    const p = new PriceService(env());
    const r = await p.lookup([587, 2488, 99999999]);
    assert.equal(r.source, "esi");
    assert.equal(r.prices.get(587)!.price, 500000);
    assert.equal(r.prices.get(2488)!.price, 20000, "adjusted_price when no average");
    assert.equal(r.prices.get(99999999)!.price, null);
    assert.equal(r.stale, false);
    const n = m.hits.length;
    await p.lookup([587]);
    assert.equal(m.hits.length, n, "memory cache");
    assert.ok(readdirSync(dir).includes("prices-esi-universe.json"));
    m.down = true;
    const r2 = await new PriceService(env()).lookup([587]); // fresh process: disk cache, still within Expires
    assert.equal(r2.prices.get(587)!.price, 500000);
    assert.equal(r2.stale, false);
    m.down = false;
  });

  test("mcp.features.prices-fuzzwork: fuzzwork: trade hub sell percentile; unknown hub/source errors", async () => {
    const p = new PriceService(env());
    const r = await p.lookup([587, 2889], { source: "fuzzwork", system: "amarr" });
    assert.equal(r.prices.get(587)!.price, 600000);
    assert.equal(r.prices.get(587)!.buy, 550000);
    assert.equal(r.prices.get(2889)!.price, null, "zero percentile = no market");
    assert.ok(m.hits.some((h) => h.includes("system=30002187")), "Amarr system id");
    await assert.rejects(p.lookup([587], { source: "fuzzwork", system: "nowhere" }), /unknown trade hub/);
    await assert.rejects(p.lookup([587], { source: "evemarketer" }), /unknown price source/);
  });

  test("mcp.features.prices-offline: offline / network failure: stale cache, never-priced items null", async () => {
    const off = await new PriceService(env({ EVE_FIT_OFFLINE: "1", EVE_FIT_PRICE_TTL_S: "0" })).lookup([587, 2889], { source: "fuzzwork", system: "amarr" });
    assert.equal(off.stale, true);
    assert.equal(off.prices.get(587)!.price, 600000);
    assert.ok(off.notes.some((n) => /offline/.test(n)));
    m.down = true;
    const down = await new PriceService(env({ EVE_FIT_PRICE_TTL_S: "0" })).lookup([587, 34], { source: "fuzzwork", system: "amarr" });
    m.down = false;
    assert.equal(down.stale, true);
    assert.equal(down.prices.get(587)!.price, 600000);
    assert.equal(down.prices.get(34)!.price, null);
    assert.ok(down.notes.some((n) => /fetch failed/.test(n)), down.notes.join("; "));
    const empty = await new PriceService(priceConfig({ EVE_FIT_OFFLINE: "1", EVE_FIT_PRICE_CACHE: "off" } as any)).lookup([587]);
    assert.equal(empty.prices.get(587)!.price, null);
  });

  test("mcp.features.prices-fit-items: fitItems: sections and quantities", () => {
    const items = fitItems(
      { ship: { type_id: 587 }, modules: [{ type_id: 2889, charge_type_id: 21898 }, { type_id: 2889, charge_type_id: 21898 }], drones: [{ type_id: 2488, quantity: 2 }], cargo: [{ type_id: 21898, quantity: 100 }], implants: [10228], boosters: [{ type_id: 15466 }] },
      () => 100,
    );
    const q = Object.fromEntries(items.map((i) => [`${i.section}:${i.type_id}`, i.quantity]));
    assert.deepEqual(q, { "ship:587": 1, "fittings:2889": 2, "charges:21898": 200, "drones:2488": 2, "cargo:21898": 100, "implants:10228": 1, "boosters:15466": 1 });
  });

  describe("price_fit / get_prices tools", { skip: !haveEngine && "engine or dataset missing" }, () => {
    let c: Client;
    before(async () => {
      c = await connect({ EVE_FIT_ESI_URL: `${m.url}/esi`, EVE_FIT_FUZZWORK_URL: `${m.url}/fw`, EVE_FIT_PRICE_CACHE: dir });
    });
    after(async () => c?.close());
    test("mcp.features.price-fit: price_fit: Pyfa price panel sections, charges per full load, toggles", async () => {
      // use_snapshot:false: only the (mocked) market prices, so the numbers are exact; the snapshot fallback is checked below
      const r = await call(c, "price_fit", { eft: RIFTER_EFT, use_snapshot: false });
      const per = Math.floor(ds!.type(2889)!.capacity / ds!.type(21898)!.volume + 1e-9);
      const nod = await call(c, "price_fit", { eft: RIFTER_EFT, include_drones: false, use_snapshot: false });
      assert.deepEqual(nod.excluded, ["drones", "fighters"]);
      if (r.priced_by === "engine") {
        // docs/23 price block (engine prices; the MCP injects the market table): eight sections always present,
        // charges = floor(launcher capacity / charge volume) per loaded module, unpriced lines only in `missing`
        const p = r.price;
        assert.equal(r.market_source, "esi");
        assert.deepEqual(Object.keys(p.sections).sort(), ["boosters", "cargo", "charges", "drones", "fighters", "implants", "modules", "ship"]);
        assert.equal(p.sections.ship.total_isk, 500000);
        assert.equal(p.sections.ship.items[0].kind, "ship");
        assert.equal(p.sections.modules.total_isk, 300000);
        const ch = p.sections.charges.items.filter((x: any) => x.type_id === 21898);
        assert.equal(ch.length, 3);
        for (const x of ch) assert.equal(x.quantity, per), assert.equal(x.unit_isk, 50), assert.equal(x.source, "injected");
        assert.equal(p.sections.charges.total_isk, 50 * 3 * per);
        assert.equal(p.sections.drones.total_isk, 20000);
        assert.equal(p.sections.fighters.total_isk, 0);
        assert.equal(p.total_isk, 500000 + 300000 + 50 * 3 * per + 20000, "unpriced items (paste, plates, …) are listed in missing, not in the total");
        assert.equal(r.total_isk, p.total_isk);
        assert.equal(p.complete, false);
        assert.ok(p.missing.some((x: any) => x.name === "Damage Control II" && x.reason === "no_price"));
        assert.ok(p.missing.some((x: any) => x.name === "Nanite Repair Paste"));
        assert.equal(nod.total_isk, p.total_isk - 20000);
        assert.equal(nod.price.total_isk, p.total_isk, "the engine block is unchanged; the toggle only changes total_isk");
        if (r.provenance?.price_snapshot_id !== undefined) {
          // docs/22: an engine with an embedded snapshot fills items without a market price from it (layer L4)
          assert.equal(r.provenance.price_source, "request", "the MCP's market table is the request's base table");
          const d = await call(c, "price_fit", { eft: RIFTER_EFT });
          const dc = d.price.sections.modules.items.find((x: any) => x.name === "Damage Control II");
          assert.ok(dc && dc.source === "snapshot" && dc.unit_isk > 0, JSON.stringify(dc));
          assert.equal(d.price.sections.ship.items[0].source, "injected", "market price wins over the snapshot");
          assert.ok(d.total_isk > p.total_isk);
        }
        return;
      }
      assert.equal(r.source, "esi");
      assert.equal(r.sections.ship, 500000);
      assert.equal(r.sections.fittings, 300000);
      const ch = r.items.find((x: any) => x.section === "charges" && x.type_id === 21898);
      assert.equal(ch.quantity, 3 * per);
      assert.equal(ch.value, 50 * 3 * per);
      assert.equal(r.sections.drones, 20000);
      assert.equal(r.total, 500000 + 300000 + 50 * 3 * per + 20000, "unpriced items (paste, plates, …) add 0");
      assert.ok(r.items.some((x: any) => x.section === "charges" && x.name === "Nanite Repair Paste" && x.unit_price === null));
      assert.ok(r.missing.includes("Damage Control II"));
      assert.equal(nod.total, r.total - 20000);
      assert.equal(r.priced_by, "mcp-legacy");
    });
    test("mcp.features.price-fit-engine: price_fit hands market prices (+ own isk) and overrides to the engine; legacy sum only for old engines", async () => {
      const own = await call(c, "price_fit", { eft: RIFTER_EFT, isk: { "2048": 900000 } });
      if (own.priced_by === "engine") {
        // docs/23: market table injected (L3), own isk wins per type, override fixed 0 (L2) stops the chain
        const o = await call(c, "price_fit", { eft: RIFTER_EFT, isk: { "2048": 900000 }, price_overrides: [{ type_id: "Rifter", price: 0 }] });
        assert.equal(own.price.sections.ship.items[0].unit_isk, 500000);
        assert.ok(own.price.sections.modules.items.some((x: any) => x.type_id === 2048 && x.unit_isk === 900000));
        assert.equal(o.price.sections.ship.items[0].unit_isk, 0);
        assert.equal(o.price.sections.ship.items[0].source, "override:type");
        assert.equal(o.price.total_isk, own.price.total_isk - 500000);
        return;
      }
      assert.equal(own.priced_by, "mcp-legacy");
      assert.equal(own.items.find((x: any) => x.type_id === 2048).unit_price, 900000, "own isk used by the legacy path too");
      assert.ok(!own.missing.includes("Damage Control II"));
      assert.match(await callErr(c, "price_fit", { eft: RIFTER_EFT, price_overrides: [{ type_id: 587, price: 0 }] }), /^Error: UNSUPPORTED: price_overrides need an engine with docs\/23/);
      const fw = await call(c, "get_prices", { types: ["Rifter"], source: "fuzzwork", system: "jita" });
      assert.equal(fw.prices[0].price, 600000);
      assert.equal(fw.system, "jita");
    });
  });
});

// ------------------------------------------------------------------------------------------- graphs + passthrough (engine)
describe("graphs and passthrough features (engine)", { skip: !haveEngine && "engine or dataset missing" }, () => {
  let c: Client;
  let graphs = false;
  before(async () => {
    c = await connect();
    const r: any = await c.callTool({ name: "list_graphs", arguments: {} });
    graphs = !r.isError;
  });
  after(async () => c?.close());

  test("mcp.features.list-graphs: list_graphs: the 10 Pyfa graphs, CONTRACT-GRAPHS 0.2", async (t) => {
    if (!graphs) return t.skip("engine has no graph RPC");
    const r = await call(c, "list_graphs", {});
    assert.match(r.contract, /0\.2/);
    const names = r.graphs.map((g: any) => g.graph).sort();
    assert.deepEqual(names, ["application_profile", "capacitor", "damage", "ecm_burst", "ewar", "lock_time", "mobility", "remote_reps", "shield_regen", "warp_time"]);
    const dmg = r.graphs.find((g: any) => g.graph === "damage");
    assert.equal(dmg.uses_target, true);
    assert.ok(dmg.axes.some((a: any) => a.axis === "distance_m" && a.unit === "m"));
  });

  // regressions from eve3's bench run (graphs errors group 8/20 through MCP 8c6b93d): tool errors carry the engine's
  // contract code ("Error: CODE: message"), MCP-side input errors are BAD_REQUEST, explicit x / y go to the engine as given
  test("mcp.features.contract-error-codes: engine error codes pass through verbatim; MCP input errors are BAD_REQUEST", async (t) => {
    if (!graphs) return t.skip("engine has no graph RPC");
    const g = { eft: RIFTER_EFT, graph: "damage", x: { values: [0, 1000] }, y: ["dps"] };
    assert.match(await callErr(c, "compute_graph", { ...g, eft: undefined, fit: { ship: { type_id: 999999999 }, modules: [] } }), /^Error: UNKNOWN_TYPE: /);
    assert.match(await callErr(c, "compute_fit", { fit: { ship: "Rifter", modules: [{ type_id: 999999998, slot: "low" }] } }), /^Error: UNKNOWN_TYPE: /);
    assert.match(await callErr(c, "compute_graph", { ...g, eft: undefined }), /^Error: BAD_REQUEST: give exactly one of/);
    assert.match(await callErr(c, "compute_graph", { ...g, graph: null }), /^Error: BAD_REQUEST: graph is required/);
    assert.match(await callErr(c, "compute_graph", { ...g, graph: "nope" }), /^Error: UNKNOWN_GRAPH: /);
    assert.match(await callErr(c, "compute_graph", { ...g, x: { values: [0, "1000"] } }), /^Error: BAD_REQUEST: x\.values\[1\]/);
    assert.match(await callErr(c, "compute_graph", { ...g, x: { values: [0, null] } }), /^Error: BAD_REQUEST: x\.values\[1\]/);
    assert.match(await callErr(c, "compute_graph", { ...g, y: [] }), /^Error: BAD_REQUEST: /);
    assert.match(await callErr(c, "compute_graph", { ...g, target: { eft: RIFTER_EFT, resist_mode: "plasma" } }), /^Error: BAD_REQUEST: /);
    const empty = await call(c, "compute_graph", { ...g, x: { values: [] }, y: ["dps", "volley"] });
    assert.deepEqual(empty.x, []);
    assert.deepEqual(empty.series, { dps: [], volley: [] });
  });

  test("mcp.features.price-passthrough: compute_fit sends docs/23 price inputs to the engine and returns its price block verbatim", async (t) => {
    const r = await call(c, "compute_fit", {
      fit: { ship: "Rifter", modules: ["125mm Gatling AutoCannon II, EMP S"] },
      price_overrides: [{ type_id: "125mm Gatling AutoCannon II", price: 0 }, { category_id: 6, multiplier: 0.9 }],
      prices: { isk: { "587": 350000, "2873": 1250000 } },
      price: true,
      include_request: true,
    });
    assert.deepEqual(r.request.price_overrides, [{ type_id: 2873, price: 0 }, { category_id: 6, multiplier: 0.9 }]);
    assert.deepEqual(r.request.prices, { isk: { "587": 350000, "2873": 1250000 } });
    assert.equal(r.request.options.price, true);
    if (r.price === undefined) return t.todo("engine without docs/23 prices (eve-dogma before 197223f): no price block yet");
    // engine semantics (docs/23 §5.2): gun fixed 0 (L2), ship 0.9 x injected 350000
    assert.equal(r.price.sections.ship.items[0].unit_isk, 315000);
    assert.equal(r.price.sections.modules.items[0].unit_isk, 0);
    assert.equal(r.price.sections.modules.items[0].source, "override:type");
  });

  test("mcp.features.provenance: compute_fit and compute_batch return the engine's provenance (sde_build, sde_hash, price_source, snapshot_time)", async (t) => {
    const f = await call(c, "compute_fit", { eft: RIFTER_EFT });
    if (f.provenance === undefined) return t.todo("engine without docs/23 provenance (eve-dogma before 8bde0ba)");
    for (const k of ["sde_build", "sde_hash", "price_source", "snapshot_time"]) assert.ok(k in f.provenance, k);
    assert.equal(f.provenance.sde_build, ds!.sdeBuild);
    assert.match(f.provenance.sde_hash, /^sha256:[0-9a-f]{64}$/);
    const full = await call(c, "compute_fit", { eft: RIFTER_EFT, detail: "full", sections: ["provenance"] });
    assert.deepEqual(full.provenance, f.provenance);
    const req = await call(c, "compute_fit", { eft: RIFTER_EFT, prices: { isk: { "587": 1 } } });
    assert.equal(req.provenance.price_source, "request");
    assert.equal(req.provenance.snapshot_time, null);
    const r: any = await c.callTool({ name: "compute_batch", arguments: { request: { fits: [{ id: "a", fit: RIFTER_EFT }, { id: "b", fit: RIFTER_EFT }], fields: ["navigation.max_velocity_m_s"] } } });
    assert.ok(!r.isError, r.content?.[0]?.text);
    const b = r.structuredContent;
    assert.deepEqual(b.provenance, f.provenance, "batch top level = the session's provenance");
    assert.ok(b.results.every((x: any) => x.provenance && x.provenance.sde_hash === f.provenance.sde_hash));
    assert.ok(r.content.some((x: any) => x.type === "text" && /provenance: sde_build \d+ \(sha256:/.test(x.text)), "table shows provenance");
  });

  test("mcp.features.compute-batch: compute_batch passes the BatchRequest to the engine; results equal compute_fit one by one", async (t) => {
    const req = {
      base: { ship: "Rifter", modules: ["125mm Gatling AutoCannon I, EMP S", "125mm Gatling AutoCannon I, EMP S"] },
      variants: [{ id: "t2", label: "T2 guns", patch: [{ op: "swap_type", from: "125mm Gatling AutoCannon I", to: "125mm Gatling AutoCannon II" }] }],
      fields: ["offense.total.dps.total"],
      deltas: true,
    };
    const r: any = await c.callTool({ name: "compute_batch", arguments: { request: req } });
    if (r.isError) {
      // the error must carry the engine's code verbatim (UNKNOWN_METHOD on engines before docs/23)
      assert.match(r.content[0].text, /^Error: UNKNOWN_METHOD: the engine has no `batch` method/);
      return t.todo("engine without docs/23 batch (eve-dogma before 197223f)");
    }
    const b = r.structuredContent;
    assert.equal(b.form, "variants");
    const one = await call(c, "compute_fit", { fit: { ship: "Rifter", modules: ["125mm Gatling AutoCannon II, EMP S", "125mm Gatling AutoCannon II, EMP S"] }, detail: "full", sections: ["offense"] });
    assert.equal(b.results[0].stats["offense.total.dps.total"], one.offense.total.dps.total);
    assert.ok(b.results[0].delta["offense.total.dps.total"] > 0);
  });

  test("mcp.features.compute-graph-stats: compute_graph: lock time and mobility agree with the fit stats; damage vs a target profile", async (t) => {
    if (!graphs) return t.skip("engine has no graph RPC");
    const full = await call(c, "compute_fit", { eft: RIFTER_EFT, detail: "full", sections: ["targeting", "navigation"] });
    const lock = await call(c, "compute_graph", { eft: RIFTER_EFT, graph: "lock_time", x: { values: [40, 125, 400] } });
    assert.equal(lock.x_axis, "tgt_sig_m");
    assert.deepEqual(lock.x, [40, 125, 400]);
    assert.ok(Math.abs(lock.series.time_s[0] - full.targeting.lock_time_s.sig_40m) < 1e-3, `${lock.series.time_s[0]} vs ${full.targeting.lock_time_s.sig_40m}`);
    assert.ok(Math.abs(lock.series.time_s[2] - full.targeting.lock_time_s.sig_400m) < 1e-3);
    const mob = await call(c, "compute_graph", { eft: RIFTER_EFT, graph: "mobility", y: ["speed_mps"], x: { from: 0, to: 120, points: 13 } });
    assert.equal(mob.x.length, 13);
    assert.ok(Math.abs(mob.summary.speed_mps.max - full.navigation.max_velocity) / full.navigation.max_velocity < 0.01, JSON.stringify(mob.summary));
    const dmg = await call(c, "compute_graph", { eft: RIFTER_EFT, graph: "damage", y: ["dps"], x: { values: [0, 5000, 20000, 60000] }, target: { profile: { signature_radius: 40, max_velocity: 400 } } });
    const d = dmg.series.dps;
    assert.equal(d.length, 4);
    assert.ok(d[0] > 0 && d[3] < d[1], `falloff: ${d}`);
    const ideal = await call(c, "compute_graph", { eft: RIFTER_EFT, graph: "damage", y: ["dps"], x: { values: [5000] } });
    assert.ok(ideal.series.dps[0] >= d[1], "small fast target takes less than the ideal target");
  });

  test("mcp.features.compute-graph-target: compute_graph: target fit, default x range, errors", async (t) => {
    if (!graphs) return t.skip("engine has no graph RPC");
    const r = await call(c, "compute_graph", { eft: RIFTER_EFT, graph: "damage", x_axis: "distance_m", y: ["dps"], target: { eft: "[Punisher, t]\n200mm Steel Plates II", resist_mode: "armor" } });
    assert.equal(r.x.length, 21);
    assert.equal(r.x[20], 100000);
    assert.ok(r.series.dps[0] > 0);
    const cap = await call(c, "compute_graph", { eft: RIFTER_EFT, graph: "capacitor", x_axis: "time_s" });
    assert.ok(Object.keys(cap.series).length >= 1);
    assert.match(await callErr(c, "compute_graph", { eft: RIFTER_EFT, graph: "nope" }), /UNKNOWN_GRAPH/);
    assert.match(await callErr(c, "compute_graph", { eft: RIFTER_EFT, graph: "damage", x_axis: "cap_pct" }), /BAD_AXIS/);
  });

  // passthrough features: the MCP must hand these to the engine unchanged, and they must move the numbers
  const base = { ship: "Rifter", modules: ["200mm AutoCannon II, Republic Fleet EMP S", "5MN Microwarpdrive II"], skills: 5 };
  const stats = async (fit: Record<string, unknown>, sections = ["navigation", "offense", "defense"]) =>
    call(c, "compute_fit", { fit: { ...base, ...fit }, detail: "full", sections, include_request: true });

  test("mcp.features.projected-environment: projected (stasis webifier) and environment (beacon)", async () => {
    const b = await stats({});
    const web = await stats({ projected: [{ kind: "module", module: { type_id: 527, state: "active" }, amount: 1 }] });
    assert.equal(web.request.projected[0].module.type_id, 527);
    // Stasis Webifier II, one module (no stacking penalty): -60% max velocity
    assert.ok(Math.abs(web.navigation.max_velocity / b.navigation.max_velocity - 0.4) < 1e-6, `${web.navigation.max_velocity} vs ${b.navigation.max_velocity}`);
    const wr = ds!.byExactName("Class 1 Wolf Rayet Effects");
    assert.ok(wr, "the dataset has the Class 1 Wolf-Rayet effect beacon");
    const env = await stats({ environment: { effect_type_ids: ["Class 1 Wolf Rayet Effects"] } });
    assert.deepEqual(env.request.environment.effect_type_ids, [wr!.id]);
    // beacon attributes: armorHPMultiplier 1.3, signatureRadiusMultiplier 0.85, smallWeaponDamageMultiplier 1.6
    assert.equal(ds!.attr(wr!, "armorHPMultiplier"), 1.3);
    assert.ok(Math.abs(env.defense.hp.armor / b.defense.hp.armor - 1.3) < 1e-9, `armor ${env.defense.hp.armor} vs ${b.defense.hp.armor}`);
    assert.ok(Math.abs(env.navigation.signature_radius / b.navigation.signature_radius - 0.85) < 1e-9, `sig ${env.navigation.signature_radius}`);
    assert.equal(env.defense.hp.hull, b.defense.hp.hull);
    assert.ok(env.offense.total.weapon_dps > b.offense.total.weapon_dps * 1.5, "small weapon damage bonus");
  });

  test("mcp.features.fleet-overrides: fleet buffs and overrides", async () => {
    const b = await stats({});
    const fleet = await stats({ fleet: { buffs: [{ buff_id: 10, value: 25 }] } });
    assert.deepEqual(fleet.request.fleet.buffs, [{ buff_id: 10, value: 25 }]);
    assert.notDeepEqual(fleet.defense, b.defense, "shield resist buff");
    const ov = await stats({ overrides: [{ type_id: 587, attribute_id: 37, value: 1000 }] });
    assert.ok(Math.abs(ov.navigation.max_velocity - b.navigation.max_velocity) > 100, `${ov.navigation.max_velocity} vs ${b.navigation.max_velocity}`);
  });

  test("mcp.features.mutated-fighters: mutated module and fighters", async () => {
    const plain = await call(c, "compute_fit", { fit: { ship: "Rifter", modules: ["Damage Control II"] }, detail: "full", sections: ["defense"], include_request: true });
    const mut = await call(c, "compute_fit", {
      fit: { ship: "Rifter", modules: [{ name: "Damage Control II", mutation: { base_type_id: 2048, attributes: { "974": 0.5 } } }] },
      detail: "full",
      sections: ["defense"],
      include_request: true,
    });
    assert.equal(mut.request.modules[0].mutation.base_type_id, 2048);
    // attribute 974 = hullEmDamageResonance: rolled 0.5 instead of DC II's 0.6; Rifter hull 0.67 -> em 0.335, the rest stays 0.402
    assert.deepEqual(plain.defense.resonance.hull, { em: 0.402, explosive: 0.402, kinetic: 0.402, thermal: 0.402 });
    assert.ok(Math.abs(mut.defense.resonance.hull.em - 0.335) < 1e-9, JSON.stringify(mut.defense.resonance.hull));
    assert.equal(mut.defense.resonance.hull.thermal, 0.402);
    assert.equal(mut.defense.hp.hull, plain.defense.hp.hull);
    const ftr = ds!.byExactName("Templar II");
    assert.ok(ftr && ftr.kind === "fighter", "the dataset has Templar II fighters");
    // bench core case fighters_templar_mwd_thanatos (Pyfa): 2 squadrons x 9, FSU II, abilities attack+MWD / attack+missiles
    const r = await call(c, "compute_fit", {
      fit: {
        ship: "Thanatos",
        modules: ["Fighter Support Unit II"],
        fighters: [
          { type_id: ftr!.id, quantity: 9, abilities: [6465, 6441] },
          { type_id: ftr!.id, quantity: 9, abilities: [6465, 6431] },
        ],
      },
      skills: 5,
      detail: "full",
      sections: ["offense"],
      include_request: true,
    });
    assert.equal(r.request.fighters[0].quantity, 9);
    assert.ok(Math.abs(r.offense.total.fighter_dps - 941.8776120820668) < 1e-3, JSON.stringify(r.offense.total));
  });

  test("mcp.features.options-passthrough: engine options (factor_reload, default_spool, rah) reach the engine and change the numbers", async () => {
    const eft = "[Rifter, reload]\n\n\n200mm AutoCannon II, Republic Fleet EMP S\nRocket Launcher II, Nova Rage Rocket";
    const noReload = await call(c, "compute_fit", { eft, skills: 5, include_request: true });
    const reload = await call(c, "compute_fit", { eft, skills: 5, options: { factor_reload: true }, include_request: true });
    assert.equal(reload.request.options.factor_reload, true);
    assert.ok(reload.metrics.dps < noReload.metrics.dps * 0.98, `factor_reload ${reload.metrics.dps} vs ${noReload.metrics.dps}`);
    const zar = { ship: "Zarmazd", modules: ["Heavy Mutadaptive Remote Armor Repairer II"] };
    const spoolMax = await call(c, "compute_fit", { fit: zar, skills: 5 });
    const spool0 = await call(c, "compute_fit", { fit: zar, skills: 5, options: { default_spool: { type: "spool_scale", amount: 0 } }, include_request: true });
    assert.deepEqual(spool0.request.options.default_spool, { type: "spool_scale", amount: 0 });
    assert.ok(spool0.metrics.remote_armor_rep < spoolMax.metrics.remote_armor_rep * 0.7, `${spool0.metrics.remote_armor_rep} vs ${spoolMax.metrics.remote_armor_rep}`);
    const hyp = { ship: "Hyperion", modules: ["Reactive Armor Hardener", "Large Armor Repairer II"] };
    const dmg = { em: 0, thermal: 0, kinetic: 50, explosive: 50 };
    const adapt = await call(c, "compute_fit", { fit: hyp, skills: 5, damage_profile: dmg, detail: "full", sections: ["defense"], options: { rah: "adapt" } });
    const off = await call(c, "compute_fit", { fit: hyp, skills: 5, damage_profile: dmg, detail: "full", sections: ["defense"], options: { rah: "disable" } });
    // unadapted RAH: 15% to every type; adapted to kinetic/explosive damage: those two get more, EM/thermal less
    assert.ok(adapt.defense.resonance.armor.kinetic < off.defense.resonance.armor.kinetic, JSON.stringify([adapt.defense.resonance.armor, off.defense.resonance.armor]));
    assert.ok(adapt.defense.resonance.armor.explosive < off.defense.resonance.armor.explosive);
    assert.ok(adapt.defense.resonance.armor.em > off.defense.resonance.armor.em);
  });

  test("mcp.features.security-status-passthrough: character.security_status reaches the engine request", async () => {
    const fit = { ship: "Pacifier", modules: ["Small Armor Repairer II"], character: { security_status: 5 } };
    const r = await call(c, "compute_fit", { fit, skills: 5, include_request: true, detail: "full", sections: ["defense"] });
    assert.equal(r.request.character.security_status, 5);
    assert.equal(r.request.character.skills.default_level, 5, "skills merge with the given character");
    const neg = await call(c, "compute_fit", { fit: { ...fit, character: { security_status: -10 } }, skills: 5, include_request: true, detail: "full", sections: ["defense"] });
    assert.equal(neg.request.character.security_status, -10);
    const none = await call(c, "compute_fit", { fit: { ship: "Pacifier" }, skills: 5, include_request: true, detail: "full", sections: ["defense"] });
    assert.equal(none.request.character.security_status, undefined, "no security status unless given");
  });

  // Pyfa effect 6871 concordSecStatusTankBonus (Pacifier/Enforcer/Marshal): +10% armor repair per point of security status (0..5).
  // Engine F (197223f) does not implement it yet; reported as TODO, not a pass.
  test("mcp.features.security-status-value: a security-status-dependent value changes (CONCORD armor repair bonus)", { todo: "engine F (eve-dogma 197223f) lacks Pyfa effect 6871 concordSecStatusTankBonus" }, async () => {
    const at = async (sec: number) =>
      (await call(c, "compute_fit", { fit: { ship: "Pacifier", modules: ["Small Armor Repairer II"], character: { security_status: sec } }, skills: 5, detail: "full", sections: ["defense"] })).defense.tank.raw.armor_repair;
    const r0 = await at(0);
    const r5 = await at(5);
    assert.ok(Math.abs(r5 / r0 - 1.5) < 1e-6, `sec 5 ${r5} vs sec 0 ${r0}`);
  });

  test("mcp.features.browse-market: browse_market / get_type market info through the server", { skip: !hasMarket && "dataset without market_groups" }, async () => {
    const r = await call(c, "browse_market", { type: "200mm AutoCannon II" });
    assert.ok(r.market_path.some((p: any) => p.name === "Projectile Turrets"));
    assert.ok(r.variations.length >= 3);
    const g = await call(c, "get_type", { type: "Rifter" });
    assert.ok(g.market.market_path.length >= 2);
  });
});

// ------------------------------------------------------------------------------------------- data update (SVC-004)

// ------------------------------------------------------------------------- batch contract fixes (bench mcp-v0.4.1 report)
// eve3's batch suite through the MCP (results-1.11/mcp-v0.4.1.md): error details, verbatim full output, per-fit errors in
// place, built-in profiles in compute_fit, and the engine's injected price file (load_prices / EVE_FIT_PRICES).
describe("batch contract and injected prices (engine)", { skip: !haveEngine && "engine or dataset missing" }, () => {
  let c: Client;
  let dir: string;
  let batchOk = false;
  before(async () => {
    c = await connect();
    dir = mkdtempSync(join(tmpdir(), "efm-prices-"));
    const r: any = await c.callTool({ name: "compute_batch", arguments: { request: { fits: [{ id: "a", fit: RIFTER_EFT }] } } });
    batchOk = !r.isError;
  });
  after(async () => {
    await c?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("mcp.features.batch-too-large-details: BATCH_TOO_LARGE carries the engine's count and limit (text and structured error)", async (t) => {
    if (!batchOk) return t.todo("engine without docs/23 batch (eve-dogma before 197223f)");
    const r: any = await c.callTool({ name: "compute_batch", arguments: { request: { base: RIFTER_EFT, sweep: { path: "/character/skills/default_level", from: 0, to: 2405, step: 1 } } } });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /^Error: BATCH_TOO_LARGE: .*"count":2406.*"limit":2000/);
    assert.equal(r.structuredContent.error.code, "BATCH_TOO_LARGE");
    assert.equal(r.structuredContent.error.count, 2406);
    assert.equal(r.structuredContent.error.limit, 2000);
    const low: any = await c.callTool({ name: "compute_batch", arguments: { request: { base: RIFTER_EFT, max_combinations: 3, sweep: { path: "/character/skills/default_level", values: [1, 2, 3, 4] } } } });
    assert.deepEqual([low.structuredContent.error.count, low.structuredContent.error.limit], [4, 3]);
  });

  test("mcp.features.compute-fit-full-verbatim: compute_fit detail=full is the engine output unchanged (= the batch result stats); MCP fields in _meta", async (t) => {
    if (!batchOk) return t.todo("engine without docs/23 batch (eve-dogma before 197223f)");
    const r: any = await c.callTool({ name: "compute_fit", arguments: { eft: RIFTER_EFT, detail: "full" } });
    const one = r.structuredContent;
    for (const k of ["request_hash", "notes", "engine"]) assert.ok(!(k in one), `no ${k} in the stats`);
    assert.match(r._meta["eve-fit-mcp"].request_hash, /^[0-9a-f]{8,}/);
    assert.ok(Array.isArray(r._meta["eve-fit-mcp"].notes));
    const b = await call(c, "compute_batch", { request: { fits: [{ id: "x", fit: RIFTER_EFT }] } });
    assert.deepEqual(b.results[0].stats, one, "batch result stats == compute_fit detail=full");
    const s = await call(c, "compute_fit", { eft: RIFTER_EFT });
    assert.ok(s.request_hash && Array.isArray(s.notes), "the summary keeps its MCP fields");
  });

  test("mcp.features.batch-error-in-place: a fit the MCP cannot normalise errors at its own index; the others are computed", async (t) => {
    if (!batchOk) return t.todo("engine without docs/23 batch (eve-dogma before 197223f)");
    const bad = { ship: { type_id: 587 }, modules: [{ type_id: 999999999, slot: "low" }] };
    const r: any = await c.callTool({ name: "compute_batch", arguments: { request: { fits: [{ id: "ok", fit: RIFTER_EFT }, { id: "bad", fit: bad }, { id: "ok2", fit: RIFTER_EFT }], fields: ["navigation.max_velocity"] } } });
    assert.ok(!r.isError, r.content?.[0]?.text);
    const b = r.structuredContent;
    assert.equal(b.results.length, 3);
    assert.equal(b.results[1].error.code, "UNKNOWN_TYPE");
    assert.equal(b.results[1].index, 1);
    assert.ok(b.results[0].stats && b.results[2].stats);
    assert.ok(b.notes.some((n: string) => /fits\/1\/fit: .*passed to the engine unchanged/.test(n)));
  });

  test("mcp.features.builtin-profiles: compute_fit accepts the engine's built-in damage / target profiles like compute_batch", async (t) => {
    if (!batchOk) return t.todo("engine without docs/23 batch (eve-dogma before 197223f)");
    const fit = { ship: { type_id: 587 }, modules: [{ type_id: 2889, slot: "high", charge_type_id: 21898 }], damage_pattern: { builtin: "Uniform" }, target_profile: { builtin: "Uniform (50%)" } };
    const one = await call(c, "compute_fit", { fit, detail: "full" });
    const b = await call(c, "compute_batch", { request: { fits: [{ id: "x", fit }] } });
    assert.deepEqual(b.results[0].stats, one);
    const tool = await call(c, "compute_fit", { fit: { ship: { type_id: 587 } }, target_profile: { builtin: "Uniform (50%)" }, detail: "full", include_request: true });
    assert.deepEqual(tool.request.target_profile, { builtin: "Uniform (50%)" });
    // a real schema error names the right field
    const e = await callErr(c, "compute_fit", { fit: { ship: { type_id: 587 }, damage_pattern: { em: [1] } } });
    assert.match(e, /damage_pattern/);
  });

  test("mcp.features.load-prices: load_prices injects a price file into the engine (file layer: request > file > embedded snapshot)", async (t) => {
    const f = await call(c, "compute_fit", { eft: RIFTER_EFT, price: true });
    if (f.provenance === undefined) return t.todo("engine without docs/23 provenance (eve-dogma before 8bde0ba)");
    const file = join(dir, "map.json");
    writeFileSync(file, JSON.stringify({ "587": 123456, "2048": 7 }));
    const l = await call(c, "load_prices", { source: file });
    assert.equal(l.loaded.origin, "path");
    assert.equal(l.loaded.engine.types, 2);
    const p = await call(c, "compute_fit", { eft: RIFTER_EFT, price: true });
    assert.equal(p.provenance.price_source, "file");
    const ship = p.price.sections.ship.items[0];
    assert.equal(ship.unit_isk, 123456);
    // request prices beat the file; overrides beat both
    const rq = await call(c, "compute_fit", { eft: RIFTER_EFT, prices: { isk: { "587": 5 } } });
    assert.equal(rq.price.sections.ship.items[0].unit_isk, 5);
    assert.equal(rq.provenance.price_source, "request");
    const ov = await call(c, "compute_fit", { eft: RIFTER_EFT, price_overrides: [{ type_id: 587, price: 1 }] });
    assert.equal(ov.price.sections.ship.items[0].unit_isk, 1);
    assert.equal(ov.provenance.price_source, "file", "overrides do not change price_source");
    // batch sees the same session state
    const b = await call(c, "compute_batch", { request: { fits: [{ id: "x", fit: RIFTER_EFT }], price: true, fields: ["price.total_isk"] } });
    assert.equal(b.provenance.price_source, "file");
    assert.deepEqual((await call(c, "load_prices", {})).loaded.path, file);
    // a broken file is the engine's error; the previous file stays loaded
    writeFileSync(join(dir, "bad.json"), "[1,2]");
    assert.match(await callErr(c, "load_prices", { source: join(dir, "bad.json") }), /^Error: BAD_PRICES: /);
    assert.equal((await call(c, "compute_fit", { eft: RIFTER_EFT, price: true })).price.sections.ship.items[0].unit_isk, 123456);
    assert.match(await callErr(c, "load_prices", { source: join(dir, "nope.json") }), /^Error: BAD_PRICES: price file not found/);
    await call(c, "load_prices", { clear: true });
    const back = await call(c, "compute_fit", { eft: RIFTER_EFT, price: true });
    assert.notEqual(back.provenance.price_source, "file");
    assert.equal((await call(c, "load_prices", {})).loaded, null);
  });

  test("mcp.features.prices-env-latest: EVE_FIT_PRICES=latest loads the newest eve-market-prices release (mock GitHub), cached for offline use", async (t) => {
    const probe = await call(c, "compute_fit", { eft: RIFTER_EFT, price: true });
    if (probe.provenance === undefined) return t.todo("engine without docs/23 provenance (eve-dogma before 8bde0ba)");
    const gz = gzipSync(Buffer.from(JSON.stringify({ "587": 424242 })));
    let hits = 0;
    const srv: Server = createServer((req, res) => {
      hits++;
      if (req.url === "/repos/EX-CT/eve-market-prices/releases/latest") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ tag_name: "prices-jita44-20261003T000000Z", assets: [{ name: "prices-jita44-20261003T000000Z.json.gz", size: gz.length, browser_download_url: `http://127.0.0.1:${(srv.address() as any).port}/dl/p.json.gz` }, { name: "SHA256SUMS", size: 1, browser_download_url: "x" }] }));
      } else if (req.url === "/dl/p.json.gz") res.end(gz);
      else res.writeHead(404).end();
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const cache = join(dir, "cache");
    const env = { EVE_FIT_PRICES: "latest", EVE_FIT_GITHUB_API: `http://127.0.0.1:${(srv.address() as any).port}`, EVE_FIT_PRICE_CACHE: cache };
    const c2 = await connect(env);
    try {
      const p = await call(c2, "compute_fit", { eft: RIFTER_EFT, price: true });
      assert.equal(p.provenance.price_source, "file");
      assert.equal(p.price.sections.ship.items[0].unit_isk, 424242);
      const st = await call(c2, "load_prices", {});
      assert.equal(st.loaded.release, "prices-jita44-20261003T000000Z");
      assert.ok(existsSync(join(cache, "snapshots", "prices-jita44-20261003T000000Z.json.gz")));
    } finally {
      await c2.close();
      srv.close();
    }
    assert.ok(hits >= 2);
    // offline: the cached snapshot is used without network
    const c3 = await connect({ ...env, EVE_FIT_OFFLINE: "1", EVE_FIT_GITHUB_API: "http://127.0.0.1:9" });
    try {
      const st = await call(c3, "load_prices", {});
      assert.equal(st.loaded.origin, "release-cache");
      assert.equal((await call(c3, "compute_fit", { eft: RIFTER_EFT, price: true })).price.sections.ship.items[0].unit_isk, 424242);
    } finally {
      await c3.close();
    }
  });
});

describe("data update: a second dataset", { skip: !haveEngine && "engine or dataset missing" }, () => {
  // A "new SDE": the same dataset with another build number and Rifter's CPU output +10 tf.
  let dir: string;
  let next: string;
  let build: number;
  const RIFTER = 587;
  const CPU_OUTPUT = "48";
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "eve-fit-sde-"));
    const d = JSON.parse(gunzipSync(readFileSync(DATASET)).toString("utf8"));
    build = (d.sde?.build ?? 0) + 1;
    d.sde = { ...(d.sde ?? {}), build };
    d.types[String(RIFTER)].attrs[CPU_OUTPUT] += 10;
    next = join(dir, `dataset-${build}.json.gz`);
    writeFileSync(next, gzipSync(Buffer.from(JSON.stringify(d))));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  const cpuOf = async (c: Client) => (await call(c, "get_ship", { ship: "Rifter" })).base_layout.resources.cpu;

  test("mcp.features.second-dataset: switching EVE_DOGMA_DATASET updates engine_info, the index and its numbers, and flags an engine still on the old data", async () => {
    const old = await connect();
    const neu = await connect({ EVE_DOGMA_DATASET: next });
    try {
      const a = await call(old, "engine_info", {});
      const b = await call(neu, "engine_info", {});
      assert.equal(b.dataset.sde_build, build);
      assert.equal(b.dataset.path, next);
      assert.notEqual(b.dataset.sha256, a.dataset.sha256);
      assert.equal(a.dataset_match, true);
      assert.equal(b.dataset.types, a.dataset.types);
      assert.equal((await cpuOf(neu)) - (await cpuOf(old)), 10, "hull data comes from the new dataset");
      const fa = await call(old, "compute_fit", { fit: { ship: "Rifter" }, skills: 0, detail: "full", sections: ["resources"] });
      const fb = await call(neu, "compute_fit", { fit: { ship: "Rifter" }, skills: 0, detail: "full", sections: ["resources"] });
      // the default engine F compiles its dataset in: it keeps computing on the old data until rebuilt, and engine_info says so
      assert.equal(b.dataset_match, false, "engine F still on the compiled-in dataset");
      assert.equal(fb.resources.cpu.total, fa.resources.cpu.total);
    } finally {
      await old.close();
      await neu.close();
    }
  });

  test("mcp.features.second-dataset-runtime-engine: an engine that loads the dataset at run time (variant C) computes on the new data", { skip: !existsSync(GO_BIN) && "variant C binary missing" }, async () => {
    const env = { EVE_DOGMA_BIN: GO_BIN, EVE_FIT_RPC_CMD: "{bin} --dataset {dataset} serve-stdio" };
    const old = await connect(env);
    const neu = await connect({ ...env, EVE_DOGMA_DATASET: next });
    try {
      const b = await call(neu, "engine_info", {});
      assert.equal(b.dataset_match, true);
      const fa = await call(old, "compute_fit", { fit: { ship: "Rifter" }, skills: 0, detail: "full", sections: ["resources"] });
      const fb = await call(neu, "compute_fit", { fit: { ship: "Rifter" }, skills: 0, detail: "full", sections: ["resources"] });
      assert.equal(fb.resources.cpu.total - fa.resources.cpu.total, 10);
    } finally {
      await old.close();
      await neu.close();
    }
  });
});
