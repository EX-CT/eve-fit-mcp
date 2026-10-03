// Engine-agnostic: the same tools over the one-shot CLI adapter, over variant C (Go) serve-stdio,
// a worker pool, and the Streamable HTTP transport.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { after, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { splitWords } from "../adapters/cmd.js";
import { call, connect, DATASET, GO_BIN, haveEngine, MAIN, RIFTER_EFT, ENGINE_BIN } from "./helpers.js";

/** Variant C predates the stats-ext outputs (mining, outgoing, bombing, heat, probe_size): compare the metrics it does return. */
function sameShared(c: Record<string, number | null>, f: Record<string, number | null>, msg = "engines agree on the shared metrics") {
  const keys = Object.keys(c).filter((k) => c[k] !== null);
  assert.ok(keys.length >= 30, `variant C returned only ${keys.length} metrics`);
  assert.deepEqual(Object.fromEntries(keys.map((k) => [k, c[k]])), Object.fromEntries(keys.map((k) => [k, f[k]])), msg);
}

test("mcp.adapters.command-split: command templates split like a shell", () => {
  assert.deepEqual(splitWords(`a --x "b c" 'd e' f\\ g`), ["a", "--x", "b c", "d e", "f g"]);
  assert.deepEqual(splitWords(`""`), [""]);
});

describe("adapters", { skip: !haveEngine && "engine or dataset missing" }, () => {
  let rpc: Client;
  let base: any;
  before(async () => {
    rpc = await connect();
    base = await call(rpc, "compute_fit", { eft: RIFTER_EFT });
  });
  after(async () => rpc?.close());

  test("mcp.adapters.cli-adapter: cli adapter (spawn per call) gives identical numbers", async () => {
    const c = await connect({ EVE_FIT_ADAPTER: "cli" });
    try {
      const info = await call(c, "engine_info", {});
      assert.equal(info.adapter, "cli");
      const r = await call(c, "compute_fit", { eft: RIFTER_EFT });
      assert.deepEqual(r.metrics, base.metrics);
      const s = await call(c, "suggest_modules", { eft: RIFTER_EFT, replace_index: 1, goal: "dps", top: 3 });
      assert.ok(s.suggestions.length > 0);
    } finally {
      await c.close();
    }
  });

  test("mcp.adapters.worker-pool: worker pool (EVE_FIT_WORKERS=3)", async () => {
    const c = await connect({ EVE_FIT_WORKERS: "3" });
    try {
      const s = await call(c, "suggest_modules", { eft: RIFTER_EFT, replace_index: 1, goal: "dps", top: 3 });
      const one = await call(rpc, "suggest_modules", { eft: RIFTER_EFT, replace_index: 1, goal: "dps", top: 3 });
      assert.deepEqual(s.suggestions, one.suggestions);
    } finally {
      await c.close();
    }
  });

  test("mcp.adapters.rpc-cmd-variant-c: variant C (Go) serve-stdio through EVE_FIT_RPC_CMD", { skip: !existsSync(GO_BIN) && "variant C binary missing" }, async () => {
    const c = await connect({ EVE_DOGMA_BIN: GO_BIN, EVE_FIT_RPC_CMD: "{bin} --dataset {dataset} serve-stdio" });
    try {
      const info = await call(c, "engine_info", {});
      assert.match(info.engine.engine, /go/i);
      const r = await call(c, "compute_fit", { eft: RIFTER_EFT });
      sameShared(r.metrics, base.metrics, "engines agree");
      const eft = (await call(c, "export_fit", { eft: RIFTER_EFT, format: "eft", name: "x" })).text;
      const eftRs = (await call(rpc, "export_fit", { eft: RIFTER_EFT, format: "eft", name: "x" })).text;
      assert.equal(eft, eftRs);
    } finally {
      await c.close();
    }
  });

  test("mcp.adapters.http-adapter-variant-c: http adapter against variant C serve-http", { skip: !existsSync(GO_BIN) && "variant C binary missing" }, async () => {
    const port = 19765 + Math.floor(Math.random() * 1000);
    const eng = spawn(GO_BIN, ["--dataset", DATASET, "serve-http", "-addr", `127.0.0.1:${port}`], { stdio: ["ignore", "ignore", "pipe"] });
    try {
      await new Promise<void>((res, rej) => {
        const t = setTimeout(() => rej(new Error("engine http did not start")), 20000);
        eng.stderr.on("data", (d) => {
          if (/serve-http on/.test(String(d))) {
            clearTimeout(t);
            res();
          }
        });
      });
      const c = await connect({ EVE_FIT_ADAPTER: "http", EVE_FIT_ENGINE_URL: `http://127.0.0.1:${port}` });
      try {
        const info = await call(c, "engine_info", {});
        assert.equal(info.adapter, "http");
        assert.equal(info.dataset_match, true);
        const r = await call(c, "compute_fit", { eft: RIFTER_EFT });
        sameShared(r.metrics, base.metrics);
        const s = await call(c, "suggest_modules", { eft: RIFTER_EFT, replace_index: 1, goal: "dps", top: 3 });
        const one = await call(rpc, "suggest_modules", { eft: RIFTER_EFT, replace_index: 1, goal: "dps", top: 3 });
        assert.deepEqual(s.suggestions, one.suggestions);
        const eft = (await call(c, "export_fit", { eft: RIFTER_EFT, format: "eft", name: "x" })).text;
        assert.match(eft, /^\[Rifter, x\]/);
      } finally {
        await c.close();
      }
    } finally {
      eng.kill();
    }
  });

  test("mcp.adapters.bad-engine-binary: bad engine binary gives an actionable error, not a hang", async () => {
    const c = await connect({ EVE_DOGMA_BIN: "/nonexistent/eve-dogma" });
    try {
      const r: any = await c.callTool({ name: "compute_fit", arguments: { eft: RIFTER_EFT } });
      assert.equal(r.isError, true);
      assert.match(r.content[0].text, /ENGINE_SPAWN|cannot start|exited/);
    } finally {
      await c.close();
    }
  });

  test("mcp.adapters.streamable-http: Streamable HTTP transport", async () => {
    const port = 18765 + Math.floor(Math.random() * 1000);
    const p = spawn(process.execPath, [MAIN, "--http", "--port", String(port)], {
      env: { ...process.env, EVE_DOGMA_BIN: ENGINE_BIN, EVE_DOGMA_DATASET: DATASET },
      stdio: ["ignore", "ignore", "pipe"],
    });
    try {
      await new Promise<void>((res, rej) => {
        const t = setTimeout(() => rej(new Error("http server did not start")), 20000);
        p.stderr.on("data", (d) => {
          if (/Streamable HTTP on/.test(String(d))) {
            clearTimeout(t);
            res();
          }
        });
      });
      const health = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
      assert.equal(health.ok, true);
      const c = new Client({ name: "http-test", version: "0" });
      await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
      const { tools } = await c.listTools();
      assert.ok(tools.length >= 18);
      const r = await call(c, "compute_fit", { eft: RIFTER_EFT });
      assert.deepEqual(r.metrics, base.metrics);
      await c.close();
      // DNS-rebinding protection: a foreign Host header is refused
      const status = await new Promise<number>((res, rej) => {
        const q = httpRequest(
          { host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { host: "evil.example", "content-type": "application/json", accept: "application/json, text/event-stream" } },
          (rs) => {
            rs.resume();
            res(rs.statusCode ?? 0);
          },
        );
        q.on("error", rej);
        q.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
      });
      assert.equal(status, 403);
    } finally {
      p.kill();
    }
  });
});
