# PROGRESS: eve-fit-mcp

Updated: 2026-10-03 06:25 (Asia/Shanghai)

## State: working v0.1.0 (all integration tests pass against eve-dogma-rs and variant C)
- Engine adapters: `rpc` (serve-stdio JSONL, pipelined, worker pool, restart on crash, timeouts),
  `cli` (calc/batch per call) and `http` (remote engine server), plus a request-keyed result cache. Command templates via env, so any contract variant plugs in.
- Dataset index in Node (search with jargon/zh/fuzzy, filters, fits_ship, layouts, skill trees, charges).
- 18 tools (incl. suggest_charges, suggest_drones, sweep), 10 resources (3 templates), 4 prompts; stdio + stateless Streamable HTTP.
- Input normalisation: EFT (engine), DNA (local), lenient JSON with names; default skills all V.
- Helpers: what_if, suggest_modules (batched, two-stage when over budget), optimize_fit (greedy),
  evaluate_profiles, skill_requirements.
- Tests: `npm test` (34 tests: unit (index, DNA, normalisation, metrics) + integration (all tools, resources, prompts, adapters, variant C, HTTP)).

## Next
- Curves engines don't expose yet (dps vs distance to target, cap vs time).
- Drone / implant / rig-specific suggestions.
- Traits/bonuses text (not in the dataset yet).
- npm package / release; `price_fit` (network, optional).

## Notes for engine owners
- Engines report `meta.dataset_sha256` of the decompressed JSON; the MCP checks both hashes.
- `eft_parse` returns `default_level: null` for skills; the MCP replaces it with its default (all V).

- `optimize_fit` emits `notifications/progress` (one per accepted step) when the client sends a progress token.
- `--http` has DNS-rebinding protection (Host allow-list: loopback, the bind host, `EVE_FIT_ALLOWED_HOSTS`).
- `suggest_drones`: single-type flights limited by bandwidth, bay and the Drones skill; drones the character can't use are listed last with their missing skills.
