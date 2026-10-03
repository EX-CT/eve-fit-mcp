# eve-fit-mcp

An [MCP](https://modelcontextprotocol.io) server for EVE Online ship fitting. Through it, an AI assistant can
search items, build and validate fits, compute Pyfa-parity statistics, compare alternatives, run what-if
scenarios, and let a batch-evaluating optimiser suggest modules.

It is **engine-agnostic**. Numbers come from any engine that implements the stateless
[eve-dogma contract](https://github.com/EX-CT/eve-dogma-rs/blob/main/docs/contract.md):
`eve-dogma-rs` by default, or any `eve-dogma-lab` variant such as the Go variant C. The engine runs
behind a pluggable adapter:

| adapter | how | when |
|---|---|---|
| `rpc` (default) | one long-running `serve-stdio` JSONL process; the dataset is loaded once and requests are pipelined. `EVE_FIT_WORKERS=N` runs a pool and spreads batches over the N processes | desktop agents, servers |
| `cli` | spawns `calc` / `batch` per call; nothing stays resident | debugging, engines without `serve-stdio`, sandboxes |
| `http` | a remote engine server: `POST /v1/calc`, `POST /v1/batch` (JSONL), `POST /v1/rpc`, `GET /v1/meta` (e.g. `eve-dogma-go serve-http`) | shared engine for several MCP instances, engine on another host |

The server also builds its own index of the same `dataset-<build>.json.gz`. It answers search, show-info,
ship layouts, skill trees, compatible charges and optimiser candidates, so none of that depends on engine
extras.

Transports: **stdio**, and **Streamable HTTP** (`--http`; stateless, `POST /mcp`, `GET /healthz`).

## Tools

| tool | what it does |
|---|---|
| `search_types` | ships/modules/charges/drones/fighters/implants/boosters/subsystems/skills by name, English or Chinese, with jargon (`mwd`, `lse`, `dc`, `scram`, `point`, `web`, `sebo`, `bcs`, `dda` …) and fuzzy matching. Filters: kind, slot, group, meta, tech level, `fits_ship` |
| `get_type` | show-info: named attributes with units, effects, required skills (incl. prerequisites), compatible charges, other items in the same group, ship layout |
| `get_ship` | slots, hardpoints, rig size, CPU/PG/calibration, drone bay, plus the empty hull's computed stats with skills |
| `list_presets` | skill presets, pirate implant sets (from the dataset), incoming damage profiles, target profiles, metric keys |
| `parse_fit` | EFT / DNA / lenient JSON → strict contract FitRequest, every item named, `request_hash` |
| `export_fit` | EFT (Pyfa-exact, from the engine), DNA, multibuy, JSON |
| `validate_fit` | violations with module names and fix hints, resource usage, missing skills |
| `compute_fit` | full stats: compact summary + named metrics, or `detail: "full"` with `sections` |
| `compare_fits` | 2–20 fits in one batch → metric × fit table with deltas and the best fit per metric |
| `what_if` | add/remove/replace modules, state, ammo, skills, drones, implants, boosters, profiles, options → deltas per scenario |
| `suggest_modules` | ranks every compatible module for a slot (fill it, or replace module *i*) by a goal (`dps`, `ehp`, `tank`, `speed`, `align`, `cap_stability`, `lock_range` … or a weighted mix) by computing each candidate. Drops candidates that add violations; `min`/`max` limits on any metric |
| `suggest_charges` | for each weapon type in the fit, ranks every compatible charge by a goal (`dps`, `applied_dps`, `weapon_range` …) |
| `suggest_drones` | rank single-type drone flights within bandwidth, bay and the Drones skill; usable drones first, with missing skills |
| `sweep` | graph data: metrics vs target signature / target velocity / skill level / projected distance, in one batch |
| `optimize_fit` | greedy local search: fill free slots, then apply the best swap until nothing improves. Takes budget, constraints, `lock` and `slots`; returns the trace and an EFT. Reports MCP progress when the client sends a progress token |
| `skill_requirements` | every skill the fit needs, prerequisites included, and what the character lacks |
| `evaluate_profiles` | applied DPS vs frigate…structure targets and EHP vs EM/thermal/…/NPC damage profiles in one batch |
| `engine_info` | engine, adapter, dataset build/sha256, and whether engine and index use the same dataset |

Fit inputs are the same for every fit tool. Give exactly one of `eft`, `dna` or `fit` (contract
FitRequest; **names are accepted wherever ids are**, e.g. `"modules": ["200mm AutoCannon II, EMP S"]`).
Optional extras: `skills` (0–5, `all_4`, or `{default_level, levels: {"Gunnery": 4}}`; **default all V**),
`damage_profile`, `target_profile`, `implant_set`.

Resources:
* `eve://dataset/meta`
* `eve://schema/fit-request`, `eve://schema/fit-stats`
* `eve://presets`, `eve://jargon`, `eve://metrics`
* `eve://guide/fitting`
* `eve://type/{id}`, `eve://ship/{id}/layout`, `eve://ship/{id}/modules/{slot}`

Prompts: `fit_for_role`, `review_fit`, `explain_stat`, `compare_options`.

JSON Schemas of all tool inputs are in [`schemas/tools/`](schemas/tools) (`npm run schemas` regenerates them
from the live server). The contract schemas are in `schemas/fit-request.schema.json` / `fit-stats.schema.json`.

## Quick install (release package)

Every `v*` tag publishes a [GitHub Release](https://github.com/EX-CT/eve-fit-mcp/releases) with a prebuilt npm
tarball (`eve-fit-mcp.tgz`, plus `SHA256SUMS`). Nothing is published to the npm registry. Install the package
straight from the release.

1. **Engine:** any contract engine. The default is `eve-dogma` on `PATH`:
   `cargo install --git https://github.com/EX-CT/eve-dogma-rs` (or set `EVE_DOGMA_BIN`).
2. **Dataset:** download the latest `dataset-*.json.gz` from
   [EX-CT/eve-sde-pipeline releases](https://github.com/EX-CT/eve-sde-pipeline/releases/latest):
   `gh release download -R EX-CT/eve-sde-pipeline -p 'dataset-*.json.gz'`.
   The release's `manifest.json` names the file and its SHA-256.
3. **Add the server to your client.** Replace `/path/to/dataset.json.gz` with the file from step 2.

   * **Cursor (one click):** [![Add eve-fit MCP server to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=eve-fit&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIi0tcGFja2FnZT1odHRwczovL2dpdGh1Yi5jb20vRVgtQ1QvZXZlLWZpdC1tY3AvcmVsZWFzZXMvbGF0ZXN0L2Rvd25sb2FkL2V2ZS1maXQtbWNwLnRneiIsImV2ZS1maXQtbWNwIl0sImVudiI6eyJFVkVfRE9HTUFfREFUQVNFVCI6Ii9wYXRoL3RvL2RhdGFzZXQuanNvbi5neiJ9fQ%3D%3D)
     then edit `EVE_DOGMA_DATASET` in the install dialog.
   * **Claude Code:**
     `claude mcp add eve-fit -e EVE_DOGMA_DATASET=/path/to/dataset.json.gz -- npx -y --package=https://github.com/EX-CT/eve-fit-mcp/releases/latest/download/eve-fit-mcp.tgz eve-fit-mcp`
   * **VS Code:**
     `code --add-mcp '{"name":"eve-fit","command":"npx","args":["-y","--package=https://github.com/EX-CT/eve-fit-mcp/releases/latest/download/eve-fit-mcp.tgz","eve-fit-mcp"],"env":{"EVE_DOGMA_DATASET":"/path/to/dataset.json.gz"}}'`
   * **Claude Desktop / any `mcpServers` JSON:**

     ```json
     {
       "mcpServers": {
         "eve-fit": {
           "command": "npx",
           "args": ["-y", "--package=https://github.com/EX-CT/eve-fit-mcp/releases/latest/download/eve-fit-mcp.tgz", "eve-fit-mcp"],
           "env": { "EVE_DOGMA_DATASET": "/path/to/dataset.json.gz" }
         }
       }
     }
     ```

To pin a version, replace `latest/download/eve-fit-mcp.tgz` with `download/v0.1.0/eve-fit-mcp-0.1.0.tgz`. To install
globally, run `npm install -g https://github.com/EX-CT/eve-fit-mcp/releases/latest/download/eve-fit-mcp.tgz` and use `"command": "eve-fit-mcp"`. Check the install with
`npx -y --package=https://github.com/EX-CT/eve-fit-mcp/releases/latest/download/eve-fit-mcp.tgz eve-fit-mcp --help`.

## Install from source

```bash
git clone https://github.com/EX-CT/eve-fit-mcp && cd eve-fit-mcp
npm ci && npm run build
# an engine: eve-dogma-rs (cargo build --release) or any contract variant
# a dataset: dataset-<build>.json.gz from the EX-CT/eve-sde-pipeline releases
```

## Configuration (environment)

| variable | default | meaning |
|---|---|---|
| `EVE_DOGMA_DATASET` | (required) | dataset used by the engine **and** the search index (also needed with `http`: the index is local) |
| `EVE_DOGMA_BIN` | `eve-dogma` | engine binary |
| `EVE_FIT_ADAPTER` | `rpc` | `rpc`, `cli` or `http` |
| `EVE_FIT_ENGINE_URL` | – | engine base URL for `http`, e.g. `http://127.0.0.1:8080` |
| `EVE_FIT_RPC_CMD` | `{bin} --dataset {dataset} serve-stdio` | rpc command template |
| `EVE_FIT_CALC_CMD` / `EVE_FIT_BATCH_CMD` | `{bin} --dataset {dataset} calc` / `… batch` | cli templates |
| `EVE_FIT_WORKERS` | `1` | rpc engine processes |
| `EVE_FIT_TIMEOUT_MS` | `60000` | per engine call |
| `EVE_FIT_DEFAULT_SKILLS` | `5` | skill level when a fit gives none (engines alone default to 0) |
| `EVE_FIT_MAX_BATCH` | `400` | candidate budget per suggest call (optimise: 4×, capped at 1600) |
| `EVE_FIT_CACHE` | `2000` | calc results cached in memory by exact request (`0` = off) |
| `EVE_FIT_HTTP_HOST` / `EVE_FIT_HTTP_PORT` | `127.0.0.1` / `8765` | for `--http` |
| `EVE_FIT_ALLOWED_HOSTS` | loopback + bind host | extra `Host` header values accepted by `--http` (comma-separated; DNS-rebinding protection). `*` disables the check |

The templates make any engine pluggable. For example, variant C (Go):
`EVE_DOGMA_BIN=/path/eve-dogma-go`. It uses the same CLI shape, and its serve mode adds a response memo.

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "eve-fit": {
      "command": "node",
      "args": ["/path/to/eve-fit-mcp/dist/main.js"],
      "env": {
        "EVE_DOGMA_BIN": "/path/to/eve-dogma-rs/target/release/eve-dogma",
        "EVE_DOGMA_DATASET": "/path/to/dataset-3569502.json.gz"
      }
    }
  }
}
```

### Cursor

`~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "eve-fit": {
      "command": "node",
      "args": ["/path/to/eve-fit-mcp/dist/main.js"],
      "env": {
        "EVE_DOGMA_BIN": "/path/to/eve-dogma",
        "EVE_DOGMA_DATASET": "/path/to/dataset-3569502.json.gz",
        "EVE_FIT_WORKERS": "2"
      }
    }
  }
}
```

Over HTTP: run `EVE_DOGMA_BIN=… EVE_DOGMA_DATASET=… node dist/main.js --http --port 8765` and point the client
at `http://127.0.0.1:8765/mcp` (Cursor: `{"url": "http://127.0.0.1:8765/mcp"}`). The server binds to localhost
by default and has no authentication. Put a reverse proxy with auth in front before exposing it.

## Example

> *"Here's my Rifter (EFT …). What's the best low slot for more DPS without losing cap stability?"*

The assistant calls `suggest_modules` with
`{eft, replace_index: 1, goal: "dps", constraints: {min: {cap_stability: 0}}}`. Every compatible low-slot
module is computed in one batch, and the reply is a ranked table:

```
| # | module                          | Δ dps | cpu left | pg left |
|---|---------------------------------|-------|----------|---------|
| 1 | Tobias' Modified Gyrostabilizer | 9.2   | -27.75   | 1.34    |
…
```

## Development

```bash
npm test          # builds, then runs unit tests and integration tests that spawn the real engine on the real dataset
npm run schemas   # regenerate schemas/tools/*.json
```

Tests find the engine and dataset through `EVE_DOGMA_DATASET`, `EVE_DOGMA_BIN` (eve-dogma-rs) and `EVE_DOGMA_GO_BIN`
(variant C). Without them, they look for sibling checkouts under `EVE_FIT_DEV_ROOT`, which defaults to the parent
directory of this repo: `data/dataset-3569502.json.gz`, `eve-dogma-rs/target/release/eve-dogma` and
`lab-c/variant-c/bin/eve-dogma-go`. Suites whose engine or dataset is missing are skipped. CI therefore runs the unit
tests only. They cover:
* every tool, resource and prompt;
* EFT/DNA/JSON equivalence;
* the cli adapter, the worker pool, the http adapter (against `eve-dogma-go serve-http`), and variant C as the
  engine (identical numbers and identical EFT export);
* a bad engine binary;
* Streamable HTTP.

## Design notes
* **Stateless.** Every call carries the whole fit. Notes say what was assumed (e.g. skills).
  `request_hash` is the sha256 of the canonical normalised request.
* **Engine vs index.** The engine owns every number. The index only answers "what exists" and filters
  optimiser candidates statically (slot, ship restrictions, rig size, hardpoints). Engine violations have
  the final word.
* **Optimiser budget.** When a slot has more candidates than the budget allows, `suggest_modules` first
  evaluates one representative per group (the T2 item, else the highest meta), then every variant of the
  best 6 groups.
* NPC damage profiles are rounded community figures, marked *approximate*. Target profiles are typical
  hull sizes.

## Licence
MIT. EVE Online data © CCP hf., used under the CCP developer licence.
