// Market prices (Pyfa price panel / price column, PRC-001..003). Two public sources, both free and keyless:
//   esi       CCP's ESI GET /markets/prices/ — universe-wide average_price (adjusted_price as fallback), one request for
//             every type. Default: official source, no third party. EVE data under CCP's developer licence terms.
//   fuzzwork  market.fuzzwork.co.uk /aggregates/ — per trade hub (Jita, Amarr, Dodixie, Rens, Hek): sell / buy
//             5 % percentile from ESI order books (Pyfa's default source family). Third-party service, credit Fuzzwork.
// Prices are cached in memory and on disk (one JSON file per source+system), refreshed after the TTL (ESI: its Expires
// header). Offline (EVE_FIT_OFFLINE=1) or on a network error the cache is used whatever its age and the answer says so;
// items never priced come back as null. Nothing here affects engine numbers.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Price {
  /** the price used for totals (esi: average, fuzzwork: sell percentile) */
  price: number | null;
  sell?: number | null;
  buy?: number | null;
  average?: number | null;
  adjusted?: number | null;
}

export interface PriceConfig {
  source: string;
  system: string;
  cacheDir: string | null;
  ttlS: number;
  offline: boolean;
  esiUrl: string;
  fuzzworkUrl: string;
  userAgent: string;
  timeoutMs: number;
}

export const HUBS: Record<string, { system_id: number; name: string }> = {
  jita: { system_id: 30000142, name: "Jita" },
  amarr: { system_id: 30002187, name: "Amarr" },
  dodixie: { system_id: 30002659, name: "Dodixie" },
  rens: { system_id: 30002510, name: "Rens" },
  hek: { system_id: 30002053, name: "Hek" },
};

export interface SourceInfo {
  id: string;
  title: string;
  systems: string[];
  url: string;
  terms: string;
}

export const SOURCES: SourceInfo[] = [
  {
    id: "esi",
    title: "CCP ESI /markets/prices/ (universe-wide average price)",
    systems: ["universe"],
    url: "https://esi.evetech.net/latest/markets/prices/",
    terms: "Official EVE Swagger Interface, public endpoint (no login). EVE Online data © CCP hf., used under CCP's developer licence terms.",
  },
  {
    id: "fuzzwork",
    title: "Fuzzwork market aggregates (trade-hub sell/buy 5 % percentile)",
    systems: Object.keys(HUBS),
    url: "https://market.fuzzwork.co.uk/aggregates/",
    terms: "Free public API by Steve Ronuken (fuzzwork.co.uk), aggregated from ESI order books; please credit Fuzzwork. EVE data © CCP hf.",
  },
];

export function priceConfig(env: NodeJS.ProcessEnv = process.env): PriceConfig {
  const xdg = env.XDG_CACHE_HOME || join(homedir(), ".cache");
  const dir = env.EVE_FIT_PRICE_CACHE;
  const ttl = Number(env.EVE_FIT_PRICE_TTL_S);
  return {
    source: (env.EVE_FIT_PRICE_SOURCE || "esi").toLowerCase(),
    system: (env.EVE_FIT_PRICE_SYSTEM || "jita").toLowerCase(),
    cacheDir: dir === "off" || dir === "0" ? null : dir || join(xdg, "eve-fit-mcp"),
    ttlS: Number.isFinite(ttl) && ttl >= 0 ? ttl : 3600,
    offline: /^(1|true|yes)$/i.test(env.EVE_FIT_OFFLINE ?? ""),
    esiUrl: (env.EVE_FIT_ESI_URL || "https://esi.evetech.net/latest").replace(/\/$/, ""),
    fuzzworkUrl: (env.EVE_FIT_FUZZWORK_URL || "https://market.fuzzwork.co.uk").replace(/\/$/, ""),
    userAgent: env.EVE_FIT_USER_AGENT || "eve-fit-mcp (https://github.com/EX-CT/eve-fit-mcp)",
    timeoutMs: 10_000,
  };
}

interface CacheFile {
  source: string;
  system: string;
  /** epoch ms of the last successful fetch per type (esi: one fetch for all) */
  fetched: Record<string, number>;
  expires?: number;
  prices: Record<string, Price>;
}

export interface PriceLookup {
  source: string;
  system: string;
  prices: Map<number, Price>;
  /** epoch ms of the oldest quote used */
  as_of: number | null;
  stale: boolean;
  notes: string[];
}

export class PriceService {
  private mem = new Map<string, CacheFile>();
  constructor(
    readonly cfg: PriceConfig,
    private fetchFn: typeof fetch = fetch,
  ) {}

  private key(source: string, system: string) {
    return `${source}-${source === "esi" ? "universe" : system}`;
  }

  private load(source: string, system: string): CacheFile {
    const k = this.key(source, system);
    const hit = this.mem.get(k);
    if (hit) return hit;
    let c: CacheFile = { source, system, fetched: {}, prices: {} };
    if (this.cfg.cacheDir) {
      try {
        const d = JSON.parse(readFileSync(join(this.cfg.cacheDir, `prices-${k}.json`), "utf8"));
        if (d && d.prices && d.fetched) c = d;
      } catch {}
    }
    this.mem.set(k, c);
    return c;
  }

  private save(c: CacheFile) {
    if (!this.cfg.cacheDir) return;
    try {
      mkdirSync(this.cfg.cacheDir, { recursive: true });
      const f = join(this.cfg.cacheDir, `prices-${this.key(c.source, c.system)}.json`);
      writeFileSync(`${f}.tmp`, JSON.stringify(c));
      renameSync(`${f}.tmp`, f);
    } catch {}
  }

  private async get(url: string): Promise<Response> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.cfg.timeoutMs);
    try {
      const r = await this.fetchFn(url, { headers: { "user-agent": this.cfg.userAgent, accept: "application/json" }, signal: ctl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status} from ${url.split("?")[0]}`);
      return r;
    } finally {
      clearTimeout(t);
    }
  }

  private async fetchEsi(c: CacheFile) {
    const r = await this.get(`${this.cfg.esiUrl}/markets/prices/?datasource=tranquility`);
    const rows: any[] = (await r.json()) as any[];
    if (!Array.isArray(rows)) throw new Error("ESI /markets/prices/ returned no list");
    const now = Date.now();
    const exp = Date.parse(r.headers.get("expires") ?? "");
    c.prices = {};
    c.fetched = { all: now };
    c.expires = Number.isFinite(exp) && exp > now ? exp : now + this.cfg.ttlS * 1000;
    for (const x of rows) {
      const avg = typeof x.average_price === "number" ? x.average_price : null;
      const adj = typeof x.adjusted_price === "number" ? x.adjusted_price : null;
      c.prices[String(x.type_id)] = { price: avg ?? adj, average: avg, adjusted: adj };
    }
  }

  private async fetchFuzzwork(c: CacheFile, ids: number[]) {
    const hub = HUBS[c.system];
    const now = Date.now();
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const r = await this.get(`${this.cfg.fuzzworkUrl}/aggregates/?system=${hub.system_id}&types=${chunk.join(",")}`);
      const d: any = await r.json();
      for (const id of chunk) {
        const x = d?.[String(id)];
        const num = (v: any) => {
          const n = Number(v);
          return Number.isFinite(n) && n > 0 ? n : null;
        };
        const sell = num(x?.sell?.percentile);
        const buy = num(x?.buy?.percentile);
        c.prices[String(id)] = { price: sell ?? buy, sell, buy };
        c.fetched[String(id)] = now;
      }
    }
  }

  async lookup(ids: number[], opts: { source?: string; system?: string } = {}): Promise<PriceLookup> {
    const source = (opts.source ?? this.cfg.source).toLowerCase();
    let system = (opts.system ?? this.cfg.system).toLowerCase();
    if (!SOURCES.some((s) => s.id === source)) throw new Error(`unknown price source '${source}' (known: ${SOURCES.map((s) => s.id).join(", ")})`);
    if (source === "esi") system = "universe";
    else if (!HUBS[system]) throw new Error(`unknown trade hub '${system}' for ${source} (known: ${Object.keys(HUBS).join(", ")})`);
    const c = this.load(source, system);
    const uniq = [...new Set(ids.filter((x) => Number.isInteger(x) && x > 0))];
    const now = Date.now();
    const fresh = (id: number) =>
      source === "esi" ? (c.expires ?? (c.fetched.all ?? 0) + this.cfg.ttlS * 1000) > now : (c.fetched[String(id)] ?? 0) + this.cfg.ttlS * 1000 > now;
    const need = uniq.filter((id) => !fresh(id));
    const notes: string[] = [];
    let stale = false;
    if (need.length) {
      if (this.cfg.offline) {
        stale = true;
        notes.push("offline mode (EVE_FIT_OFFLINE): using cached prices only");
      } else {
        try {
          if (source === "esi") await this.fetchEsi(c);
          else await this.fetchFuzzwork(c, need);
          this.save(c);
        } catch (e: any) {
          stale = true;
          notes.push(`price fetch failed (${e?.name === "AbortError" ? `timeout after ${this.cfg.timeoutMs} ms` : e?.message ?? e}); using cached prices`);
        }
      }
    }
    const prices = new Map<number, Price>();
    let asOf: number | null = null;
    for (const id of uniq) {
      const p = c.prices[String(id)];
      prices.set(id, p ?? { price: null });
      const t = source === "esi" ? c.fetched.all : c.fetched[String(id)];
      if (p && t) asOf = asOf === null ? t : Math.min(asOf, t);
    }
    const missing = uniq.filter((id) => prices.get(id)!.price === null).length;
    if (missing) notes.push(`${missing} item(s) have no price from ${source}${stale ? " (not in cache)" : ""}`);
    return { source, system, prices, as_of: asOf, stale, notes };
  }
}

/** Items of a strict FitRequest with quantities, grouped like Pyfa's price panel. */
export interface PricedItem {
  section: "ship" | "fittings" | "charges" | "drones" | "fighters" | "cargo" | "implants" | "boosters";
  type_id: number;
  quantity: number;
}

export function fitItems(req: any, chargesPerModule: (moduleId: number, chargeId: number) => number): PricedItem[] {
  const out: PricedItem[] = [];
  const add = (section: PricedItem["section"], type_id: number | undefined | null, quantity: number) => {
    if (!type_id || quantity <= 0) return;
    const prev = out.find((x) => x.section === section && x.type_id === type_id);
    if (prev) prev.quantity += quantity;
    else out.push({ section, type_id, quantity });
  };
  add("ship", req.ship?.type_id, 1);
  for (const m of req.modules ?? []) {
    add("fittings", m.type_id, 1);
    if (m.charge_type_id) add("charges", m.charge_type_id, chargesPerModule(m.type_id, m.charge_type_id));
  }
  for (const d of req.drones ?? []) add("drones", d.type_id, d.quantity ?? 1);
  for (const f of req.fighters ?? []) add("fighters", f.type_id, f.quantity ?? 1);
  for (const c of req.cargo ?? []) add("cargo", c.type_id, c.quantity ?? 1);
  for (const i of req.implants ?? []) add("implants", typeof i === "number" ? i : i?.type_id, 1);
  for (const b of req.boosters ?? []) add("boosters", typeof b === "number" ? b : b?.type_id, 1);
  return out;
}
