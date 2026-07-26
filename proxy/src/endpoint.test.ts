// endpoint.test.ts — how the proxy resolves the studio's /mcp endpoint.
//
// The studio's port is the user-editable `network.port` setting (haywire repo,
// network/settings.py), so no baked-in constant is trustworthy. The authority
// is the identity sidecar the studio writes next to the token. These tests pin
// the precedence: FARMHAND_URL > sidecar url/port > compiled-in default.
//
// No fake studio is needed: `farmhand_studio_status` reports the endpoint it
// resolved in structuredContent.url, so down-mode is enough to observe it.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Must track DEFAULT_UPSTREAM_URL in index.ts. */
const DEFAULT_URL = "http://127.0.0.1:8124/mcp";

let failures = 0;
function check(cond: boolean, msg: string) {
  if (cond) console.error("[endpoint.test] PASS:", msg);
  else {
    failures++;
    console.error("[endpoint.test] FAIL:", msg);
  }
}

/**
 * Lay out a workspace the way the onboarding flow does — Claude Code opened in
 * a PARENT dir, project scaffolded into a subdirectory — and drop a token plus
 * (optionally) a sidecar beside it.
 */
function workspace(sidecar?: Record<string, unknown>): string {
  const ws = mkdtempSync(join(tmpdir(), "farmhand-endpoint-"));
  const projectDir = join(ws, "demo_project");
  mkdirSync(join(projectDir, ".haywire"), { recursive: true });
  writeFileSync(join(projectDir, ".haywire", "farmhand_token"), "test-token");
  if (sidecar) {
    writeFileSync(join(projectDir, ".haywire", "studio.json"), JSON.stringify(sidecar));
  }
  return ws;
}

/** Boot the proxy against `ws` and ask it which endpoint it resolved. */
async function resolvedUrl(ws: string, extraEnv: Record<string, string> = {}): Promise<string> {
  const client = new Client({ name: "endpoint-harness", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: {
      ...(process.env as Record<string, string>),
      CLAUDE_PROJECT_DIR: ws,
      FARMHAND_POLL_MS: "5000", // we only need the first resolution, not polling
      ...extraEnv,
    },
  });
  await client.connect(transport);
  try {
    const res = (await client.callTool({ name: "farmhand_studio_status", arguments: {} })) as {
      structuredContent?: { url?: string };
    };
    return res.structuredContent?.url ?? "";
  } finally {
    await client.close();
  }
}

// FARMHAND_URL is the operator's explicit override and beats everything.
{
  const ws = workspace({ url: "http://127.0.0.1:9001", port: 9001 });
  const url = await resolvedUrl(ws, { FARMHAND_URL: "http://127.0.0.1:7777/mcp" });
  check(url === "http://127.0.0.1:7777/mcp", `FARMHAND_URL overrides the sidecar, got ${url}`);
}

// The sidecar's `url` is the studio's own account of where it listens.
{
  const ws = workspace({ pid: 1, port: 9123, url: "http://127.0.0.1:9123" });
  const url = await resolvedUrl(ws);
  check(url === "http://127.0.0.1:9123/mcp", `sidecar url wins over the default, got ${url}`);
}

// A non-default port must survive — this is the whole point of reading the
// sidecar rather than hard-coding whatever the default happens to be today.
{
  const ws = workspace({ pid: 1, port: 51234, url: "http://127.0.0.1:51234" });
  const url = await resolvedUrl(ws);
  check(url === "http://127.0.0.1:51234/mcp", `user-configured port is honoured, got ${url}`);
}

// Sidecar with no `url` field: derive the endpoint from `port`.
{
  const ws = workspace({ pid: 1, port: 9200 });
  const url = await resolvedUrl(ws);
  check(url === "http://127.0.0.1:9200/mcp", `port-only sidecar derives the url, got ${url}`);
}

// Tolerate a sidecar that already carries /mcp — never double it.
{
  const ws = workspace({ pid: 1, port: 9300, url: "http://127.0.0.1:9300/mcp" });
  const url = await resolvedUrl(ws);
  check(url === "http://127.0.0.1:9300/mcp", `an existing /mcp suffix is not doubled, got ${url}`);
}

// Garbage sidecar must not crash the proxy — fall back to the default.
{
  const ws = mkdtempSync(join(tmpdir(), "farmhand-endpoint-"));
  const projectDir = join(ws, "demo_project");
  mkdirSync(join(projectDir, ".haywire"), { recursive: true });
  writeFileSync(join(projectDir, ".haywire", "farmhand_token"), "test-token");
  writeFileSync(join(projectDir, ".haywire", "studio.json"), "{ not json");
  const url = await resolvedUrl(ws);
  check(url === DEFAULT_URL, `unparseable sidecar falls back to the default, got ${url}`);
}

// No sidecar at all (studio has never run) — the compiled-in default.
{
  const ws = workspace();
  const url = await resolvedUrl(ws);
  check(url === DEFAULT_URL, `no sidecar falls back to the default, got ${url}`);
}

console.error(
  failures === 0 ? "[endpoint.test] endpoint resolution checks passed" : `[endpoint.test] ${failures} FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
