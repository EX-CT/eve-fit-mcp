#!/usr/bin/env node
// eve-fit-mcp entry point: `eve-fit-mcp` (stdio) or `eve-fit-mcp --http [--port N] [--host H]` (Streamable HTTP).
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import { checkConfig, createAdapter, ENV_DOC, loadConfig } from "./config.js";
import { Dataset } from "./dataset.js";
import { createServer, loadPriceFile, VERSION, type ServerDeps } from "./server.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function log(msg: string) {
  process.stderr.write(`[eve-fit-mcp] ${msg}\n`);
}

async function readBody(req: IncomingMessage, limit = 8 << 20): Promise<unknown> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > limit) throw new Error("request body too large");
    chunks.push(c as Buffer);
  }
  const s = Buffer.concat(chunks).toString("utf8");
  return s ? JSON.parse(s) : undefined;
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(
      `eve-fit-mcp ${VERSION}\n\nUsage: eve-fit-mcp [--http [--port N] [--host H]]\n\nEnvironment:\n` +
        Object.entries(ENV_DOC)
          .map(([k, v]) => `  ${k.padEnd(22)} ${v}`)
          .join("\n") +
        "\n",
    );
    return;
  }
  if (process.argv.includes("--version")) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  const cfg = loadConfig();
  checkConfig(cfg);
  const ds = new Dataset(cfg.dataset);
  log(`dataset ${cfg.dataset}: ${ds.types.size} types, sde ${ds.sdeBuild}, indexed in ${Math.round(ds.loadMs)} ms`);
  const engine = createAdapter(cfg);
  const ctx: ServerDeps = { ds, engine, defaultSkillLevel: cfg.defaultSkillLevel, maxBatch: cfg.maxBatch };
  // EVE_FIT_PRICES: injected price file (path, URL or `latest`) loaded into the engine before serving. An explicit
  // path / URL that fails is fatal; `latest` without network and cache only warns (the embedded snapshot applies).
  if (process.env.EVE_FIT_PRICES) {
    try {
      const f = await loadPriceFile(ctx, process.env.EVE_FIT_PRICES);
      log(`prices: ${f!.path} (${f!.origin}${f!.release ? ` ${f!.release}` : ""}): ${f!.engine.types ?? "?"} types, snapshot ${f!.engine.price_snapshot_id ?? "-"}`);
    } catch (e: any) {
      if (process.env.EVE_FIT_PRICES.trim() !== "latest") {
        log(`ERROR: EVE_FIT_PRICES=${process.env.EVE_FIT_PRICES}: ${e?.code ? e.code + ": " : ""}${e?.message ?? e}`);
        process.exit(2);
      }
      log(`WARNING: EVE_FIT_PRICES=latest: ${e?.message ?? e}; the engine's embedded snapshot applies`);
    }
  }
  // fail fast if the engine cannot start, and warn when it uses a different dataset than the index
  engine
    .meta()
    .then((m) => {
      log(`engine ${m.engine ?? "?"} via ${engine.kind} adapter, sde ${m.sde_build ?? "?"}`);
      if (ds.sameDataset(m.dataset_sha256) === false) log(`WARNING: engine dataset sha256 ${m.dataset_sha256} ≠ MCP index ${ds.sha256}`);
    })
    .catch((e) => log(`WARNING: engine not ready: ${e.message}`));

  const shutdown = async () => {
    await engine.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  if (!process.argv.includes("--http")) {
    const server = createServer(ctx);
    await server.connect(new StdioServerTransport());
    process.stdin.on("end", shutdown);
    return;
  }

  const port = Number(arg("--port") ?? cfg.httpPort);
  const host = arg("--host") ?? cfg.httpHost;
  // DNS-rebinding protection: only accept Host headers naming this server (loopback by default).
  // EVE_FIT_ALLOWED_HOSTS adds names (comma-separated); "*" disables the check.
  const allowedHosts =
    cfg.allowedHosts === null
      ? undefined
      : [...new Set([...["127.0.0.1", "localhost", "[::1]", host].flatMap((h) => [h, `${h}:${port}`]), ...cfg.allowedHosts])];
  // Stateless Streamable HTTP: every POST gets a fresh McpServer + transport; the engine and index are shared.
  const http = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, version: VERSION, sde_build: ds.sdeBuild }));
      return;
    }
    if (url.pathname !== "/mcp") {
      res.writeHead(404).end("not found; MCP endpoint is /mcp");
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server: POST only)" }, id: null }));
      return;
    }
    try {
      const body = await readBody(req);
      const server = createServer(ctx);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
        enableDnsRebindingProtection: allowedHosts !== undefined,
        allowedHosts,
      });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e: any) {
      if (!res.headersSent) res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: e.message }, id: null }));
    }
  });
  http.listen(port, host, () => log(`Streamable HTTP on http://${host}:${port}/mcp`));
}

main().catch((e) => {
  log(`fatal: ${e?.stack ?? e}`);
  process.exit(1);
});
