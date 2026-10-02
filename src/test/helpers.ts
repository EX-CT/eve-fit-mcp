// Test helpers: spawn the real MCP server (dist/main.js) against a real engine and the shared dataset.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const MAIN = join(here, "..", "main.js");

export const DATASET = process.env.EVE_DOGMA_DATASET ?? "/workspace/exct-eve/data/dataset-3569502.json.gz";
export const RS_BIN = process.env.EVE_DOGMA_BIN ?? "/workspace/exct-eve/eve-dogma-rs/target/release/eve-dogma";
export const GO_BIN = process.env.EVE_DOGMA_GO_BIN ?? "/workspace/exct-eve/lab-c/variant-c/bin/eve-dogma-go";

export const haveEngine = existsSync(DATASET) && existsSync(RS_BIN);

export async function connect(env: Record<string, string> = {}): Promise<Client> {
  const t = new StdioClientTransport({
    command: process.execPath,
    args: [MAIN],
    env: { ...(process.env as Record<string, string>), EVE_DOGMA_BIN: RS_BIN, EVE_DOGMA_DATASET: DATASET, ...env },
    stderr: "ignore",
  });
  const c = new Client({ name: "eve-fit-mcp-test", version: "0" });
  await c.connect(t);
  return c;
}

export async function call(c: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const r: any = await c.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name}: ${r.content?.[0]?.text}`);
  return r.structuredContent ?? JSON.parse(r.content[r.content.length - 1].text);
}

export async function callErr(c: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const r: any = await c.callTool({ name, arguments: args });
  if (!r.isError) throw new Error(`${name}: expected an error`);
  return r.content[0].text as string;
}

export const RIFTER_EFT = `[Rifter, test rifter]
Damage Control II
Gyrostabilizer II
Small Ancillary Armor Repairer, Nanite Repair Paste
200mm Steel Plates II

5MN Microwarpdrive II
Warp Scrambler II
Stasis Webifier II

200mm AutoCannon II, Republic Fleet EMP S
200mm AutoCannon II, Republic Fleet EMP S
200mm AutoCannon II, Republic Fleet EMP S

Small Projectile Burst Aerator I
Small Projectile Collision Accelerator I

Warrior II x1`;
