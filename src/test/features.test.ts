// Milestone tools (docs/20 P1-7): graphs (engine graph RPC, CONTRACT-GRAPHS 0.2), market tree, prices; plus dedicated
// passthrough tests (mutations, overrides, projected, fleet, environment, fighters). Real server, real engine, real dataset;
// prices against a local mock of ESI / Fuzzwork (no internet in tests).
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Dataset } from "../dataset.js";
import { browseMarket, resolveGroup, variations } from "../market.js";
import { fitItems, PriceService, priceConfig } from "../prices.js";
import { call, callErr, connect, DATASET, haveEngine, RIFTER_EFT } from "./helpers.js";

const ds = existsSync(DATASET) ? new Dataset(DATASET) : null;
const hasMarket = !!ds && ds.marketGroups.size > 0;

// ------------------------------------------------------------------------------------------- market (index only)
describe("market tree (MKT-001, variations)", { skip: !hasMarket && "dataset without market_groups (needs eve-sde-pipeline r4+)" }, () => {
  test("roots and path resolution", () => {
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
  test("meta filter, depth, ambiguity", () => {
    const g = resolveGroup(ds!, "Projectile Turrets/Autocannons/Small");
    const t2 = browseMarket(ds!, { group: g.id, meta_groups: ["T2"] });
    assert.ok(t2.types.length > 0 && t2.types.every((t) => t.meta_group === "Tech II"), JSON.stringify(t2.types));
    const deep = browseMarket(ds!, { group: "Ship Equipment", depth: 2 });
    assert.ok(deep.children.some((c) => c.children?.some((cc) => cc.children?.length)));
    assert.throws(() => resolveGroup(ds!, "Small"), /ambiguous/);
    assert.throws(() => browseMarket(ds!, { group: g.id, meta_groups: ["Nope"] }), /unknown meta group/);
  });
  test("variations (meta family)", () => {
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

  test("esi: average price, adjusted fallback, one request then cached (memory and disk)", async () => {
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

  test("fuzzwork: trade hub sell percentile; unknown hub/source errors", async () => {
    const p = new PriceService(env());
    const r = await p.lookup([587, 2889], { source: "fuzzwork", system: "amarr" });
    assert.equal(r.prices.get(587)!.price, 600000);
    assert.equal(r.prices.get(587)!.buy, 550000);
    assert.equal(r.prices.get(2889)!.price, null, "zero percentile = no market");
    assert.ok(m.hits.some((h) => h.includes("system=30002187")), "Amarr system id");
    await assert.rejects(p.lookup([587], { source: "fuzzwork", system: "nowhere" }), /unknown trade hub/);
    await assert.rejects(p.lookup([587], { source: "evemarketer" }), /unknown price source/);
  });

  test("offline / network failure: stale cache, never-priced items null", async () => {
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

  test("fitItems: sections and quantities", () => {
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
    test("price_fit: Pyfa price panel sections, charges per full load, toggles", async () => {
      const r = await call(c, "price_fit", { eft: RIFTER_EFT });
      assert.equal(r.source, "esi");
      assert.equal(r.sections.ship, 500000);
      assert.equal(r.sections.fittings, 300000);
      const ch = r.items.find((x: any) => x.section === "charges" && x.type_id === 21898);
      const per = Math.floor(ds!.type(2889)!.capacity / ds!.type(21898)!.volume + 1e-9);
      assert.equal(ch.quantity, 3 * per);
      assert.equal(ch.value, 50 * 3 * per);
      assert.equal(r.sections.drones, 20000);
      assert.equal(r.total, 500000 + 300000 + 50 * 3 * per + 20000, "unpriced items (paste, plates, …) add 0");
      assert.ok(r.items.some((x: any) => x.section === "charges" && x.name === "Nanite Repair Paste" && x.unit_price === null));
      assert.ok(r.missing.includes("Damage Control II"));
      const nod = await call(c, "price_fit", { eft: RIFTER_EFT, include_drones: false });
      assert.equal(nod.total, r.total - 20000);
      assert.deepEqual(nod.excluded, ["drones", "fighters"]);
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

  test("list_graphs: the 10 Pyfa graphs, CONTRACT-GRAPHS 0.2", async (t) => {
    if (!graphs) return t.skip("engine has no graph RPC");
    const r = await call(c, "list_graphs", {});
    assert.match(r.contract, /0\.2/);
    const names = r.graphs.map((g: any) => g.graph).sort();
    assert.deepEqual(names, ["application_profile", "capacitor", "damage", "ecm_burst", "ewar", "lock_time", "mobility", "remote_reps", "shield_regen", "warp_time"]);
    const dmg = r.graphs.find((g: any) => g.graph === "damage");
    assert.equal(dmg.uses_target, true);
    assert.ok(dmg.axes.some((a: any) => a.axis === "distance_m" && a.unit === "m"));
  });

  test("compute_graph: lock time and mobility agree with the fit stats; damage vs a target profile", async (t) => {
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

  test("compute_graph: target fit, default x range, errors", async (t) => {
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

  test("projected (stasis webifier) and environment (beacon)", async () => {
    const b = await stats({});
    const web = await stats({ projected: [{ kind: "module", module: { type_id: 527, state: "active" }, amount: 1 }] });
    assert.equal(web.request.projected[0].module.type_id, 527);
    assert.ok(web.navigation.max_velocity < b.navigation.max_velocity * 0.6, `${web.navigation.max_velocity} vs ${b.navigation.max_velocity}`);
    const wr = [...ds!.types.values()].find((t) => /^Wolf-Rayet Effect Beacon Class 1$/.test(t.name));
    if (wr) {
      const env = await stats({ environment: { effect_type_ids: [wr.id] } });
      assert.deepEqual(env.request.environment.effect_type_ids, [wr.id]);
      assert.notDeepEqual(env.defense, b.defense, "WR beacon changes armor/resists");
    }
  });

  test("fleet buffs and overrides", async () => {
    const b = await stats({});
    const fleet = await stats({ fleet: { buffs: [{ buff_id: 10, value: 25 }] } });
    assert.deepEqual(fleet.request.fleet.buffs, [{ buff_id: 10, value: 25 }]);
    assert.notDeepEqual(fleet.defense, b.defense, "shield resist buff");
    const ov = await stats({ overrides: [{ type_id: 587, attribute_id: 37, value: 1000 }] });
    assert.ok(Math.abs(ov.navigation.max_velocity - b.navigation.max_velocity) > 100, `${ov.navigation.max_velocity} vs ${b.navigation.max_velocity}`);
  });

  test("mutated module and fighters", async () => {
    const plain = await call(c, "compute_fit", { fit: { ship: "Rifter", modules: ["Damage Control II"] }, detail: "full", sections: ["defense"], include_request: true });
    const mut = await call(c, "compute_fit", {
      fit: { ship: "Rifter", modules: [{ name: "Damage Control II", mutation: { base_type_id: 2048, attributes: { "974": 0.5 } } }] },
      detail: "full",
      sections: ["defense"],
      include_request: true,
    });
    assert.equal(mut.request.modules[0].mutation.base_type_id, 2048);
    assert.notDeepEqual(mut.defense, plain.defense, "mutated hull resist");
    const ftr = [...ds!.types.values()].find((t) => t.kind === "fighter" && t.published && /Templar II/.test(t.name));
    if (ftr) {
      const r = await call(c, "compute_fit", { fit: { ship: "Thanatos", fighters: [{ type_id: ftr.id, quantity: 9, active: true }] }, detail: "full", sections: ["offense"], include_request: true });
      assert.equal(r.request.fighters[0].quantity, 9);
      assert.ok(r.offense.total.fighter_dps > 0, JSON.stringify(r.offense.total));
    }
  });

  test("browse_market / get_type market info through the server", { skip: !hasMarket && "dataset without market_groups" }, async () => {
    const r = await call(c, "browse_market", { type: "200mm AutoCannon II" });
    assert.ok(r.market_path.some((p: any) => p.name === "Projectile Turrets"));
    assert.ok(r.variations.length >= 3);
    const g = await call(c, "get_type", { type: "Rifter" });
    assert.ok(g.market.market_path.length >= 2);
  });
});
