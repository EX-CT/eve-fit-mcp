// Test helpers: spawn the real MCP server (dist/main.js) against a real engine and the shared dataset.
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const MAIN = join(here, "..", "main.js");

// Engine/dataset locations come from the environment. Fallbacks assume sibling checkouts next to this repo
// (EVE_FIT_DEV_ROOT, default: the parent directory of the repo): <root>/data/dataset-3569502.json.gz,
// <root>/eve-dogma/target/release/eve-fit (engine F, the default; else the older <root>/lab-f/variant-f/target/release/eve-dogma-f;
// EVE_DOGMA_BIN selects another, e.g. eve-dogma-rs), <root>/lab-c/variant-c/bin/eve-dogma-go. Missing files skip the suites.
export const DEV_ROOT = process.env.EVE_FIT_DEV_ROOT ?? join(here, "..", "..", "..");
export const DATASET = process.env.EVE_DOGMA_DATASET ?? join(DEV_ROOT, "data", "dataset-3569502.json.gz");
const DEV_BINS = [join(DEV_ROOT, "eve-dogma", "target", "release", "eve-fit"), join(DEV_ROOT, "lab-f", "variant-f", "target", "release", "eve-dogma-f")];
export const ENGINE_BIN = process.env.EVE_DOGMA_BIN ?? DEV_BINS.find((b) => existsSync(b)) ?? DEV_BINS[0];
export const GO_BIN = process.env.EVE_DOGMA_GO_BIN ?? join(DEV_ROOT, "lab-c", "variant-c", "bin", "eve-dogma-go");

export const haveEngine = existsSync(DATASET) && existsSync(ENGINE_BIN);

export async function connect(env: Record<string, string> = {}): Promise<Client> {
  const t = new StdioClientTransport({
    command: process.execPath,
    args: [MAIN],
    env: { ...(process.env as Record<string, string>), EVE_DOGMA_BIN: ENGINE_BIN, EVE_DOGMA_DATASET: DATASET, ...env },
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

/** |got - want| within the bench tolerance (1e-6 relative, 1e-3 absolute near 0), or `tol` relative. */
export function near(got: unknown, want: number, what: string, tol = 1e-4) {
  assert.equal(typeof got, "number", `${what}: ${JSON.stringify(got)} is not a number`);
  const g = got as number;
  assert.ok(Math.abs(g - want) <= Math.max(1e-3, Math.abs(want) * tol), `${what}: ${g} vs Pyfa ${want}`);
}

/** bench core case exct_rifter (an illegal fit: 4 highs on 3 slots, CPU/calibration over; Pyfa computes it anyway). */
export const EXCT_RIFTER = {
  ship: "Rifter",
  modules: [
    { name: "Damage Control II", state: "active" },
    { name: "Gyrostabilizer II", state: "active" },
    { name: "200mm Steel Plates II", state: "active" },
    { name: "1MN Afterburner II", state: "active" },
    { name: "Warp Scrambler II", state: "active" },
    { name: "Stasis Webifier II", state: "active" },
    { name: "200mm AutoCannon II", charge: "Republic Fleet EMP S", state: "active" },
    { name: "200mm AutoCannon II", charge: "Republic Fleet EMP S", state: "active" },
    { name: "200mm AutoCannon II", charge: "Republic Fleet EMP S", state: "active" },
    { name: "Rocket Launcher II", charge: "Nova Rage Rocket", state: "active" },
    { name: "Small Projectile Burst Aerator II", state: "online" },
    { name: "Small Projectile Collision Accelerator II", state: "online" },
    { name: "Small Explosive Armor Reinforcer II", state: "online" },
  ],
  drones: [{ name: "Warrior II", quantity: 2, active: 2 }],
};
