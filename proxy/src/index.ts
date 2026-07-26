#!/usr/bin/env node
/**
 * Farmhand stdio<->HTTP MCP proxy.
 *
 * Claude Code connects to THIS over stdio at session start (always succeeds,
 * because this process is trivially up). Behind it we dial the Haywire studio's
 * streamable-HTTP /mcp endpoint, which may not exist yet. When the studio comes
 * up mid-session we forward its tool/resource lists and re-emit list_changed so
 * the tools appear in Claude Code with no reconnect. When the studio dies, the
 * poll's liveness probe returns us to down-mode and re-emits list_changed.
 *
 * Facts pinned to primary sources (@modelcontextprotocol/sdk@1.29.0):
 *   - StreamableHTTPClientTransport(url, { requestInit: { headers } })  — src/client/streamableHttp.ts:100,149
 *   - low-level Server.sendToolListChanged()/sendResourceListChanged()  — src/server/index.ts:656,662
 *   - client.setNotificationHandler(ToolListChangedNotificationSchema)  — example simpleStreamableHttp.ts
 *   - stdio MUST NOT write non-MCP data to stdout (spec/transports)     — hence all logs -> stderr
 */
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

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
/**
 * Last-resort endpoint, used only when no sidecar can be found. Matches the
 * studio's `network.port` DEFAULT (haywire repo, network/settings.py) — but
 * that is a user-editable setting, not a constant, so this number is a guess
 * and the sidecar below is the real answer whenever it exists.
 */
const DEFAULT_UPSTREAM_URL = "http://127.0.0.1:8124/mcp";
const POLL_MS = Number(process.env.FARMHAND_POLL_MS ?? 2000);

const TOKEN_REL = join(".haywire", "farmhand_token");
const IDENTITY_FILE = "studio.json";

/**
 * Where to look for the bearer token, in priority order. The token lives at
 * `<project>/.haywire/farmhand_token` — the whole game is finding the project.
 *
 * Claude Code does NOT run the MCP server with cwd = workspace (it inherits the
 * launch dir / $HOME — CC issues #17565, #75266), so we do NOT trust
 * process.cwd(). We read the workspace from env vars CC exports to the MCP
 * subprocess (interpolated in plugin.json's env block):
 *   FARMHAND_TOKEN_PATH (explicit override) > HAYWIRE_WORKSPACE > CLAUDE_PROJECT_DIR
 * with homedir() as a last resort for manual/standalone runs.
 *
 * Crucially, the onboarding flow scaffolds the project into a SUBDIRECTORY of
 * the opened workspace (e.g. workspace `/testbed`, project `/testbed/demo`), so
 * the token is one level DOWN from the workspace, not directly in it. We
 * therefore check the token under `<base>` AND under each immediate subdir of
 * `<base>`.
 *
 * Computed at CALL TIME, not module load: the studio (and its token) may not
 * exist yet when the proxy starts — the project is created mid-session.
 */
function tokenCandidates(): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const push = (p: string) => {
    const r = resolve(p);
    if (!seen.has(r)) {
      seen.add(r);
      paths.push(r);
    }
  };

  if (process.env.FARMHAND_TOKEN_PATH) push(process.env.FARMHAND_TOKEN_PATH);

  const bases = [process.env.HAYWIRE_WORKSPACE, process.env.CLAUDE_PROJECT_DIR, homedir()];
  for (const base of bases) {
    if (!base) continue;
    push(join(base, TOKEN_REL)); // CC opened directly in the project
    // …and one level down: CC opened in the parent, project in a subdir.
    for (const child of immediateSubdirs(base)) push(join(base, child, TOKEN_REL));
  }
  return paths;
}

/** Immediate subdirectory names of `dir` (best-effort; [] on any error). */
function immediateSubdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

const log = (...a: unknown[]) => console.error("[farmhand-proxy]", ...a); // stderr only

// ---- upstream connection state ----------------------------------------------
let upstream: Client | null = null;
let upstreamTools: Tool[] = [];
let upstreamResources: Resource[] = [];

/**
 * Read the bearer token LAZILY — the file doesn't exist until the studio has
 * run once. Try each candidate path and return the first non-empty token; also
 * return which path it came from (for diagnostics).
 */
function readTokenFrom(): { token: string; path: string } | null {
  for (const p of tokenCandidates()) {
    try {
      const t = readFileSync(p, "utf8").trim();
      if (t.length > 0) return { token: t, path: p };
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

/**
 * The studio's /mcp endpoint, resolved LAZILY like the token — and for the same
 * reason: the studio may not exist when the proxy starts.
 *
 * The studio's port is the user-editable `network.port` setting, so no constant
 * can be trusted. The authoritative value is in the identity sidecar the studio
 * writes at startup, which lives in the SAME `.haywire/` directory as the token
 * — so once `readTokenFrom()` has located the project, the endpoint is free.
 *
 * Priority: FARMHAND_URL (explicit override) > sidecar `url`/`port` > default.
 */
function upstreamUrl(tokenPath?: string): string {
  if (process.env.FARMHAND_URL) return process.env.FARMHAND_URL;

  const found = tokenPath ?? readTokenFrom()?.path;
  if (found) {
    try {
      const id = JSON.parse(readFileSync(join(dirname(found), IDENTITY_FILE), "utf8"));
      const base =
        typeof id?.url === "string" && id.url
          ? id.url
          : Number.isInteger(id?.port)
            ? `http://127.0.0.1:${id.port}`
            : null;
      if (base) {
        const trimmed = base.replace(/\/+$/, "");
        // The studio writes the bare origin; tolerate it already carrying /mcp.
        return trimmed.endsWith("/mcp") ? trimmed : `${trimmed}/mcp`;
      }
    } catch {
      /* absent or garbage sidecar -> fall through to the default */
    }
  }
  return DEFAULT_UPSTREAM_URL;
}

/** The stdio-facing server Claude Code talks to. Created first, always up. */
const proxy = new Server(
  { name: "farmhand-mcp-server", version: "0.1.1" },
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
    const found = readTokenFrom();
    const url = upstreamUrl(found?.path);
    const text = up
      ? `Haywire studio reachable at ${url}; ${upstreamTools.length} tools available.`
      : `Haywire studio not running (no connection to ${url}). ` +
        (found
          ? `Token present (${found.path}).`
          : `No token found. Looked in: ${tokenCandidates().join(", ")}.`);
    return { content: [{ type: "text", text }], structuredContent: { up, url } };
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
  // One discovery pass feeds both the token and the endpoint beside it.
  const found = readTokenFrom();
  const transport = new StreamableHTTPClientTransport(new URL(upstreamUrl(found?.path)), {
    requestInit: found ? { headers: { Authorization: `Bearer ${found.token}` } } : undefined,
  });
  const client = new Client({ name: "farmhand-proxy-client", version: "0.1.1" });

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
  // Fast-path teardown for the streaming case: if the transport carries a
  // held-open stream, onclose fires the moment it drops. (For a stateless
  // studio there is no such stream — the poll's liveness probe catches it.)
  client.onclose = () => {
    if (upstream !== client) return; // already dropped by the probe
    log("upstream closed — back to down mode");
    dropUpstream();
  };

  await refreshTools();
  await refreshResources();
  log(`connected upstream: ${upstreamTools.length} tools, ${upstreamResources.length} resources`);
  // Tell Claude Code the real tools are here now — no reconnect needed.
  await proxy.sendToolListChanged();
  await proxy.sendResourceListChanged();
}

/** Return to down-mode: forget upstream, clear caches, re-emit list_changed. */
function dropUpstream(): void {
  const c = upstream;
  upstream = null;
  upstreamTools = [];
  upstreamResources = [];
  if (c) void c.close().catch(() => {});
  void proxy.sendToolListChanged();
  void proxy.sendResourceListChanged();
}

/**
 * Poll authority for BOTH directions. When down, try to connect. When up,
 * probe liveness (a cheap listTools) — a stateless HTTP studio has no
 * held-open stream to trigger onclose, so the probe is what notices it died.
 */
async function pollUpstream(): Promise<void> {
  if (!upstream) {
    await tryConnectUpstream();
    return;
  }
  try {
    upstreamTools = (await upstream.listTools()).tools;
  } catch (e) {
    log("upstream probe failed — back to down mode:", e instanceof Error ? e.message : e);
    dropUpstream();
  }
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
  const bases = [process.env.HAYWIRE_WORKSPACE, process.env.CLAUDE_PROJECT_DIR, homedir()]
    .filter(Boolean)
    .join(", ");
  log(
    // Endpoint is re-resolved per connect attempt; this is just the opening guess.
    `up. bridging stdio -> ${upstreamUrl()} (poll ${POLL_MS}ms). ` +
      `token search bases (+ their immediate subdirs): ${bases}` +
      (process.env.FARMHAND_TOKEN_PATH ? ` [override: ${process.env.FARMHAND_TOKEN_PATH}]` : ""),
  );

  // Poll so tools auto-appear the moment the studio comes up mid-session,
  // and disappear the moment it dies.
  const tick = async () => {
    try {
      await pollUpstream();
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
