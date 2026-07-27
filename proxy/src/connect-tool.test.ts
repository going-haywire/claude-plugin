// connect-tool.test.ts — the escape hatch for a studio automatic discovery
// can't reach: a different workspace/project on the same machine, outside
// every path tokenCandidates() searches.
//
// Three things under test, none covered by harness.test.ts (fully token-gated
// fake studio) or endpoint.test.ts (URL resolution only, no live connect):
//
//   1. A studio with require_auth=false on the compiled-in default port is
//      picked up with NO token in reach at all — no farmhand_studio_connect
//      call needed. This is the part that "already worked" before this
//      change; a regression here would be silent (down-mode looks the same
//      as "auth required and rejected").
//   2. farmhand_studio_status distinguishes "nothing answered" from "a studio
//      answered and demanded a token I don't have" (HTTP 401) — the signal
//      that tells the agent to ask the user for a token instead of just
//      retrying forever.
//   3. farmhand_studio_connect actually redirects the proxy: right port+token
//      connects; wrong port reports unreachable; right port+wrong token
//      reports unauthorized; bad input is rejected cleanly.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server as HttpServer } from "node:http";
import { createServer as createTcpServer } from "node:net";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const DEFAULT_PORT = 8124; // must track DEFAULT_UPSTREAM_URL in index.ts
const TOKEN = "outside-workspace-secret";
const log = (...a: unknown[]) => console.error("[connect-tool.test]", ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(cond: boolean, msg: string) {
  if (cond) log("PASS:", msg);
  else {
    failures++;
    log("FAIL:", msg);
  }
}

/** A stateless streamable-HTTP MCP server standing in for a studio on `port`. */
function startFakeStudio(port: number, requireToken: string | null): Promise<HttpServer> {
  const http = createServer(async (req, res) => {
    if (requireToken !== null && req.headers.authorization !== `Bearer ${requireToken}`) {
      res.writeHead(401).end("unauthorized");
      return;
    }
    const server = new McpServer({ name: "fake-outside-studio", version: "1.0.0" });
    server.registerTool(
      "outside_tool",
      { description: "fake tool from the outside studio", inputSchema: {} },
      async () => ({ content: [{ type: "text", text: "outside ok" }] }),
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => void transport.close());
    let body = "";
    for await (const chunk of req) body += chunk;
    await server.connect(transport);
    await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
  });
  return new Promise((resolve) => http.listen(port, "127.0.0.1", () => resolve(http)));
}

/** Grab an ephemeral port, then release it immediately for a fake studio to bind. */
async function freePort(): Promise<number> {
  const srv = createTcpServer();
  const port: number = await new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });
  await new Promise((r) => srv.close(r));
  return port;
}

/**
 * Spawn the proxy against a fresh, empty workspace (no `.haywire/` at all, so
 * `tokenCandidates()` finds nothing) and return a connected client. Modeling
 * "studio is in a different project" from the very first request, not a
 * workspace whose token merely hasn't been written yet.
 */
async function connectedProxy(extraEnv: Record<string, string> = {}): Promise<Client> {
  const ws = mkdtempSync(join(tmpdir(), "connect-tool-"));
  const client = new Client({ name: "connect-tool-harness", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: "node",
      args: ["dist/index.js"],
      env: {
        ...(process.env as Record<string, string>),
        CLAUDE_PROJECT_DIR: ws,
        FARMHAND_POLL_MS: "300",
        ...extraEnv,
      },
    }),
  );
  return client;
}

async function statusOf(client: Client): Promise<{ text: string; structured: Record<string, unknown> }> {
  const res = (await client.callTool({ name: "farmhand_studio_status", arguments: {} })) as {
    content?: Array<{ text?: string }>;
    structuredContent?: Record<string, unknown>;
  };
  return { text: res.content?.[0]?.text ?? "", structured: res.structuredContent ?? {} };
}

// --- 1. no-token studio on the compiled-in default port is picked up with ---
//        ZERO discovery input — no sidecar, no token file, nothing.
{
  const studio = await startFakeStudio(DEFAULT_PORT, null);
  const client = await connectedProxy();

  let up = false;
  for (let i = 0; i < 20 && !up; i++) {
    await sleep(300);
    const names = (await client.listTools()).tools.map((t) => t.name);
    up = names.includes("outside_tool");
  }
  check(up, "no-token studio on the default port is connected with no token in reach");

  await client.close();
  await new Promise((r) => studio.close(r));
}

// --- 2. status distinguishes "nothing there" from "there, but 401" ----------
{
  const port = await freePort();
  const studio = await startFakeStudio(port, TOKEN);
  const client = await connectedProxy({ FARMHAND_URL: `http://127.0.0.1:${port}/mcp` });

  await sleep(600); // let at least one poll attempt land
  const { text, structured } = await statusOf(client);
  check(structured.up === false, "401'd studio is NOT reported as up");
  check(
    /requires a token|rejected/.test(text) && text.includes("farmhand_studio_connect"),
    `status names the 401 and points at farmhand_studio_connect, got "${text}"`,
  );
  check(
    structured.reason === "unauthorized",
    // structuredContent must carry the distinction too — a client that renders
    // only structured data (not the prose `text`) needs this to tell "401" apart
    // from "nothing answered" without parsing English.
    `structuredContent.reason distinguishes 401 from unreachable, got "${JSON.stringify(structured)}"`,
  );

  await client.close();
  await new Promise((r) => studio.close(r));
}

// --- 3a. farmhand_studio_connect: right port + right token -> connects ------
{
  const port = await freePort();
  const studio = await startFakeStudio(port, TOKEN);
  const client = await connectedProxy({ FARMHAND_POLL_MS: "60000" }); // no auto-poll race

  const before = await statusOf(client);
  check(before.structured.up === false, "precondition: nothing reachable before connect()");

  const res = (await client.callTool({
    name: "farmhand_studio_connect",
    arguments: { port, token: TOKEN },
  })) as { isError?: boolean; content?: Array<{ text?: string }>; structuredContent?: Record<string, unknown> };
  check(res.isError !== true, `connect() with the right port+token succeeds, got "${res.content?.[0]?.text}"`);
  check(res.structuredContent?.up === true, "connect() reports up:true");

  const names = (await client.listTools()).tools.map((t) => t.name);
  check(names.includes("outside_tool"), "the outside studio's tools are now listed");

  await client.close();
  await new Promise((r) => studio.close(r));
}

// --- 3b. farmhand_studio_connect: wrong port -> unreachable, not a crash ----
{
  const deadPort = await freePort(); // freed, nothing listens
  const client = await connectedProxy({ FARMHAND_POLL_MS: "60000" });

  const res = (await client.callTool({
    name: "farmhand_studio_connect",
    arguments: { port: deadPort },
  })) as { isError?: boolean; content?: Array<{ text?: string }> };
  check(res.isError === true, "connect() to a dead port reports an error, not a silent success");
  check(
    /no studio answered/i.test(res.content?.[0]?.text ?? ""),
    `error names the failure as unreachable, got "${res.content?.[0]?.text}"`,
  );

  await client.close();
}

// --- 3c. farmhand_studio_connect: right port, wrong token -> unauthorized ---
{
  const port = await freePort();
  const studio = await startFakeStudio(port, TOKEN);
  const client = await connectedProxy({ FARMHAND_POLL_MS: "60000" });

  const res = (await client.callTool({
    name: "farmhand_studio_connect",
    arguments: { port, token: "definitely-wrong" },
  })) as { isError?: boolean; content?: Array<{ text?: string }> };
  check(res.isError === true, "connect() with the wrong token reports an error");
  check(
    /rejected the token/i.test(res.content?.[0]?.text ?? ""),
    `error distinguishes a rejected token from unreachable, got "${res.content?.[0]?.text}"`,
  );

  await client.close();
  await new Promise((r) => studio.close(r));
}

// --- 3d. bad input is rejected, not thrown as an unhandled exception --------
{
  const client = await connectedProxy({ FARMHAND_POLL_MS: "60000" });

  const res = (await client.callTool({
    name: "farmhand_studio_connect",
    arguments: { port: 999999 },
  })) as { isError?: boolean; content?: Array<{ text?: string }> };
  check(res.isError === true, "out-of-range port is rejected");
  check(/1-65535/.test(res.content?.[0]?.text ?? ""), "out-of-range port names the valid range");

  await client.close();
}

console.error(
  failures === 0 ? "[connect-tool.test] connect-tool checks passed" : `[connect-tool.test] ${failures} FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
