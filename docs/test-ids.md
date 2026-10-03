# Test ids

Every `node --test` title in `src/test/*.test.ts` starts with a stable id, `mcp.<file>.<slug>: <description>`.
`<file>` is `unit`, `integration`, `features` or `adapters`, and `<slug>` is short kebab-case. The description after the id
is the title the test had before the ids were introduced (base `64d6cd6`), unchanged, so references by description still match.
Cite tests by id (for example from eve-dogma-bench `inventory/tests.yaml`). Ids never change when a description is reworded.
`mcp.unit.test-ids` fails if a test has no id, names the wrong file, or reuses an id. Machine-readable list: [`test-ids.json`](test-ids.json).

| id | description (title before ids) |
|---|---|
| `mcp.adapters.command-split` | command templates split like a shell |
| `mcp.adapters.cli-adapter` | cli adapter (spawn per call) gives identical numbers |
| `mcp.adapters.worker-pool` | worker pool (EVE_FIT_WORKERS=3) |
| `mcp.adapters.rpc-cmd-variant-c` | variant C (Go) serve-stdio through EVE_FIT_RPC_CMD |
| `mcp.adapters.http-adapter-variant-c` | http adapter against variant C serve-http |
| `mcp.adapters.bad-engine-binary` | bad engine binary gives an actionable error, not a hang |
| `mcp.adapters.streamable-http` | Streamable HTTP transport |
| `mcp.features.market-roots` | roots and path resolution |
| `mcp.features.market-meta-filter` | meta filter, depth, ambiguity |
| `mcp.features.market-variations` | variations (meta family) |
| `mcp.features.prices-esi` | esi: average price, adjusted fallback, one request then cached (memory and disk) |
| `mcp.features.prices-fuzzwork` | fuzzwork: trade hub sell percentile; unknown hub/source errors |
| `mcp.features.prices-offline` | offline / network failure: stale cache, never-priced items null |
| `mcp.features.prices-fit-items` | fitItems: sections and quantities |
| `mcp.features.price-fit` | price_fit: Pyfa price panel sections, charges per full load, toggles |
| `mcp.features.list-graphs` | list_graphs: the 10 Pyfa graphs, CONTRACT-GRAPHS 0.2 |
| `mcp.features.compute-graph-stats` | compute_graph: lock time and mobility agree with the fit stats; damage vs a target profile |
| `mcp.features.compute-graph-target` | compute_graph: target fit, default x range, errors |
| `mcp.features.projected-environment` | projected (stasis webifier) and environment (beacon) |
| `mcp.features.fleet-overrides` | fleet buffs and overrides |
| `mcp.features.mutated-fighters` | mutated module and fighters |
| `mcp.features.browse-market` | browse_market / get_type market info through the server |
| `mcp.integration.list-tools` | lists every tool with a JSON schema |
| `mcp.integration.engine-info` | engine_info reports the same dataset |
| `mcp.integration.search` | search: exact, jargon, chinese, filters, fuzzy |
| `mcp.integration.get-type-ship` | get_type and get_ship |
| `mcp.integration.eft-import-states` | EFT import states (regression: F eft_parse fix, eve-dogma 1dc951b): weapons active, MJD/cloak online, /OFFLINE offline |
| `mcp.integration.compute-fit-summary` | compute_fit from EFT: summary with metrics |
| `mcp.integration.input-formats-agree` | EFT, DNA and lenient JSON give the same numbers |
| `mcp.integration.skills` | skills change the numbers; all_0 is weaker |
| `mcp.integration.full-detail-sections` | full detail with sections |
| `mcp.integration.validate-fit` | validate_fit names modules and hints |
| `mcp.integration.actionable-errors` | actionable errors |
| `mcp.integration.export-roundtrip` | export EFT round-trips |
| `mcp.integration.compare-fits` | compare_fits builds a delta table |
| `mcp.integration.what-if` | what_if scenarios |
| `mcp.integration.suggest-modules` | suggest_modules ranks by goal and respects constraints |
| `mcp.integration.optimize-fit` | optimize_fit improves a goal within budget |
| `mcp.integration.suggest-drones` | suggest_drones respects bandwidth, bay and skills |
| `mcp.integration.optimize-progress` | optimize_fit sends progress notifications when asked |
| `mcp.integration.skill-requirements-presets` | skill_requirements and presets |
| `mcp.integration.profiles-implant-sets` | damage / target profiles and implant sets apply |
| `mcp.integration.suggest-charges` | suggest_charges ranks ammo per weapon type |
| `mcp.integration.sweep` | sweep gives graph series |
| `mcp.integration.resources-prompts` | resources and prompts |
| `mcp.unit.slots-hardpoints` | slots, hardpoints, kinds |
| `mcp.unit.can-fit` | canFit: rig size and ship restrictions |
| `mcp.unit.resolve-suggestions` | resolve gives suggestions |
| `mcp.unit.skill-tree` | skill tree includes prerequisites |
| `mcp.unit.implant-sets` | implant sets |
| `mcp.unit.dna-roundtrip` | DNA round trip with charges loaded |
| `mcp.unit.lenient-normalise` | lenient fit normalisation and hash |
| `mcp.unit.metrics-goal-score` | metrics and goal score |
| `mcp.unit.default-engine` | default engine is F (eve-fit from EX-CT/eve-dogma); EVE_DOGMA_BIN selects another |
| `mcp.unit.test-ids` | (new) every test title starts with a unique stable id mcp.<file>.<slug> |
