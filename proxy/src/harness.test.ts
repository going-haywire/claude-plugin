/**
 * End-to-end harness — proves the bridge behaves.
 *
 * Run from `proxy/` via `npm test` (which builds first, then runs
 * `node dist/harness.test.js`). The proxy under test is `dist/index.js`,
 * spawned via StdioClientTransport.
 *
 * Timeline:
 *   t0  start proxy (studio DOWN). Client(stdio) -> proxy.
 *   t1  tools/list  => only the sentinel (down mode).
 *   t2  start a fake upstream MCP server on :8082/mcp with a bearer token,
 *       write the token file. Proxy's poll dials it.
 *   t3  proxy emits notifications/tools/list_changed; our stdio client's
 *       handler fires and re-lists => the 2 upstream tools appear. NO reconnect.
 *   t4  call an upstream tool THROUGH the proxy => upstream answers.
 */
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server as HttpServer } from "node:http";
import { spawn } from "node:child_process";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const PORT = 8082;
const TOKEN = "proto-secret-token";
const log = (...a: unknown[]) => console.error("[harness]", ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(cond: boolean, msg: string) {
  if (cond) log("PASS:", msg);
  else {
    failures++;
    log("FAIL:", msg);
  }
}

/** A minimal stateless streamable-HTTP MCP server standing in for the studio, token-gated. */
function startFakeStudio(): Promise<HttpServer> {
  const http = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401).end("unauthorized");
      return;
    }
    const server = new McpServer({ name: "fake-studio", version: "1.0.0" });
    server.registerTool(
      "studio_status",
      { description: "fake status", inputSchema: {} },
      async () => ({ content: [{ type: "text", text: "fake studio ok" }] }),
    );
    server.registerTool(
      "graph_editor_add_node",
      { description: "fake add node", inputSchema: { kind: z.string() } },
      async ({ kind }) => ({ content: [{ type: "text", text: `added ${kind}` }] }),
    );
    server.registerResource(
      "node-canon",
      "farmhand://docs/canon/nodes",
      { description: "fake node canon", mimeType: "text/plain" },
      async (uri) => ({ contents: [{ uri: uri.href, text: "NODE CANON BODY" }] }),
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => void transport.close());
    let body = "";
    for await (const chunk of req) body += chunk;
    await server.connect(transport);
    await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
  });
  return new Promise((resolve) => http.listen(PORT, "127.0.0.1", () => resolve(http)));
}

/**
 * stdio discipline: the proxy MUST NOT write non-MCP data to stdout. Spawn it
 * raw (no MCP client), drive an initialize + tools/list by hand, and assert
 * every non-empty stdout line is a JSON-RPC 2.0 frame — logs must go to stderr.
 */
async function checkStdioDiscipline(): Promise<void> {
  const child = spawn("node", ["dist/index.js"], {
    stdio: ["pipe", "pipe", "ignore"], // discard stderr; only stdout is under test
    env: {
      ...(process.env as Record<string, string>),
      // Point at a dead port + missing token so it stays cleanly in down-mode.
      FARMHAND_URL: "http://127.0.0.1:1/mcp",
      FARMHAND_TOKEN_PATH: join(tmpdir(), "farmhand-nonexistent-token"),
      FARMHAND_POLL_MS: "5000",
    },
  });
  let out = "";
  child.stdout.on("data", (b) => (out += b.toString()));

  const send = (obj: unknown) => child.stdin.write(JSON.stringify(obj) + "\n");
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "raw", version: "1.0.0" },
  } });
  await sleep(300);
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  await sleep(500);
  child.kill();

  const lines = out.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  let allJsonRpc = lines.length > 0;
  for (const line of lines) {
    try {
      const msg = JSON.parse(line) as { jsonrpc?: string };
      if (msg.jsonrpc !== "2.0") allJsonRpc = false;
    } catch {
      allJsonRpc = false;
      log("non-JSON stdout line leaked:", line);
    }
  }
  check(allJsonRpc, `stdout carries only JSON-RPC 2.0 frames (${lines.length} line(s), logs -> stderr)`);
}

async function main() {
  await checkStdioDiscipline();

  // Model the real getting-started layout: Claude Code is opened in a PARENT
  // workspace, and bootstrap scaffolds the project into a SUBDIRECTORY. The
  // token therefore lives one level DOWN from CLAUDE_PROJECT_DIR — the proxy
  // must discover it there, not just at <workspace>/.haywire.
  const ws = mkdtempSync(join(tmpdir(), "farmhand-proto-"));
  const projectDir = join(ws, "demo_project");
  mkdirSync(join(projectDir, ".haywire"), { recursive: true });
  const tokenPath = join(projectDir, ".haywire", "farmhand_token");

  // t0: start proxy with studio DOWN via StdioClientTransport (it spawns the process).
  const client = new Client({ name: "harness", version: "1.0.0" });
  let listChangedCount = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    listChangedCount++;
  });

  // Drive the token path the way the SHIPPED plugin does: via the workspace env
  // var (CLAUDE_PROJECT_DIR, which plugin.json maps to HAYWIRE_WORKSPACE) — NOT
  // an explicit FARMHAND_TOKEN_PATH. This proves the proxy derives
  // <workspace>/.haywire/farmhand_token from the env CC injects, since CC does
  // not run the MCP server with cwd = workspace.
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    stderr: "inherit", // proxy's stderr logs -> our terminal
    env: {
      ...(process.env as Record<string, string>),
      FARMHAND_URL: `http://127.0.0.1:${PORT}/mcp`,
      // Parent workspace; token is in ws/demo_project/.haywire — the proxy must
      // find it one level down, as it must for the real onboarding flow.
      CLAUDE_PROJECT_DIR: ws,
      FARMHAND_POLL_MS: "500",
    },
  });
  await client.connect(transport);

  // t1: studio down => only the two down-mode sentinels (status + connect).
  const down = await client.listTools();
  const downNames = down.tools.map((t) => t.name).sort();
  check(
    downNames.length === 2 &&
      downNames.includes("farmhand_studio_status") &&
      downNames.includes("farmhand_studio_connect"),
    `down mode: only the sentinel tools are listed, got [${downNames.join(", ")}]`,
  );

  // t2: bring the studio up + write the token.
  let studio = await startFakeStudio();
  writeFileSync(tokenPath, TOKEN);
  log("fake studio up + token written; waiting for proxy poll to notice...");

  // t3: within a few poll cycles, list_changed fires and the real tools appear.
  let appeared = false;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const now = await client.listTools();
    const names = now.tools.map((t) => t.name).sort();
    if (names.includes("graph_editor_add_node") && names.includes("studio_status")) {
      appeared = true;
      check(true, `upstream tools appeared WITHOUT reconnect: [${names.join(", ")}]`);
      break;
    }
  }
  check(appeared, "tools/list eventually reflects the live studio");
  check(listChangedCount > 0, `proxy emitted notifications/tools/list_changed (${listChangedCount}x)`);

  // t4: call a forwarded tool through the proxy.
  const res = await client.callTool({ name: "graph_editor_add_node", arguments: { kind: "Add" } });
  const text = (res.content as Array<{ type: string; text?: string }>)?.[0]?.text;
  check(text === "added Add", `forwarded tool call returned upstream result ("${text}")`);

  // t5: resource round-trip through the proxy.
  const resList = await client.listResources();
  check(
    resList.resources.some((r) => r.uri === "farmhand://docs/canon/nodes"),
    "upstream resource is listed through the proxy",
  );
  const read = await client.readResource({ uri: "farmhand://docs/canon/nodes" });
  const readBody = (read.contents?.[0] as { text?: string })?.text;
  check(readBody === "NODE CANON BODY", "resource read is forwarded from upstream");

  // t6: reconnect — kill the studio, proxy must return to down-mode.
  studio.close();
  let backToDown = false;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const now = await client.listTools();
    const names = now.tools.map((t) => t.name).sort();
    if (names.length === 2 && names.includes("farmhand_studio_status") && names.includes("farmhand_studio_connect")) {
      backToDown = true;
      break;
    }
  }
  check(backToDown, "proxy returns to down-mode after the studio dies");

  // cleanup
  await client.close();
  log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  log("harness fatal:", e);
  process.exit(1);
});
