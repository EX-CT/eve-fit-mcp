// Zod schemas for tool inputs. The MCP SDK turns these into the JSON Schemas clients see in tools/list;
// `npm run schemas` writes them to schemas/*.json as well.
import { z } from "zod";
import { KINDS, SLOTS } from "./dataset.js";
import { METRIC_KEYS } from "./metrics.js";

const TypeRef = z.union([z.number().int(), z.string()]).describe("type id or (English/Chinese) name");
const State = z.enum(["offline", "online", "active", "overheated"]);

export const ModuleSpec = z.union([
  z.string().describe('EFT-style line, e.g. "200mm AutoCannon II, EMP S" or "Damage Control II /offline"'),
  z.number().int(),
  z
    .object({
      type_id: z.number().int().optional(),
      name: z.string().optional(),
      slot: z.enum(SLOTS as [string, ...string[]]).optional(),
      state: State.optional().describe("default: active for activatable modules, else online"),
      charge_type_id: z.number().int().nullable().optional(),
      charge: TypeRef.optional().describe("charge id or name"),
      mutation: z.record(z.string(), z.any()).nullable().optional(),
      spool: z.record(z.string(), z.any()).nullable().optional(),
    })
    .passthrough(),
]);

const QtySpec = z.union([
  z.string().describe('"Hobgoblin II x5"'),
  z.number().int(),
  z.object({ type_id: z.number().int().optional(), name: z.string().optional(), quantity: z.number().int().optional(), active: z.any().optional() }).passthrough(),
]);

/** Lenient FitRequest: the contract shape (eve-dogma docs/contract.md), but names are accepted wherever ids are. */
export const FitRequestLenient = z
  .object({
    schema_version: z.literal(1).optional(),
    ship: z.union([TypeRef, z.object({ type_id: z.number().int().optional(), name: z.string().optional(), mode_type_id: z.number().int().nullable().optional(), mode: TypeRef.optional() }).passthrough()]),
    character: z.object({ skills: z.object({ default_level: z.number().int().min(0).max(5).nullable().optional(), levels: z.record(z.string(), z.number().int().min(0).max(5)).optional() }).optional(), security_status: z.number().nullable().optional() }).passthrough().optional(),
    modules: z.array(ModuleSpec).optional(),
    drones: z.array(QtySpec).optional(),
    fighters: z.array(QtySpec).optional(),
    implants: z.array(TypeRef).optional(),
    boosters: z.array(z.union([TypeRef, z.object({ type_id: z.number().int().optional(), name: z.string().optional(), side_effects: z.array(z.number().int()).optional() }).passthrough()])).optional(),
    cargo: z.array(QtySpec).optional(),
    fleet: z.record(z.string(), z.any()).optional().describe("{buffs:[{buff_id,value}], booster_fits:[FitRequest]}"),
    projected: z.array(z.record(z.string(), z.any())).optional().describe('[{kind:"module"|"drone"|"fighter"|"fit", module|drone|fighter|fit, amount, distance_m}]'),
    environment: z.record(z.string(), z.any()).optional(),
    // the engine also takes built-in profiles ({"builtin": "Uniform"}, docs/23 / bench ext dpb / tpb): any JSON value
    // per key is passed through, the engine validates
    damage_pattern: z.record(z.string(), z.union([z.number(), z.string()]).nullable()).nullable().optional().describe("{em,thermal,kinetic,explosive} or {builtin: name}"),
    target_profile: z.record(z.string(), z.union([z.number(), z.string()]).nullable()).nullable().optional().describe("{signature_radius,max_velocity,em,…} or {builtin: name}"),
    overrides: z.array(z.record(z.string(), z.any())).optional(),
    options: z.record(z.string(), z.any()).optional(),
  })
  .passthrough();

export const fitInputShape = {
  fit: FitRequestLenient.optional().describe("FitRequest JSON (contract v1); names may replace ids"),
  eft: z.string().optional().describe("EFT text as exported by the game / Pyfa"),
  dna: z.string().optional().describe("ship DNA, e.g. 587:2889;3:… (also <url=fitting:…> links)"),
  skills: z
    .union([z.number().int().min(0).max(5), z.string(), z.object({ default_level: z.number().int().min(0).max(5).optional(), levels: z.record(z.string(), z.number().int().min(0).max(5)).optional() })])
    .optional()
    .describe("skill level for every skill (0-5), a preset (all_5 … all_0), or {default_level, levels:{skill name|id: level}}; default all_5"),
  damage_profile: z.union([z.string(), z.record(z.string(), z.union([z.number(), z.string()]))]).optional().describe("incoming damage for EHP: preset name (list_presets), {em,thermal,kinetic,explosive} or the engine's {builtin: name}"),
  target_profile: z.union([z.string(), z.record(z.string(), z.union([z.number(), z.string()]).nullable())]).optional().describe("target for applied DPS: preset name, {signature_radius,max_velocity,em,…} or the engine's {builtin: name}"),
  implant_set: z.string().optional().describe('add a pirate implant set, e.g. "High-grade Crystal"'),
};

export const FitInputObject = z.object(fitInputShape);

export const GoalSpec = z.union([
  z.enum(METRIC_KEYS),
  z.array(z.object({ metric: z.enum(METRIC_KEYS), weight: z.number().optional() })).min(1),
]);

export const Constraints = z
  .object({
    meta_min: z.number().optional(),
    meta_max: z.number().optional(),
    tech_level: z.number().int().optional(),
    group: z.string().optional().describe("only candidates whose group name contains this"),
    query: z.string().optional().describe("only candidates whose name matches (search syntax, jargon ok)"),
    exclude: z.array(TypeRef).optional(),
    allow_violations: z.boolean().optional().describe("keep candidates that add fitting violations (default false)"),
    min: z.record(z.string(), z.number()).optional().describe("hard floors, e.g. {cap_stability: 0, cpu_free: 0}"),
    max: z.record(z.string(), z.number()).optional().describe("hard ceilings, e.g. {signature: 150}"),
  })
  .optional();

export const Change = z
  .object({
    op: z.enum([
      "add_module",
      "remove_module",
      "replace_module",
      "set_state",
      "set_charge",
      "set_skill",
      "set_all_skills",
      "add_drone",
      "remove_drone",
      "set_drone_active",
      "add_implant",
      "remove_implant",
      "add_booster",
      "set_damage_profile",
      "set_target_profile",
      "set_option",
    ]),
    index: z.number().int().optional().describe("module/drone index (request order)"),
    module: ModuleSpec.optional(),
    drone: QtySpec.optional(),
    state: State.optional(),
    charge: z.union([TypeRef, z.null()]).optional(),
    skill: TypeRef.optional(),
    level: z.number().int().min(0).max(5).optional(),
    active: z.number().int().optional(),
    type: TypeRef.optional().describe("implant/booster"),
    profile: z.union([z.string(), z.record(z.string(), z.number().nullable())]).optional(),
    option: z.string().optional(),
    value: z.any().optional(),
  })
  .passthrough();

export { KINDS, SLOTS, z };

// ---- docs/23 price inputs (passed through to the engine; the engine resolves layers and builds the price block)
export const PriceOverride = z
  .object({
    type_id: z.union([z.number().int(), z.string()]).optional().describe("type id or name"),
    market_group_id: z.union([z.number().int(), z.string()]).optional().describe("market group id or path (includes child groups)"),
    group_id: z.number().int().optional(),
    category_id: z.number().int().optional(),
    price: z.number().optional().describe("fixed ISK per unit (0 = free, e.g. self-built / own stock)"),
    multiplier: z.number().optional().describe("factor on the price from the next lower layer"),
  })
  .passthrough();
export const PriceOverrides = z.array(PriceOverride).describe("docs/23 §5.1: exactly one target and one of price / multiplier per entry; most specific target wins");
export const PricesInput = z
  .object({
    isk: z.record(z.string(), z.number()).optional().describe("type id -> ISK per unit (injected prices, layer L3)"),
    use_snapshot: z.boolean().optional().describe("false: ignore the engine's market snapshot (default true)"),
  })
  .passthrough()
  .describe("docs/23 §5.3 injected prices");
export const priceInputShape = {
  price_overrides: PriceOverrides.optional(),
  prices: PricesInput.optional(),
  price: z.boolean().optional().describe("ask the engine for the price block (total, per section / item, source of each price, missing)"),
};
