# PROGRESS: eve-fit-mcp

Updated: 2026-10-03 06:25 (Asia/Shanghai)

## State: working v0.1.0 (all integration tests pass against eve-dogma-rs and variant C)
- Engine adapters: `rpc` (serve-stdio JSONL, pipelined, worker pool, restart on crash, timeouts) and
  `cli` (calc/batch per call). Command templates via env, so any contract variant plugs in.
- Dataset index in Node (search with jargon/zh/fuzzy, filters, fits_ship, layouts, skill trees, charges).
- 15 tools, 10 resources (3 templates), 4 prompts; stdio + stateless Streamable HTTP.
- Input normalisation: EFT (engine), DNA (local), lenient JSON with names; default skills all V.
- Helpers: what_if, suggest_modules (batched, two-stage when over budget), optimize_fit (greedy),
  evaluate_profiles, skill_requirements.
- Tests: `npm test` (25 tests: tools, resources, prompts, adapters, variant C, HTTP).

## Next
- `graph` tool (dps vs range, cap vs time) once engines expose curves or via range sweeps.
- Ammo optimiser (`suggest_charges`), drone suggestions, rig/implant suggestions.
- Traits/bonuses text (not in the dataset yet).
- npm package / release; `price_fit` (network, optional).

## Notes for engine owners
- Engines report `meta.dataset_sha256` of the decompressed JSON; the MCP checks both hashes.
- `eft_parse` returns `default_level: null` for skills; the MCP replaces it with its default (all V).
