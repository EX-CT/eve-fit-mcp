# PROGRESS — eve-fit-mcp

Updated: 2026-10-03 03:52 (Asia/Shanghai)

## State: WIP (paused — worker reassigned to dogma-lab variant B)
- package.json / tsconfig (TypeScript, @modelcontextprotocol/sdk 1.32, zod).
- `src/engine.ts`: persistent JSONL client for `eve-dogma serve-stdio`
  (methods: calc, eft_parse, eft_export, search, type, meta).

## Next (per eve-fit-docs/docs/06-mcp-design.md)
- In-process dataset index (load dataset gz in Node: category/slot filters, jargon aliases, zh names).
- Tools: search_types, get_type, list_ship_slots, parse_fit, export_fit, validate_fit, compute_fit,
  compare_fits, what_if, suggest_modules, optimize_fit, skill_requirements, damage/target profiles.
- Resources, prompts, stdio + streamable HTTP transports, tests against real engine, README.

## Notes for engine owners
- Engine `meta` lacks `request_hash`; MCP can compute sha256 of canonical request until engine adds it.
- `search` RPC has no category/slot filter; MCP will index the dataset itself.
