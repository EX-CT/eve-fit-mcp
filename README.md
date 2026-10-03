# eve-fit-mcp

An [MCP](https://modelcontextprotocol.io) server for EVE Online ship fitting. Through it, an AI assistant can
search items, build and validate fits, compute Pyfa-parity statistics, compare alternatives, run what-if
scenarios, and let a batch-evaluating optimiser suggest modules.

It is **engine-agnostic**. Numbers come from any engine that implements the stateless
[eve-dogma contract](https://github.com/EX-CT/eve-dogma-rs/blob/main/docs/contract.md):
**engine F** (`eve-fit`, Rust, the mainline engine from [EX-CT/eve-dogma](https://github.com/EX-CT/eve-dogma); native
build of crate `eve-cli` at the commit pinned in [`engines.lock`](engines.lock), LGPL-3.0-or-later) by default, or any
other contract engine via `EVE_DOGMA_BIN`: the older `eve-dogma-f` (eve-dogma-lab), `eve-dogma-rs` (`eve-dogma`,
variant A, frozen), the Go variant C, and so on. The engine runs
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
| `get_ship` | slots, hardpoints, rig size, CPU/PG/calibration, drone bay, hull traits (role and per-skill bonus lines, en/zh), plus the empty hull's computed stats with skills |
| `list_presets` | skill presets, pirate implant sets (from the dataset), incoming damage profiles, target profiles, metric keys |
| `parse_fit` | EFT / DNA / lenient JSON → strict contract FitRequest, every item named, `request_hash` |
| `export_fit` | EFT (Pyfa-exact, from the engine), DNA, multibuy, JSON |
| `validate_fit` | violations with module names and fix hints, resource usage, missing skills |
| `compute_fit` | full stats: compact summary + named metrics, or `detail: "full"` with `sections`. The summary includes mining yield, outgoing remote repair / cap transfer (with spool range), bombs to kill, overheat burnout, validation (codes, missing skills by name, fix hints), capacitor recharge, agility / mass / warp distance, probe size. With docs/23 price inputs (`price_overrides`, `prices`, `price: true`) the engine's `price` block comes back unchanged. `detail: "full"` is the engine's calc output verbatim (identical to a `compute_batch` result's stats); the MCP's `request_hash` / `notes` / `engine` are in the result `_meta["eve-fit-mcp"]`. Fit-level `damage_pattern` / `target_profile` may be the engine's built-ins (`{"builtin": "Uniform"}`) |
| `compute_batch` | many fits in one engine call (docs/23 BatchRequest → BatchResponse, passed through): `fits`, `base` + `variants` (JSON Patch, `swap_type`), `product` / `sweep` (capped by `max_combinations`); `fields`, `deltas`, `filter`, `sort_by`, `top_n`; batch-wide and per-variant `price_overrides`. Fit sources may use names, EFT or DNA. A fit the MCP cannot normalise goes to the engine unchanged and errors in place (its index), never the whole batch. Needs an engine with the `batch` RPC (else `UNKNOWN_METHOD`) |
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
| `browse_market` | the in-game market tree: roots, a group by id / name / `a/b/c` path, `depth`, `meta_groups` filter (`T1`, `T2`, `Faction` …), item counts. `get_type` also shows an item's market path and its meta variations |
| `list_graphs` | the engine's graphs (Pyfa graph set: DPS/volley vs range, applied DPS vs target speed/signature, cap, speed/distance vs time, warp, EHP/RPS, lock time …) with their axes, defaults and whether they need a target |
| `compute_graph` | one graph for a fit: `x` (`values` or `from`/`to`/`points`), the y series, a `target` (profile preset or object, or a target fit given as `fit`/`eft`/`dna`), graph params. Returns the series and a min/max/at-x summary (`table` for the raw points) |
| `get_prices` | prices for types by id or name, from ESI (universe average) or Fuzzwork (trade-hub sell/buy), with source and age |
| `load_prices` | load / update the engine's injected price file (docs/23 file layer, = `eve-fit --prices FILE`): path, URL, or `latest` (newest EX-CT/eve-market-prices release); `clear: true`; no arguments = status. Later results say `provenance.price_source: "file"` |
| `price_fit` | Pyfa-style price panel. With a docs/23 engine the engine prices the fit: the MCP injects the market table (+ your own `isk`) as `prices.isk` and passes `price_overrides`; the answer is the engine's price block (total, sections, per-item lines with source, missing). Older engines: legacy MCP sum (`priced_by: "mcp-legacy"`) |

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
* `eve://prices/sources`

Prompts: `fit_for_role`, `review_fit`, `explain_stat`, `compare_options`.

JSON Schemas of all tool inputs are in [`schemas/tools/`](schemas/tools) (`npm run schemas` regenerates them
from the live server). The contract schemas are in `schemas/fit-request.schema.json` / `fit-stats.schema.json`.

## Quick install (release package)

Every `v*` tag publishes a [GitHub Release](https://github.com/EX-CT/eve-fit-mcp/releases) with a prebuilt npm
tarball (`eve-fit-mcp.tgz`, plus `SHA256SUMS`). Nothing is published to the npm registry. Install the package
straight from the release.

1. **Dataset:** download the latest `dataset-*.json.gz` from
   [EX-CT/eve-sde-pipeline releases](https://github.com/EX-CT/eve-sde-pipeline/releases/latest):
   `gh release download -R EX-CT/eve-sde-pipeline -p 'dataset-*.json.gz'`.
   The release's `manifest.json` names the file and its SHA-256.
2. **Engine:** the default is `eve-fit` (engine F) on `PATH`. F compiles the dataset into the binary, so build
   it with the same file you give the MCP (stable Rust; the commit is the one in [`engines.lock`](engines.lock)):

   ```bash
   EVE_DOGMA_DATASET=/path/to/dataset.json.gz cargo install --locked \
     --git https://github.com/EX-CT/eve-dogma --rev 8bde0ba83c19c31267c88ae1b572b2baab2f3b0b eve-cli   # installs eve-fit
   ```

   Any other contract engine works through `EVE_DOGMA_BIN`, e.g. eve-dogma-rs (variant A, frozen):
   `cargo install --git https://github.com/EX-CT/eve-dogma-rs` and `EVE_DOGMA_BIN=eve-dogma`.
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

To pin a version, replace `latest/download/eve-fit-mcp.tgz` with e.g. `download/v0.4.2/eve-fit-mcp-0.4.2.tgz`. To install
globally, run `npm install -g https://github.com/EX-CT/eve-fit-mcp/releases/latest/download/eve-fit-mcp.tgz` and use `"command": "eve-fit-mcp"`. Check the install with
`npx -y --package=https://github.com/EX-CT/eve-fit-mcp/releases/latest/download/eve-fit-mcp.tgz eve-fit-mcp --help`.

## Install from source

```bash
git clone https://github.com/EX-CT/eve-fit-mcp && cd eve-fit-mcp
npm ci && npm run build
# the default engine, F (eve-fit from EX-CT/eve-dogma; pinned commit in engines.lock, see "Quick install" step 2),
# or any contract engine via EVE_DOGMA_BIN (eve-dogma-rs, variant C, ...)
# a dataset: dataset-<build>.json.gz from the EX-CT/eve-sde-pipeline releases
```

## Configuration (environment)

| variable | default | meaning |
|---|---|---|
| `EVE_DOGMA_DATASET` | (required) | dataset used by the engine **and** the search index (also needed with `http`: the index is local) |
| `EVE_DOGMA_BIN` | `eve-fit` | engine binary (F by default; e.g. `eve-dogma-f` for the pre-migration F build, `eve-dogma` for eve-dogma-rs, `eve-dogma-go` for variant C) |
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
| `EVE_FIT_PRICE_SOURCE` | `esi` | `esi` or `fuzzwork` (see [Prices](#prices)) |
| `EVE_FIT_PRICE_SYSTEM` | `jita` | Fuzzwork trade hub: `jita`, `amarr`, `dodixie`, `rens`, `hek` |
| `EVE_FIT_PRICE_CACHE` | `$XDG_CACHE_HOME/eve-fit-mcp` (else `~/.cache/eve-fit-mcp`) | price cache directory; `off` = memory only |
| `EVE_FIT_PRICE_TTL_S` | `3600` | price cache lifetime (ESI: its `Expires` header wins) |
| `EVE_FIT_PRICES` | – | injected price file loaded into the engine at start: path / URL of an eve-price-snapshot v1 or `{type_id: isk}` map, or `latest` (newest EX-CT/eve-market-prices release, cached in `<price cache>/snapshots`; offline: the newest cached one). A bad path / URL stops the server; `latest` without network or cache only warns |
| `EVE_FIT_PRICES_REPO` | `EX-CT/eve-market-prices` | releases used by `latest` |
| `EVE_FIT_OFFLINE` | – | `1` = never fetch prices; use the cache whatever its age (answers are marked stale) |
| `EVE_FIT_USER_AGENT` | names this project | User-Agent for ESI / Fuzzwork; add your contact (ESI etiquette) |
| `EVE_FIT_ESI_URL` / `EVE_FIT_FUZZWORK_URL` | public endpoints | override the price endpoints (mirrors, tests) |

The templates make any engine pluggable. For example, eve-dogma-rs (variant A): `EVE_DOGMA_BIN=/path/eve-dogma`;
variant C (Go): `EVE_DOGMA_BIN=/path/eve-dogma-go` (same CLI shape; its serve mode adds a response memo). F (`eve-fit`, and the older `eve-dogma-f`)
accepts and ignores `--dataset` (its dataset is compiled in), so the default templates work for all of them.

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "eve-fit": {
      "command": "node",
      "args": ["/path/to/eve-fit-mcp/dist/main.js"],
      "env": {
        "EVE_DOGMA_BIN": "/path/to/.cargo/bin/eve-fit",
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
        "EVE_DOGMA_BIN": "/path/to/eve-fit",
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

## Prices

Prices are computed by the **engine** (EX-CT/eve-fit-docs docs/22 / docs/23): `price_overrides` by type / market group
(with children) / group / category, fixed (0 = self-built) or multiplier; precedence variant overrides > request overrides >
injected prices (`prices.isk`) > the engine's market snapshot (Jita 4-4 sell band rule, made by
[EX-CT/eve-market-prices](https://github.com/EX-CT/eve-market-prices)). The MCP only resolves names to ids and passes the
fields through (`compute_fit`, `compute_batch`, `price_fit`); it does no pricing math once the engine returns a `price` block.

`price_fit` injects the live market table, so the engine's embedded snapshot (eve-dogma 8bde0ba+: `jita44-20261003T063856Z`)
only fills items without a market price (`use_snapshot: false` leaves them unpriced); every line names its `source`.
Every engine result carries **`provenance`** (docs/22 §2.3: `sde_build`, `sde_hash`, `sde_source`, `price_source`
`request` / `file` / `snapshot` / `none`, `snapshot_time`, `price_snapshot_id`, `price_hash`, `engine`). `compute_fit`
returns it in the summary and as a `detail=full` section, `compute_batch` at the top level and per result (and in its
table header), `price_fit` next to the price block.

**Price data layers** (docs/23 §5): request `price_overrides` > request `prices.isk` > the injected price file
(`load_prices` / `EVE_FIT_PRICES`, the engine's `--prices FILE` / RPC `prices_load`) > the engine's embedded snapshot.
`load_prices {source: "latest"}` updates to the newest daily eve-market-prices snapshot without a new engine release.

Errors from the engine keep their contract code verbatim (`Error: UNKNOWN_TYPE: …`, `BAD_PRICE_OVERRIDE`, `BATCH_TOO_LARGE`, …);
input errors found by the MCP itself are `BAD_REQUEST`. The tool result also carries the engine's error object as
`structuredContent.error` with all its fields (e.g. `BATCH_TOO_LARGE` `count` / `limit`).

`get_prices` and `price_fit` are the only tools that use the network, and only when they are called.

| source | endpoint | price |
|---|---|---|
| `esi` (default) | CCP ESI `GET /markets/prices/` (one request covers every type) | `average_price`, falling back to `adjusted_price` |
| `fuzzwork` | `market.fuzzwork.co.uk/aggregates/?system=<hub>&types=…` | hub sell 5th percentile (and buy 95th percentile) |

Prices are cached in memory and on disk (`prices-<source>-<system>.json`) for `EVE_FIT_PRICE_TTL_S`. On a network
error the cache is used whatever its age, and with `EVE_FIT_OFFLINE=1` nothing is fetched; both cases say so in the
answer (`stale`, `age_s`). Prices are indicative only: market data lags, and averages are not what you pay in a hub.

Attribution: EVE Online market data comes from CCP's ESI under the
[CCP Developer License](https://developers.eveonline.com/license-agreement); EVE Online and all related marks are
property of CCP hf. Trade-hub aggregates are provided by Steve Ronuken's [Fuzzwork](https://market.fuzzwork.co.uk/);
please keep request volume low (this server batches one request per lookup and caches).

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

Tests find the engine and dataset through `EVE_DOGMA_DATASET`, `EVE_DOGMA_BIN` (default engine: F; set it to
eve-dogma-rs or another engine to test that one) and `EVE_DOGMA_GO_BIN` (variant C). Without them, they look for
sibling checkouts under `EVE_FIT_DEV_ROOT`, which defaults to the parent directory of this repo:
`data/dataset-3569502.json.gz`, `eve-dogma/target/release/eve-fit` (else `lab-f/variant-f/target/release/eve-dogma-f`) and
`lab-c/variant-c/bin/eve-dogma-go`.
Suites whose engine or dataset is missing are skipped. CI's `test` job runs the unit tests (Node 20 and 22); its
`engine` job builds F (`eve-fit`) from `engines.lock` on the latest SDE-pipeline dataset and runs the integration suites
against it (only the variant C suites skip there). They cover:
* every tool, resource and prompt;
* EFT/DNA/JSON equivalence;
* the cli adapter, the worker pool, the http adapter (against `eve-dogma-go serve-http`), and variant C as the
  engine (identical numbers and identical EFT export);
* a bad engine binary;
* Streamable HTTP;
* engine values through `compute_fit` (`src/test/stats.test.ts`, Pyfa-backed numbers) and validation
  (`src/test/validation.test.ts`, bench `val_*` cases).

Every test title starts with a stable id (`mcp.<file>.<slug>`); [`docs/test-ids.md`](docs/test-ids.md) lists them with
the docs/19 inventory items each covers (`python3 tools/test-ids.py` regenerates it).

**mcp-bench.** `tools/mcp-dogma-bench.py` replays eve-dogma-bench cases through the MCP (stdio, `compute_fit
detail:"full"`) and scores them with the bench tolerances: core (339), ext (Pyfa stats-ext suite), effects (2378 per-effect
micro-fits; must equal the engine run directly) and cap (150). CI's `engine` job runs all four at the bench commits in
`engines.lock` and fails below the engine's own score.

```bash
python3 tools/mcp-dogma-bench.py run --bench ../eve-dogma-bench --cap-bench ../eve-dogma-bench-cap --suite core,ext,effects,cap --out mcp-bench.json
```

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
