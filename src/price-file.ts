// Injected price files (docs/22 eve-price-snapshot v1, docs/23 §5.3 `--prices FILE` / RPC `prices_load`): where the
// file comes from. A local path is used as is; an http(s) URL is downloaded into the cache; `latest` takes the newest
// EX-CT/eve-market-prices release (`prices-jita44-<time>`, asset prices-*.json.gz). The engine validates the file
// (schema, content_hash, invariants) and prices with it as the `file` layer: request overrides > request prices >
// this file > the engine's embedded snapshot. No pricing math here.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { codedError } from "./dataset.js";

export const DEFAULT_PRICES_REPO = "EX-CT/eve-market-prices";

export interface PriceFileOptions {
  /** cache directory (snapshots go to <dir>/snapshots); null = a temp directory */
  cacheDir: string | null;
  offline?: boolean;
  userAgent?: string;
  /** owner/repo of the snapshot releases (default EX-CT/eve-market-prices; env EVE_FIT_PRICES_REPO) */
  repo?: string;
  /** GitHub API base (tests) */
  apiBase?: string;
  fetch?: typeof fetch;
}

export interface ResolvedPriceFile {
  path: string;
  /** what was asked for: the path, the URL, or `latest` */
  spec: string;
  origin: "path" | "url" | "release" | "release-cache";
  /** for `latest`: the release tag used */
  release?: string;
  url?: string;
}

function snapDir(o: PriceFileOptions): string {
  const d = join(o.cacheDir ?? join(tmpdir(), "eve-fit-mcp"), "snapshots");
  mkdirSync(d, { recursive: true });
  return d;
}

async function download(o: PriceFileOptions, url: string, file: string, accept = "application/octet-stream"): Promise<void> {
  const f = o.fetch ?? fetch;
  const r = await f(url, { headers: { "user-agent": o.userAgent ?? "eve-fit-mcp", accept }, redirect: "follow" });
  if (!r.ok) throw codedError("PRICES_FETCH_FAILED", `GET ${url}: HTTP ${r.status}`);
  writeFileSync(file, Buffer.from(await r.arrayBuffer()));
}

function newestCached(dir: string): string | null {
  const fs = readdirSync(dir).filter((n) => /^prices-.*\.json(\.gz)?$/.test(n));
  if (!fs.length) return null;
  // snapshot file names end in the market time (prices-jita44-YYYYMMDDTHHMMSSZ), so the name order is time order
  fs.sort();
  return join(dir, fs[fs.length - 1]);
}

/** Resolve `spec` (path | http(s) URL | "latest") to a local file the engine can read. */
export async function resolvePriceFile(spec: string, o: PriceFileOptions): Promise<ResolvedPriceFile> {
  const s = spec.trim();
  if (s === "latest") {
    const dir = snapDir(o);
    const repo = o.repo || DEFAULT_PRICES_REPO;
    if (!o.offline) {
      try {
        const f = o.fetch ?? fetch;
        const api = `${(o.apiBase ?? "https://api.github.com").replace(/\/+$/, "")}/repos/${repo}/releases/latest`;
        const r = await f(api, { headers: { "user-agent": o.userAgent ?? "eve-fit-mcp", accept: "application/vnd.github+json" } });
        if (!r.ok) throw codedError("PRICES_FETCH_FAILED", `GET ${api}: HTTP ${r.status}`);
        const rel: any = await r.json();
        const assets: any[] = rel?.assets ?? [];
        const a = assets.find((x) => /^prices-.*\.json\.gz$/.test(x?.name)) ?? assets.find((x) => /^prices-.*\.json$/.test(x?.name));
        if (!a) throw codedError("PRICES_FETCH_FAILED", `release ${rel?.tag_name ?? "?"} of ${repo} has no prices-*.json(.gz) asset`);
        const file = join(dir, basename(a.name));
        if (!existsSync(file) || statSync(file).size !== a.size) await download(o, a.browser_download_url, file);
        return { path: file, spec: s, origin: "release", release: rel.tag_name, url: a.browser_download_url };
      } catch (e: any) {
        const c = newestCached(dir);
        if (!c) throw codedError("PRICES_FETCH_FAILED", `latest ${repo} snapshot: ${e?.message ?? e} (and no cached snapshot)`);
        return { path: c, spec: s, origin: "release-cache", release: basename(c).replace(/\.json(\.gz)?$/, "") };
      }
    }
    const c = newestCached(dir);
    if (!c) throw codedError("PRICES_FETCH_FAILED", "offline and no cached snapshot for `latest`");
    return { path: c, spec: s, origin: "release-cache", release: basename(c).replace(/\.json(\.gz)?$/, "") };
  }
  if (/^https?:\/\//i.test(s)) {
    const dir = snapDir(o);
    const name = `${createHash("sha1").update(s).digest("hex").slice(0, 12)}-${basename(new URL(s).pathname) || "prices.json"}`;
    const file = join(dir, name);
    if (!o.offline || !existsSync(file)) await download(o, s, file);
    return { path: file, spec: s, origin: "url", url: s };
  }
  const p = resolve(s);
  if (!existsSync(p)) throw codedError("BAD_PRICES", `price file not found: ${s}`);
  return { path: p, spec: s, origin: "path" };
}
