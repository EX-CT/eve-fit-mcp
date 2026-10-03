// Market browser (Pyfa's market tree, MKT-001) and meta variations (meta swap), from the dataset's market_groups /
// meta_groups / variation_parent (eve-sde-pipeline r4+). The dataset holds fitting-relevant types only, so groups
// without such types (blueprints, SKINs, …) are hidden unless include_empty is set.
import type { Dataset, MarketGroupInfo, TypeInfo } from "./dataset.js";

export interface GroupRef {
  id: number;
  name: string;
  name_zh: string | null;
}

export interface MarketTypeRow {
  type_id: number;
  name: string;
  name_zh: string | null;
  meta_group: string | null;
  meta_level: number;
  tech_level: number | null;
  slot: string | null;
}

const counts = new WeakMap<Dataset, Map<number, number>>();

/** Published types in a group and all its descendants. */
export function typeCount(ds: Dataset, id: number): number {
  let m = counts.get(ds);
  if (!m) counts.set(ds, (m = new Map()));
  const hit = m.get(id);
  if (hit !== undefined) return hit;
  const g = ds.marketGroups.get(id);
  let n = g ? g.types.length : 0;
  m.set(id, n); // cycle guard
  for (const c of g?.children ?? []) n += typeCount(ds, c);
  m.set(id, n);
  return n;
}

const ref = (g: MarketGroupInfo): GroupRef => ({ id: g.id, name: g.name, name_zh: g.nameZh });

export function groupPath(ds: Dataset, id: number | null): GroupRef[] {
  const out: GroupRef[] = [];
  const seen = new Set<number>();
  for (let g = id === null ? undefined : ds.marketGroups.get(id); g && !seen.has(g.id); g = g.parent === null ? undefined : ds.marketGroups.get(g.parent)) {
    seen.add(g.id);
    out.unshift(ref(g));
  }
  return out;
}

const norm = (s: string) => s.trim().toLowerCase();

/** Group by id, exact name (en/zh) or a "/"-separated path of names from a root ("Ship Equipment/Turrets & Launchers"). */
export function resolveGroup(ds: Dataset, q: number | string): MarketGroupInfo {
  if (!ds.marketGroups.size) throw new Error("this dataset has no market_groups (needs an eve-sde-pipeline release r4 or later)");
  if (typeof q === "number" || /^\d+$/.test(String(q).trim())) {
    const g = ds.marketGroups.get(Number(q));
    if (!g) throw new Error(`unknown market group id ${q}`);
    return g;
  }
  const parts = String(q).split("/").map(norm).filter(Boolean);
  if (!parts.length) throw new Error("empty market group");
  const isName = (g: MarketGroupInfo, n: string) => norm(g.name) === n || (g.nameZh !== null && norm(g.nameZh) === n);
  let cands = [...ds.marketGroups.values()].filter((g) => isName(g, parts[parts.length - 1]));
  // a path must match the chain of parents (suffix match, so "Turrets & Launchers/Projectile Turrets" works too)
  if (parts.length > 1)
    cands = cands.filter((g) => {
      const names = groupPath(ds, g.id).map((p) => [norm(p.name), p.name_zh ? norm(p.name_zh) : ""]);
      if (names.length < parts.length) return false;
      const tail = names.slice(names.length - parts.length);
      return tail.every((n, i) => n.includes(parts[i]));
    });
  if (cands.length === 1) return cands[0];
  if (!cands.length) throw new Error(`no market group named '${q}'`);
  const withTypes = cands.filter((g) => typeCount(ds, g.id) > 0);
  if (withTypes.length === 1) return withTypes[0];
  const list = (withTypes.length ? withTypes : cands).slice(0, 12).map((g) => `${g.id} (${groupPath(ds, g.id).map((p) => p.name).join(" / ")})`);
  throw new Error(`market group '${q}' is ambiguous; use an id or a path: ${list.join("; ")}`);
}

export function typeRow(ds: Dataset, t: TypeInfo): MarketTypeRow {
  const mg = t.metaGroup !== null ? ds.metaGroups.get(t.metaGroup) : undefined;
  return { type_id: t.id, name: t.name, name_zh: t.nameZh, meta_group: mg?.name ?? null, meta_level: t.metaLevel, tech_level: t.techLevel, slot: t.slot };
}

export interface BrowseOptions {
  group?: number | string;
  /** levels of sub-groups to expand below the group (0 = direct children only, max 3) */
  depth?: number;
  include_empty?: boolean;
  /** keep only these meta groups (names or ids, Pyfa's meta buttons: Tech I, Tech II, Faction, Storyline, Deadspace, Officer, …) */
  meta_groups?: (string | number)[];
  limit?: number;
}

export interface BrowseNode extends GroupRef {
  types_total: number;
  children?: BrowseNode[];
}

export function browseMarket(ds: Dataset, o: BrowseOptions) {
  if (!ds.marketGroups.size) throw new Error("this dataset has no market_groups (needs an eve-sde-pipeline release r4 or later)");
  const g = o.group !== undefined ? resolveGroup(ds, o.group) : null;
  const depth = Math.min(Math.max(o.depth ?? 0, 0), 3);
  const keep = (id: number) => o.include_empty || typeCount(ds, id) > 0;
  const metaIds = o.meta_groups?.length
    ? new Set(
        o.meta_groups.map((m) => {
          if (typeof m === "number" || /^\d+$/.test(String(m))) return Number(m);
          const n = norm(String(m)).replace(/^t(\d)$/, "tech $1").replace(/^tech(\d)$/, "tech $1");
          const roman: Record<string, string> = { "tech 1": "tech i", "tech 2": "tech ii", "tech 3": "tech iii" };
          const want = roman[n] ?? n;
          for (const [id, mg] of ds.metaGroups) if (norm(mg.name) === want || (mg.nameZh && norm(mg.nameZh) === want)) return id;
          throw new Error(`unknown meta group '${m}' (known: ${[...ds.metaGroups.values()].map((x) => x.name).join(", ")})`);
        }),
      )
    : null;
  const byName = (a: MarketGroupInfo, b: MarketGroupInfo) => a.name.localeCompare(b.name);
  const node = (x: MarketGroupInfo, d: number): BrowseNode => ({
    ...ref(x),
    types_total: typeCount(ds, x.id),
    ...(d > 0 && x.children.length ? { children: kids(x.children, d - 1) } : {}),
  });
  const kids = (ids: number[], d: number) =>
    ids.filter(keep).map((id) => ds.marketGroups.get(id)!).sort(byName).map((x) => node(x, d));
  const roots = [...ds.marketGroups.values()].filter((x) => x.parent === null || !ds.marketGroups.has(x.parent)).map((x) => x.id);
  const limit = Math.min(Math.max(o.limit ?? 200, 1), 1000);
  const types = (g?.types ?? [])
    .map((id) => ds.type(id)!)
    .filter((t) => !metaIds || (t.metaGroup !== null ? metaIds.has(t.metaGroup) : metaIds.has(1)))
    .sort((a, b) => a.metaLevel - b.metaLevel || a.name.localeCompare(b.name))
    .map((t) => typeRow(ds, t));
  return {
    group: g ? { ...ref(g), path: groupPath(ds, g.id), types_total: typeCount(ds, g.id) } : null,
    children: kids(g ? g.children : roots, depth),
    types: types.slice(0, limit),
    ...(types.length > limit ? { types_truncated: types.length - limit } : {}),
  };
}

/** Meta family of a type (Pyfa "Variations" / meta swap): the base item and every item whose variation parent it is. */
export function variations(ds: Dataset, t: TypeInfo): MarketTypeRow[] {
  const base = t.variationParent ?? t.id;
  const fam = [...ds.types.values()].filter((x) => x.published && (x.id === base || x.variationParent === base));
  if (!fam.some((x) => x.id === t.id)) fam.push(t);
  return fam.sort((a, b) => a.metaLevel - b.metaLevel || (a.metaGroup ?? 1) - (b.metaGroup ?? 1) || a.name.localeCompare(b.name)).map((x) => typeRow(ds, x));
}

export function typeMarket(ds: Dataset, t: TypeInfo) {
  return { market_group: t.marketGroup, market_path: groupPath(ds, t.marketGroup), variations: variations(ds, t) };
}
