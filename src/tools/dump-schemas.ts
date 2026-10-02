// Writes the JSON Schema of every tool input (exactly what tools/list advertises) to schemas/tools/*.json,
// plus schemas/tools/index.json with names, titles and descriptions.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EngineAdapter } from "../adapters/types.js";
import { Dataset } from "../dataset.js";
import { createServer } from "../server.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dataset = process.env.EVE_DOGMA_DATASET ?? "/workspace/exct-eve/data/dataset-3569502.json.gz";
const noEngine = new Proxy({ kind: "none" }, { get: (t: any, k) => t[k] ?? (() => Promise.reject(new Error("no engine"))) }) as EngineAdapter;
const server = createServer({ ds: new Dataset(dataset), engine: noEngine, defaultSkillLevel: 5, maxBatch: 400 });
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
