#!/usr/bin/env node
/**
 * PROTOTYPE — Farmhand stdio<->HTTP MCP proxy.
 *
 * Claude Code connects to THIS over stdio at session start (always succeeds,
 * because this process is trivially up). Behind it we dial the Haywire studio's
 * streamable-HTTP /mcp endpoint, which may not exist yet. When the studio comes
 * up mid-session we forward its tool/resource lists and re-emit list_changed so
 * the tools appear in Claude Code with no reconnect.
 *
 * Throwaway: proves the reconnect + list_changed flow. Not production code.
 *
 * Facts pinned to primary sources (@modelcontextprotocol/sdk@1.29.0):
 *   - StreamableHTTPClientTransport(url, { requestInit: { headers } })  — src/client/streamableHttp.ts:100,149
 *   - low-level Server.sendToolListChanged()/sendResourceListChanged()  — src/server/index.ts:656,662
 *   - client.setNotificationHandler(ToolListChangedNotificationSchema)  — example simpleStreamableHttp.ts
 *   - stdio MUST NOT write non-MCP data to stdout (spec/transports)     — hence all logs -> stderr
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
  type Tool,
  type Resource,
} from "@modelcontextprotocol/sdk/types.js";

// ---- config (env-overridable; sensible Haywire defaults) --------------------
const UPSTREAM_URL = process.env.FARMHAND_URL ?? "http://127.0.0.1:8082/mcp";
const TOKEN_PATH = resolve(
  process.env.FARMHAND_TOKEN_PATH ??
    `${process.env.HAYWIRE_WORKSPACE ?? homedir()}/.haywire/farmhand_token`,
);
const POLL_MS = Number(process.env.FARMHAND_POLL_MS ?? 2000);

const log = (...a: unknown[]) => console.error("[farmhand-proxy]", ...a); // stderr only

// ---- upstream connection state ----------------------------------------------
let upstream: Client | null = null;
let upstreamTools: Tool[] = [];
let upstreamResources: Resource[] = [];

/** Read the bearer token LAZILY — the file doesn't exist until the studio has run once. */
function readToken(): string | null {
  try {
    const t = readFileSync(TOKEN_PATH, "utf8").trim();
    return t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

/** The stdio-facing server Claude Code talks to. Created first, always up. */
const proxy = new Server(
  { name: "farmhand-mcp-server", version: "0.0.0-proto" },
  { capabilities: { tools: { listChanged: true }, resources: { listChanged: true } } },
);

// Sentinel so the model has an affordance while the studio is down.
const STATUS_TOOL: Tool = {
  name: "farmhand_studio_status",
  description:
    "Report whether the Haywire studio (Farmhand MCP server) is reachable. " +
    "Always available, even when the studio is down.",
  inputSchema: { type: "object", properties: {} },
};

// ---- request handlers: forward to upstream, or answer locally when down ------
proxy.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: upstream ? upstreamTools : [STATUS_TOOL] };
});

proxy.setRequestHandler(ListResourcesRequestSchema, async () => {
  return { resources: upstream ? upstreamResources : [] };
});

proxy.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  if (!upstream) throw new Error("Haywire studio not running — cannot read resources yet.");
  return upstream.readResource({ uri: req.params.uri });
});

proxy.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  if (name === "farmhand_studio_status") {
    const up = upstream !== null;
    const text = up
      ? `Haywire studio reachable at ${UPSTREAM_URL}; ${upstreamTools.length} tools available.`
      : `Haywire studio not running (no connection to ${UPSTREAM_URL}). ` +
        (readToken() ? "Token present." : `No token at ${TOKEN_PATH} yet.`);
    return { content: [{ type: "text", text }], structuredContent: { up, url: UPSTREAM_URL } };
  }

  if (!upstream) {
    return {
      isError: true,
      content: [
        { type: "text", text: `Studio not running — cannot call '${name}'. Start it, then retry.` },
      ],
    };
  }
  // Straight passthrough. Upstream's own errors flow back as-is.
  return upstream.callTool({ name, arguments: args ?? {} });
});

// ---- upstream lifecycle: connect when studio appears, drop when it dies ------
async function tryConnectUpstream(): Promise<void> {
  if (upstream) return; // already connected
  const token = readToken();
  const transport = new StreamableHTTPClientTransport(new URL(UPSTREAM_URL), {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
  });
  const client = new Client({ name: "farmhand-proxy-client", version: "0.0.0-proto" });

  // Re-emit upstream list_changed across the stdio boundary — the whole point.
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    await refreshTools();
    await proxy.sendToolListChanged();
  });
  client.setNotificationHandler(ResourceListChangedNotificationSchema, async () => {
    await refreshResources();
    await proxy.sendResourceListChanged();
  });

  try {
    await client.connect(transport);
  } catch (e) {
    // Studio still down / token wrong. Stay in "down" mode; poll will retry.
    await transport.close().catch(() => {});
    return;
  }

  upstream = client;
  client.onclose = () => {
    log("upstream closed — back to down mode");
    upstream = null;
    upstreamTools = [];
    upstreamResources = [];
    void proxy.sendToolListChanged();
    void proxy.sendResourceListChanged();
  };

  await refreshTools();
  await refreshResources();
  log(`connected upstream: ${upstreamTools.length} tools, ${upstreamResources.length} resources`);
  // Tell Claude Code the real tools are here now — no reconnect needed.
  await proxy.sendToolListChanged();
  await proxy.sendResourceListChanged();
}

async function refreshTools(): Promise<void> {
  if (!upstream) return;
  upstreamTools = (await upstream.listTools()).tools;
}
async function refreshResources(): Promise<void> {
  if (!upstream) return;
  try {
    upstreamResources = (await upstream.listResources()).resources;
  } catch {
    upstreamResources = []; // upstream may not advertise resources
  }
}

// ---- main -------------------------------------------------------------------
async function main(): Promise<void> {
  await proxy.connect(new StdioServerTransport());
  log(`up. bridging stdio -> ${UPSTREAM_URL} (poll ${POLL_MS}ms). token: ${TOKEN_PATH}`);

  // Poll so tools auto-appear the moment the studio comes up mid-session.
  const tick = async () => {
    try {
      await tryConnectUpstream();
    } catch (e) {
      log("poll error:", e instanceof Error ? e.message : e);
    }
  };
  await tick();
  setInterval(() => void tick(), POLL_MS).unref();
}

main().catch((e) => {
  log("fatal:", e);
  process.exit(1);
});
