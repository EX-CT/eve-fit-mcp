// Engine-computed graphs (Pyfa's graph window, GRF-*) through the engine's graph RPC: `graph_specs` and `graph` per
// CONTRACT-GRAPHS rev 0.2 (eve-dogma-bench graphs-round2). The MCP only builds the GraphRequest (fit normalisation,
// target, x samples) and summarises the result; every number comes from the engine.
import { EngineError, type EngineAdapter } from "./adapters/types.js";

export interface GraphSpec {
  title?: string;
  pyfa?: string;
  axes?: Record<string, { unit?: string; valid?: string }>;
  series?: Record<string, { unit?: string; by_axis?: Record<string, string> }>;
  params?: Record<string, unknown>;
  defs?: Record<string, string>;
}
export interface GraphSpecs {
  contract?: string;
  graphs: Record<string, GraphSpec>;
}

/** Graphs that take a `target` (profile or fit), per CONTRACT-GRAPHS 0.2; the others ignore it. */
export const TARGET_GRAPHS = new Set(["damage", "application_profile", "ewar", "remote_reps"]);

/** Default sample ranges per x axis when the caller gives none (SI units, as in the contract). */
export const DEFAULT_RANGES: Record<string, [number, number]> = {
  distance_m: [0, 100_000],
  time_s: [0, 300],
  cap_pct: [0, 100],
  shield_pct: [0, 100],
  tgt_speed_mps: [0, 3000],
  tgt_speed_pct: [0, 200],
  tgt_sig_m: [25, 1000],
  tgt_sig_pct: [10, 300],
  tgt_dps: [10, 2000],
  tgt_scan_res_mm: [10, 2000],
};
const AU = 149_597_870_700;

const cache = new WeakMap<EngineAdapter, Promise<GraphSpecs>>();

export function graphSpecs(engine: EngineAdapter): Promise<GraphSpecs> {
  let p = cache.get(engine);
  if (!p) {
    p = engine
      .call<GraphSpecs>("graph_specs", {})
      .then((r) => {
        if (!r || typeof r !== "object" || !r.graphs) throw new EngineError("BAD_ENGINE_RESPONSE", "graph_specs returned no graphs");
        return r;
      })
      .catch((e: any) => {
        cache.delete(engine);
        if (e?.code === "UNKNOWN_METHOD" || /unknown method/i.test(String(e?.message)))
          throw new EngineError("NO_GRAPH_RPC", "this engine has no graph RPC (CONTRACT-GRAPHS 0.2); use engine F (eve-fit), the default");
        throw e;
      });
    cache.set(engine, p);
  }
  return p;
}

/** Compact catalogue for agents: axes with units, series with units and the axes they are defined for. */
export function describeGraphs(specs: GraphSpecs) {
  return Object.entries(specs.graphs).map(([name, g]) => ({
    graph: name,
    title: g.title ?? name,
    pyfa: g.pyfa ?? null,
    uses_target: TARGET_GRAPHS.has(name),
    axes: Object.entries(g.axes ?? {}).map(([a, v]) => ({ axis: a, unit: v.unit ?? null, valid: v.valid ?? null })),
    series: Object.entries(g.series ?? {}).map(([y, v]) => ({ y, unit: v.unit ?? null, axes: Object.keys(v.by_axis ?? {}) })),
    params: g.params ?? {},
  }));
}

export interface XSpec {
  values?: number[];
  from?: number;
  to?: number;
  points?: number;
}

export function sampleX(graph: string, axis: string, x: XSpec | undefined): number[] {
  // explicit values are used as given, even an empty list (the engine answers with empty series)
  if (Array.isArray(x?.values)) return x.values;
  let [lo, hi] = DEFAULT_RANGES[axis] ?? [0, 100];
  if (graph === "warp_time" && axis === "distance_m") [lo, hi] = [0, 50 * AU];
  const from = x?.from ?? lo;
  const to = x?.to ?? hi;
  const n = Math.min(Math.max(Math.trunc(x?.points ?? 21), 2), 500);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(Number((from + ((to - from) * i) / (n - 1)).toPrecision(12)));
  return out;
}

/** Pick the x axis (given, else the first axis every requested y is defined on) and the y list (given, else all). */
export function pickAxes(spec: GraphSpec, graph: string, axis?: string, y?: string[]): { axis: string; y: string[] } {
  const axes = Object.keys(spec.axes ?? {});
  const series = spec.series ?? {};
  if (axis && !axes.includes(axis)) throw new EngineError("BAD_AXIS", `graph ${graph} has no x axis '${axis}' (axes: ${axes.join(", ")})`, "x.axis");
  const ax = axis ?? axes.find((a) => (y?.length ? y : Object.keys(series)).every((s) => series[s]?.by_axis?.[a] !== undefined)) ?? axes[0];
  // an explicit y list goes to the engine as given (an empty one is the engine's BAD_REQUEST); omitted = every series
  const ys = y ?? Object.keys(series).filter((s) => series[s]?.by_axis?.[ax] !== undefined);
  return { axis: ax, y: ys };
}

export function summarizeSeries(x: number[], series: Record<string, (number | null)[]>) {
  const out: Record<string, { min: number | null; max: number | null; x_at_max: number | null; first: number | null; last: number | null; nulls: number }> = {};
  for (const [k, ys] of Object.entries(series)) {
    let min: number | null = null, max: number | null = null, xm: number | null = null, nulls = 0;
    ys.forEach((v, i) => {
      if (v === null || v === undefined) return void nulls++;
      if (min === null || v < min) min = v;
      if (max === null || v > max) (max = v), (xm = x[i]);
    });
    out[k] = { min, max, x_at_max: xm, first: ys[0] ?? null, last: ys[ys.length - 1] ?? null, nulls };
  }
  return out;
}
