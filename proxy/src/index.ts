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
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
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
 * A manual override supplied mid-session via the `farmhand_studio_connect`
 * tool — for a studio outside every path `tokenCandidates()` can reach (a
 * different workspace on the same machine). Nothing here is persisted: it
 * lives only for the life of this process, same as `upstream` below.
 *
 * `FARMHAND_URL`/`FARMHAND_TOKEN_PATH` (env, set before the session starts)
 * still take priority — this is the mid-session equivalent for a user who
 * didn't know the port in advance.
 */
let manualOverride: { port: number; token?: string } | null = null;

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
 * Outcome of the most recent connect attempt, for `farmhand_studio_status` to
 * report between polls. In particular this is what carries the "found a
 * studio, but it wants a token" signal — a 401 is not the same as nothing
 * being there, and only this lets the status tool tell them apart.
 */
type LastAttempt =
  | { kind: "connected" }
  | { kind: "unreachable" }
  | { kind: "unauthorized" };
let lastAttempt: LastAttempt = { kind: "unreachable" };

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

interface Connection {
  url: string;
  token: string | null;
  /** Where this URL/token pair came from — for status text and logs. */
  source: "env" | "manual" | "sidecar" | "default";
}

/**
 * Resolve where to dial and what bearer token (if any) to send, LAZILY on
 * every attempt — the studio may not exist yet, and the manual override can
 * change mid-session via `farmhand_studio_connect`.
 *
 * The URL and the token are resolved independently, NOT as one atomic choice:
 * `FARMHAND_URL` overrides only the address (this predates the sidecar work —
 * pointing at a fixed URL for a test harness, say — and token discovery must
 * keep running underneath it, same as before). `manualOverride`, by contrast,
 * carries an explicit token from the user and so DOES override both together
 * — a manually-supplied port has no sidecar of its own to read a token from.
 *
 * URL precedence: FARMHAND_URL > manualOverride.port > sidecar `url`/`port` >
 * DEFAULT_UPSTREAM_URL (a bare guess, for a studio running with
 * require_auth off).
 * Token precedence: manualOverride.token > discovered file token > none.
 */
function resolveConnection(): Connection {
  const found = readTokenFrom();

  if (process.env.FARMHAND_URL) {
    return { url: process.env.FARMHAND_URL, token: found?.token ?? null, source: "env" };
  }

  if (manualOverride) {
    return {
      url: `http://127.0.0.1:${manualOverride.port}/mcp`,
      token: manualOverride.token ?? found?.token ?? null,
      source: "manual",
    };
  }

  if (found) {
    try {
      const id = JSON.parse(readFileSync(join(dirname(found.path), IDENTITY_FILE), "utf8"));
      const base =
        typeof id?.url === "string" && id.url
          ? id.url
          : Number.isInteger(id?.port)
            ? `http://127.0.0.1:${id.port}`
            : null;
      if (base) {
        const trimmed = base.replace(/\/+$/, "");
        // The studio writes the bare origin; tolerate it already carrying /mcp.
        const url = trimmed.endsWith("/mcp") ? trimmed : `${trimmed}/mcp`;
        return { url, token: found.token, source: "sidecar" };
      }
    } catch {
      /* absent or garbage sidecar -> fall through, but keep the token found */
    }
    return { url: DEFAULT_UPSTREAM_URL, token: found.token, source: "sidecar" };
  }

  return { url: DEFAULT_UPSTREAM_URL, token: null, source: "default" };
}

/** The stdio-facing server Claude Code talks to. Created first, always up. */
const proxy = new Server(
  { name: "farmhand-mcp-server", version: "0.1.1" },
  { capabilities: { tools: { listChanged: true }, resources: { listChanged: true } } },
);

// Sentinels so the model has affordances while the studio is down.
const STATUS_TOOL: Tool = {
  name: "farmhand_studio_status",
  description:
    "Report whether the Haywire studio (Farmhand MCP server) is reachable. " +
    "Always available, even when the studio is down.",
  inputSchema: { type: "object", properties: {} },
};

const CONNECT_TOOL: Tool = {
  name: "farmhand_studio_connect",
  description:
    "Point the proxy at a Haywire studio the automatic discovery can't find — " +
    "typically one running in a DIFFERENT workspace/project on this machine, " +
    "which is outside every path farmhand_studio_status can search. Ask the " +
    "user for the port (and the token, if farmhand_studio_status reported " +
    "one is required) rather than guessing. Takes effect immediately and for " +
    "the rest of this session only; it is not saved anywhere.",
  inputSchema: {
    type: "object",
    properties: {
      port: { type: "number", description: "The studio's port, e.g. 8124." },
      token: {
        type: "string",
        description: "Bearer token from that studio's .haywire/farmhand_token, if it requires one.",
      },
    },
    required: ["port"],
  },
};

// ---- request handlers: forward to upstream, or answer locally when down ------
proxy.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: upstream ? upstreamTools : [STATUS_TOOL, CONNECT_TOOL] };
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
    const conn = resolveConnection();
    let text: string;
    if (up) {
      text = `Haywire studio reachable at ${conn.url}; ${upstreamTools.length} tools available.`;
    } else if (lastAttempt.kind === "unauthorized") {
      text =
        `A studio answered at ${conn.url} but rejected the request — it requires a token this ` +
        `proxy doesn't have (source: ${conn.source}). Ask the user for the token from that ` +
        `studio's .haywire/farmhand_token, then call farmhand_studio_connect with the port ` +
        `and token.`;
    } else {
      text =
        `Haywire studio not running (no connection to ${conn.url}, source: ${conn.source}). ` +
        (conn.token
          ? `Token present.`
          : `No token found in the workspace. Looked in: ${tokenCandidates().join(", ")}. `) +
        `If a studio is running under a different project on this machine, ask the user for ` +
        `its port (and token, if it requires one) and call farmhand_studio_connect.`;
    }
    return {
      content: [{ type: "text", text }],
      structuredContent: { up, url: conn.url, source: conn.source, reason: up ? "connected" : lastAttempt.kind },
    };
  }

  if (name === "farmhand_studio_connect") {
    const port = Number((args as Record<string, unknown> | undefined)?.port);
    const token = (args as Record<string, unknown> | undefined)?.token;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return {
        isError: true,
        content: [{ type: "text", text: `'port' must be an integer 1-65535, got ${String(port)}.` }],
      };
    }
    if (token !== undefined && typeof token !== "string") {
      return { isError: true, content: [{ type: "text", text: `'token' must be a string if provided.` }] };
    }

    manualOverride = { port, token: token as string | undefined };
    dropUpstream(); // discard any existing connection so the override takes effect now
    await tryConnectUpstream();

    const conn = resolveConnection();
    const text = upstream
      ? `Connected: ${conn.url}, ${upstreamTools.length} tools available.`
      : lastAttempt.kind === "unauthorized"
        ? `A studio answered at ${conn.url} but rejected the token (missing, wrong, or the ` +
          `studio needs a different one). Ask the user to double-check it.`
        : `No studio answered at ${conn.url}. Ask the user to confirm the port and that the ` +
          `studio is running.`;
    return {
      isError: !upstream,
      content: [{ type: "text", text }],
      structuredContent: { up: upstream !== null, url: conn.url, reason: lastAttempt.kind },
    };
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
  const conn = resolveConnection();
  const transport = new StreamableHTTPClientTransport(new URL(conn.url), {
    requestInit: conn.token ? { headers: { Authorization: `Bearer ${conn.token}` } } : undefined,
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
    await transport.close().catch(() => {});
    // A 401 means something IS there — distinct from nothing answering at all.
    // This is the signal that lets farmhand_studio_status point the user at
    // farmhand_studio_connect instead of just reporting "not running".
    lastAttempt = e instanceof StreamableHTTPError && e.code === 401
      ? { kind: "unauthorized" }
      : { kind: "unreachable" };
    return;
  }

  lastAttempt = { kind: "connected" };
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
 * probe liveness (a cheap ping) — a stateless HTTP studio has no held-open
 * stream to trigger onclose, so the probe is what notices it died. Tool-list
 * freshness is handled separately, by the studio's own list_changed
 * notification (see tryConnectUpstream) — the studio has a single change
 * pipeline that always fires it, so the probe doesn't need to re-list.
 */
async function pollUpstream(): Promise<void> {
  if (!upstream) {
    await tryConnectUpstream();
    return;
  }
  try {
    await upstream.ping();
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
    `up. bridging stdio -> ${resolveConnection().url} (poll ${POLL_MS}ms). ` +
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
