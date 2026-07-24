/**
 * PROTOTYPE harness — proves the bridge behaves.
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

async function main() {
  const ws = mkdtempSync(join(tmpdir(), "farmhand-proto-"));
  mkdirSync(join(ws, ".haywire"), { recursive: true });
  const tokenPath = join(ws, ".haywire", "farmhand_token");

  // t0: start proxy with studio DOWN via StdioClientTransport (it spawns the process).
  const client = new Client({ name: "harness", version: "1.0.0" });
  let listChangedCount = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    listChangedCount++;
  });

  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    stderr: "inherit", // proxy's stderr logs -> our terminal
    env: {
      ...(process.env as Record<string, string>),
      FARMHAND_URL: `http://127.0.0.1:${PORT}/mcp`,
      FARMHAND_TOKEN_PATH: tokenPath,
      FARMHAND_POLL_MS: "500",
    },
  });
  await client.connect(transport);

  // t1: studio down => sentinel only.
  const down = await client.listTools();
  check(
    down.tools.length === 1 && down.tools[0]!.name === "farmhand_studio_status",
    "down mode: only the sentinel tool is listed",
  );

  // t2: bring the studio up + write the token.
  const studio = await startFakeStudio();
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

  // cleanup
  await client.close();
  studio.close();
  log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  log("harness fatal:", e);
  process.exit(1);
});
