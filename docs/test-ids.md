# Test ids

Every `node --test` title in `src/test/*.test.ts` starts with a stable id, `mcp.<file>.<slug>: <description>`.
`<file>` is one of `unit`, `integration`, `features`, `adapters`, `stats`, `validation`, and `<slug>` is short kebab-case. For tests that existed at base
`64d6cd6` the description is the title they had before ids were introduced, so references by description still match.
Cite tests by id (for example from eve-dogma-bench `inventory/tests.yaml`). Ids never change when a description is reworded.
`mcp.unit.test-ids` fails if a test has no id, names the wrong file, or reuses an id. Machine-readable list:
[`test-ids.json`](test-ids.json) (with the inventory item ids each test covers). Regenerate both with `python3 tools/test-ids.py`.

Bench replay suite **`mcp-bench`** (`tools/mcp-dogma-bench.py`, CI engine job): eve-dogma-bench core / ext / effects / cap cases
through `compute_fit detail:"full"`, case ids `mcp-bench.<suite>.<case>`, must match the engine run directly.

| id | description | inventory items |
|---|---|---|
| `mcp.adapters.command-split` | command templates split like a shell |  |
| `mcp.adapters.cli-adapter` | cli adapter (spawn per call) gives identical numbers |  |
| `mcp.adapters.worker-pool` | worker pool (EVE_FIT_WORKERS=3) |  |
| `mcp.adapters.rpc-cmd-variant-c` | variant C (Go) serve-stdio through EVE_FIT_RPC_CMD |  |
| `mcp.adapters.http-adapter-variant-c` | http adapter against variant C serve-http |  |
| `mcp.adapters.bad-engine-binary` | bad engine binary gives an actionable error, not a hang |  |
| `mcp.adapters.streamable-http` | Streamable HTTP transport |  |
| `mcp.features.market-roots` | roots and path resolution |  |
| `mcp.features.market-meta-filter` | meta filter, depth, ambiguity |  |
| `mcp.features.market-variations` | variations (meta family) |  |
| `mcp.features.prices-esi` | esi: average price, adjusted fallback, one request then cached (memory and disk) |  |
| `mcp.features.prices-fuzzwork` | fuzzwork: trade hub sell percentile; unknown hub/source errors |  |
| `mcp.features.prices-offline` | offline / network failure: stale cache, never-priced items null |  |
| `mcp.features.prices-fit-items` | fitItems: sections and quantities |  |
| `mcp.features.price-fit` | price_fit: Pyfa price panel sections, charges per full load, toggles |  |
| `mcp.features.price-fit-engine` | price_fit hands market prices (+ own isk) and overrides to the engine; legacy sum only for old engines | ENG-PRICE-001, PRC-002, PRC-003 |
| `mcp.features.list-graphs` | list_graphs: the 10 Pyfa graphs, CONTRACT-GRAPHS 0.2 |  |
| `mcp.features.contract-error-codes` | engine error codes pass through verbatim; MCP input errors are BAD_REQUEST |  |
| `mcp.features.price-passthrough` | compute_fit sends docs/23 price inputs to the engine and returns its price block verbatim | ENG-PRICE-001, PRC-003 |
| `mcp.features.provenance` | compute_fit and compute_batch return the engine's provenance (sde_build, sde_hash, price_source, snapshot_time) | ENG-PRICE-001 |
| `mcp.features.compute-batch` | compute_batch passes the BatchRequest to the engine; results equal compute_fit one by one | ENG-BATCH-001 |
| `mcp.features.compute-graph-stats` | compute_graph: lock time and mobility agree with the fit stats; damage vs a target profile |  |
| `mcp.features.compute-graph-target` | compute_graph: target fit, default x range, errors |  |
| `mcp.features.projected-environment` | projected (stasis webifier) and environment (beacon) | ENG-PROJ-001, ENG-ENV-001 |
| `mcp.features.fleet-overrides` | fleet buffs and overrides |  |
| `mcp.features.mutated-fighters` | mutated module and fighters | ENG-FTR-001, ENG-FTR-003, ENG-MOD-008, ENG-DEF-001 |
| `mcp.features.options-passthrough` | engine options (factor_reload, default_spool, rah) reach the engine and change the numbers | UI-PREF-ENG, ENG-MOD-004, ENG-MOD-005, ENG-DEF-004 |
| `mcp.features.security-status-passthrough` | character.security_status reaches the engine request | CHR-007 (partial) |
| `mcp.features.security-status-value` | a security-status-dependent value changes (CONCORD armor repair bonus) | CHR-007 (todo: engine lacks effect 6871) |
| `mcp.features.browse-market` | browse_market / get_type market info through the server |  |
| `mcp.features.batch-too-large-details` | BATCH_TOO_LARGE carries the engine's count and limit (text and structured error) | ENG-BATCH-001 |
| `mcp.features.compute-fit-full-verbatim` | compute_fit detail=full is the engine output unchanged (= the batch result stats); MCP fields in _meta | ENG-BATCH-001 |
| `mcp.features.batch-error-in-place` | a fit the MCP cannot normalise errors at its own index; the others are computed | ENG-BATCH-001 |
| `mcp.features.builtin-profiles` | compute_fit accepts the engine's built-in damage / target profiles like compute_batch | ENG-BATCH-001 |
| `mcp.features.load-prices` | load_prices injects a price file into the engine (file layer: request > file > embedded snapshot) | ENG-PRICE-001 |
| `mcp.features.prices-env-latest` | EVE_FIT_PRICES=latest loads the newest eve-market-prices release (mock GitHub), cached for offline use | ENG-PRICE-001 |
| `mcp.features.second-dataset` | switching EVE_DOGMA_DATASET updates engine_info, the index and its numbers, and flags an engine still on the old data | SVC-004 |
| `mcp.features.second-dataset-runtime-engine` | an engine that loads the dataset at run time (variant C) computes on the new data | SVC-004 |
| `mcp.integration.list-tools` | lists every tool with a JSON schema |  |
| `mcp.integration.engine-info` | engine_info reports the same dataset |  |
| `mcp.integration.search` | search: exact, jargon, chinese, filters, fuzzy |  |
| `mcp.integration.get-type-ship` | get_type and get_ship |  |
| `mcp.integration.get-ship-traits` | get_ship lists the hull traits (role + per-skill bonus lines, en/zh) and the bonus shows in the numbers (Cerberus, T2) | ENG-SHIP-006 |
| `mcp.integration.eft-import-states` | EFT import states (regression: F eft_parse fix, eve-dogma 1dc951b): weapons active, MJD/cloak online, /OFFLINE offline |  |
| `mcp.integration.compute-fit-summary` | compute_fit from EFT: summary with metrics |  |
| `mcp.integration.input-formats-agree` | EFT, DNA and lenient JSON give the same numbers |  |
| `mcp.integration.skills` | skills change the numbers; all_0 is weaker |  |
| `mcp.integration.full-detail-sections` | full detail with sections | UI-STAT-CAP |
| `mcp.integration.validate-fit` | validate_fit names modules and hints |  |
| `mcp.integration.actionable-errors` | actionable errors |  |
| `mcp.integration.export-roundtrip` | export EFT round-trips |  |
| `mcp.integration.compare-fits` | compare_fits builds a delta table |  |
| `mcp.integration.what-if` | what_if scenarios |  |
| `mcp.integration.suggest-modules` | suggest_modules ranks by goal and respects constraints |  |
| `mcp.integration.optimize-fit` | optimize_fit improves a goal within budget |  |
| `mcp.integration.suggest-drones` | suggest_drones respects bandwidth, bay and skills |  |
| `mcp.integration.optimize-progress` | optimize_fit sends progress notifications when asked |  |
| `mcp.integration.skill-requirements-presets` | skill_requirements and presets |  |
| `mcp.integration.profiles-implant-sets` | damage / target profiles and implant sets apply |  |
| `mcp.integration.suggest-charges` | suggest_charges ranks ammo per weapon type |  |
| `mcp.integration.sweep` | sweep gives graph series |  |
| `mcp.integration.resources-prompts` | resources and prompts |  |
| `mcp.stats.defense-values` | HP, resists per layer and EHP of a known fit (bench exct_rifter) | ENG-DEF-001, UI-STAT-RST |
| `mcp.stats.capacitor-values` | capacitor capacity, recharge, peak, simulated stable % (bench exct_rifter) | ENG-CAP-001, ENG-CAP-002, UI-STAT-CAP |
| `mcp.stats.navigation-values` | speed, align, agility, mass, signature, warp (bench exct_rifter) | ENG-NAV-001, ENG-NAV-002 (partial) |
| `mcp.stats.targeting-values` | lock range, scan resolution, targets, sensor strength, lock times, probe size (bench exct_rifter, probe_rifter) | ENG-TGT-001, ENG-TGT-004, UI-STAT-TGT |
| `mcp.stats.illegal-fit-computed` | a fit with violations is still computed in full (Pyfa 'disable fitting restrictions'; bench exct_rifter) | ENG-VAL-005, ENG-VAL-001 |
| `mcp.stats.mining` | mining yield of modules and drones (bench ext mining_venture) | ENG-OFF-006, UI-STAT-MIN, ENG-DRN-002 |
| `mcp.stats.remote-repair` | outgoing remote shield repair and cap transfer (bench ext rr_basilisk) | ENG-PROJ-006, UI-STAT-OUT |
| `mcp.stats.remote-repair-spool` | mutadaptive remote armor repairer spool range (bench ext rr_zarmazd_spool) | ENG-PROJ-006, UI-STAT-OUT, ENG-MOD-005 |
| `mcp.stats.bombing` | bombs needed to kill per bomb type and Covert Ops level (bench ext bomb_rifter) | ENG-OFF-007, UI-STAT-BMB |
| `mcp.stats.overheat` | overheated modules get the heat bonus and a burnout estimate | ENG-MOD-006, ENG-MOD-007 |
| `mcp.stats.drone-fighter-hp` | per-drone and per-fighter HP / EHP / shield recharge (bench ext dehp_vexor_hobgoblin, fehp_thanatos_firbolg) | ENG-DRN-003, ENG-FTR-004 |
| `mcp.stats.utility-modules` | utility modules without stats (scanners, cloak, probe launcher) fit, cost resources, change nothing else | ENG-MISC-002 |
| `mcp.unit.slots-hardpoints` | slots, hardpoints, kinds |  |
| `mcp.unit.can-fit` | canFit: rig size and ship restrictions |  |
| `mcp.unit.resolve-suggestions` | resolve gives suggestions |  |
| `mcp.unit.skill-tree` | skill tree includes prerequisites |  |
| `mcp.unit.implant-sets` | implant sets |  |
| `mcp.unit.dna-roundtrip` | DNA round trip with charges loaded |  |
| `mcp.unit.lenient-normalise` | lenient fit normalisation and hash |  |
| `mcp.unit.empty-nested-arrays` | empty fleet.booster_fits / projected / buffs are accepted at every depth | ENG-PROJ-003, ENG-FLT-002 |
| `mcp.unit.price-inputs` | docs/23 price_overrides / prices / price go onto the FitRequest; names resolved, no pricing math | ENG-PRICE-001 |
| `mcp.unit.batch-prepare` | compute_batch normalises fit sources and names only; the rest of the BatchRequest is verbatim | ENG-BATCH-001 |
| `mcp.unit.batch-table` | markdown view of a BatchResponse (values, deltas, per-fit errors) | ENG-BATCH-001 |
| `mcp.unit.projected-fighter-default-quantity` | no quantity is left to the engine (full squadron); explicit counts kept | ENG-PROJ-002 |
| `mcp.unit.metrics-goal-score` | metrics and goal score |  |
| `mcp.unit.default-engine` | default engine is F (eve-fit from EX-CT/eve-dogma); EVE_DOGMA_BIN selects another |  |
| `mcp.unit.test-ids` | (new) every test title starts with a unique stable id mcp.<file>.<slug> |  |
| `mcp.unit.prices-flag` | --prices FILE goes right after the binary (global flag), replaces an earlier one, null removes it | ENG-PRICE-001 |
| `mcp.unit.engine-error-details` | engine error objects keep their extra fields (count, limit, reason) as details | ENG-BATCH-001 |
| `mcp.unit.price-file-resolve` | path / URL / latest (release asset, cache, offline) | ENG-PRICE-001 |
| `mcp.validation.charge-validity` | validate_fit flags charge group, size and capacity per module (bench ext val_charge_group, val_charge_size, val_charge_capacity) | ENG-VAL-006 |
| `mcp.validation.resource-overflow` | CPU / powergrid / calibration / drone bandwidth overflow is flagged (bench ext val_cpu_power_overload, val_slots_mid_low_rig, val_drone_bandwidth) | ENG-VAL-001 |
| `mcp.validation.ship-restriction` | modules the hull cannot fit (command burst on a frigate, capital module on a cruiser) (bench ext val_ship_restriction_burst, val_capital_module_subcap) | ENG-VAL-003 |
| `mcp.validation.slots-hardpoints-groups` | slots, hardpoints, max group fitted / active / online (bench ext val_slots_high, val_launcher_hardpoints, val_max_group_*) | ENG-VAL-002, ENG-VAL-003 |
| `mcp.validation.missing-skills` | missing skills name the skill and level (bench ext val_missing_skills_partial, val_missing_skills_all0) | ENG-VAL-004 |
| `mcp.validation.validate-false` | options.validate=false skips the checks; validate_fit always checks (bench ext unit_val_validate_false) | ENG-VAL-005, UI-PREF-ENG (partial) |
| `mcp.validation.allow-violations` | an illegal fit is computed in full with its violations, and allow_violations keeps rule-breaking candidates (bench ext val_disable_restrictions_stats) | ENG-VAL-005 |
