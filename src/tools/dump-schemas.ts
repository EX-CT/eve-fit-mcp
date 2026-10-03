// Writes the JSON Schema of every tool input (exactly what tools/list advertises) to schemas/tools/*.json,
// plus schemas/tools/index.json with names, titles and descriptions.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EngineAdapter } from "../adapters/types.js";
import { Dataset } from "../dataset.js";
import { createServer } from "../server.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// Optional (tool schemas do not depend on it). Default: <EVE_FIT_DEV_ROOT or the parent of the repo>/data/dataset-3569502.json.gz.
const dataset = process.env.EVE_DOGMA_DATASET ?? join(process.env.EVE_FIT_DEV_ROOT ?? join(root, ".."), "data", "dataset-3569502.json.gz");
const noEngine = new Proxy({ kind: "none" }, { get: (t: any, k) => t[k] ?? (() => Promise.reject(new Error("no engine"))) }) as EngineAdapter;
// Tool schemas do not depend on the dataset; without one (e.g. in CI) a stub that throws on use is enough.
const noDataset = new Proxy({}, { get: (_t, k) => (k === "then" ? undefined : () => { throw new Error("no dataset"); }) }) as unknown as Dataset;
const ds = existsSync(dataset) ? new Dataset(dataset) : noDataset;
const server = createServer({ ds, engine: noEngine, defaultSkillLevel: 5, maxBatch: 400 });
const [a, b] = InMemoryTransport.createLinkedPair();
await server.connect(a);
const c = new Client({ name: "dump", version: "0" });
await c.connect(b);
const { tools } = await c.listTools();
const dir = join(root, "schemas", "tools");
mkdirSync(dir, { recursive: true });
for (const t of tools) writeFileSync(join(dir, `${t.name}.input.schema.json`), JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", title: t.name, description: t.description, ...t.inputSchema }, null, 2) + "\n");
writeFileSync(join(dir, "index.json"), JSON.stringify(tools.map((t) => ({ name: t.name, title: t.title, description: t.description, annotations: t.annotations })), null, 2) + "\n");
console.log(`wrote ${tools.length} tool schemas to ${dir}`);
await c.close();
process.exit(0);
