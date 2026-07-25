/**
 * studioctl — Haywire studio launch + sidecar-aware lifecycle (CONSUMER side).
 *
 * The studio (haywire repo) writes `<workspace>/.haywire/studio.json` at
 * startup. This module READS that sidecar to decide, when :8082 is busy,
 * whether the listener is *mine* (reuse it), *another project's* (ask the
 * user), or a stranger (unknown). It never writes the sidecar — that's the
 * producer's job, and it already landed in the haywire repo.
 *
 * The launch path spawns `uv run haywire` DETACHED so the studio outlives this
 * Node process (and thus the Claude Code session that triggered it).
 */
import { readFileSync, openSync } from "node:fs";
import { join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createConnection } from "node:net";

const run = promisify(execFile);

/** The studio's fixed local port (haywire repo's default). */
export const DEFAULT_PORT = 8082;

/** Sidecar shape the studio writes. We tolerate missing/extra fields. */
export interface StudioIdentity {
  pid?: number;
  port?: number;
  project?: string;
  project_path?: string;
  started_at?: string;
  host?: string;
  role?: string;
  url?: string;
}

export type StudioState = "mine" | "other" | "unknown" | "stale" | "free";

export interface ResolveResult {
  state: StudioState;
  /** This workspace's sidecar, if present and parseable. */
  identity?: StudioIdentity;
  /** The PID actually holding the port, if we could determine it. */
  port_owner_pid?: number;
  /** For "other": the identity of the project that owns the port. */
  other_identity?: StudioIdentity;
  /** Best URL to reach the studio, when one is known. */
  url?: string;
}

export interface StartResult {
  status: "started" | "reused";
  url: string;
}

interface ResolveOpts {
  /** Override the port (tests use an ephemeral one). Defaults to DEFAULT_PORT. */
  port?: number;
}

// ---- primitives -------------------------------------------------------------

/** Is something listening on 127.0.0.1:port? (TCP connect probe.) */
function isPortOpen(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ port, host: "127.0.0.1" });
    const done = (open: boolean) => {
      sock.destroy();
      resolve(open);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

/** Read + parse a workspace's studio.json. Absent/garbage -> null. */
export function readIdentity(workspace: string): StudioIdentity | null {
  try {
    const raw = readFileSync(join(workspace, ".haywire", "studio.json"), "utf8");
    const obj = JSON.parse(raw) as StudioIdentity;
    return obj && typeof obj === "object" ? obj : null;
  } catch {
    return null;
  }
}

/** Is `pid` a live process? Uses signal 0 (no-op probe). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means it exists but we can't signal it — still alive.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The PID listening on 127.0.0.1:port, or null. Cross-platform. */
async function portOwnerPid(port: number): Promise<number | null> {
  if (process.platform === "win32") {
    try {
      const { stdout } = await run("netstat", ["-ano"], { timeout: 5000 });
      for (const line of stdout.split(/\r?\n/)) {
        // e.g. "  TCP    127.0.0.1:8082   0.0.0.0:0   LISTENING   1234"
        if (!/LISTENING/i.test(line)) continue;
        if (!new RegExp(`[:.]${port}\\b`).test(line)) continue;
        const cols = line.trim().split(/\s+/);
        const pid = Number(cols[cols.length - 1]);
        if (Number.isInteger(pid) && pid > 0) return pid;
      }
      return null;
    } catch {
      return null;
    }
  }
  // macOS / Linux. Query by PORT only — NOT pinned to 127.0.0.1: the studio
  // binds the wildcard address (`*:8082`), which an `@127.0.0.1` filter misses
  // even though a loopback connect probe still reaches it. `-iTCP:<port>`
  // matches *:port, 127.0.0.1:port and [::1]:port alike.
  try {
    const { stdout } = await run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
      timeout: 5000,
    });
    // May list several fds/PIDs (one per line); the first listener is the owner.
    for (const tok of stdout.trim().split(/\s+/)) {
      const pid = Number(tok);
      if (Number.isInteger(pid) && pid > 0) return pid;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The working directory of a running PID (macOS/Linux via lsof).
 * Windows has no cheap cwd lookup -> null (documented limitation: an "other"
 * studio there degrades to "unknown").
 */
async function pidCwd(pid: number): Promise<string | null> {
  if (process.platform === "win32") return null;
  try {
    const { stdout } = await run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
      timeout: 5000,
    });
    // -Fn output: lines prefixed 'n' carry the name; the cwd line is `n<path>`.
    for (const line of stdout.split(/\r?\n/)) {
      if (line.startsWith("n")) return line.slice(1);
    }
    return null;
  } catch {
    return null;
  }
}

// ---- resolve ----------------------------------------------------------------

/**
 * Classify the studio situation for `workspace` against the sidecar contract.
 *
 *   free     — nothing on the port and no live sidecar to reconcile.
 *   mine     — my sidecar's pid IS the process holding the port. Reuse it.
 *   other    — the port is held by a DIFFERENT project (named via its sidecar).
 *   unknown  — the port is held but we can't attribute it to any sidecar.
 *   stale    — my sidecar records a dead pid and the port is closed. Clean up.
 */
export async function resolveStudio(
  workspace: string,
  opts: ResolveOpts = {},
): Promise<ResolveResult> {
  const port = opts.port ?? DEFAULT_PORT;
  const identity = readIdentity(workspace) ?? undefined;
  const open = await isPortOpen(port);

  if (!open) {
    // Port is closed. A sidecar pointing at a dead pid is stale; otherwise free.
    if (identity?.pid && !pidAlive(identity.pid)) {
      return { state: "stale", identity };
    }
    return { state: "free", identity };
  }

  // Port is open — who holds it?
  const owner = await portOwnerPid(port);

  if (identity?.pid && owner !== null && identity.pid === owner) {
    return {
      state: "mine",
      identity,
      port_owner_pid: owner,
      url: identity.url ?? `http://127.0.0.1:${port}/mcp`,
    };
  }

  // Someone else holds the port. Try to name them via their cwd's sidecar.
  if (owner !== null) {
    const cwd = await pidCwd(owner);
    const otherIdentity = cwd ? readIdentity(cwd) ?? undefined : undefined;
    if (otherIdentity) {
      return { state: "other", identity, port_owner_pid: owner, other_identity: otherIdentity };
    }
  }

  // Port held but unattributable to a project (no owner pid, or no sidecar).
  return { state: "unknown", identity, port_owner_pid: owner ?? undefined };
}

// ---- launch -----------------------------------------------------------------

/**
 * Start the studio for `workspace`, detached, and wait until :8082 answers.
 *
 * If the port is already held by MY studio, reuse it (no second process). Any
 * other busy-port situation is the caller's decision — resolve first and ask
 * the user; startStudio only launches when the port is free or already mine.
 */
export async function startStudio(
  workspace: string,
  opts: { timeout?: number; port?: number } = {},
): Promise<StartResult> {
  const port = opts.port ?? DEFAULT_PORT;
  const timeout = opts.timeout ?? 30_000;

  const resolved = await resolveStudio(workspace, { port });
  if (resolved.state === "mine") {
    return { status: "reused", url: resolved.url ?? `http://127.0.0.1:${port}/mcp` };
  }
  if (resolved.state === "other" || resolved.state === "unknown") {
    throw new Error(
      `Port ${port} is already in use by ${
        resolved.state === "other"
          ? `another project (${resolved.other_identity?.project ?? "unknown"})`
          : "an unknown process"
      }. Resolve this before launching.`,
    );
  }

  // Free or stale: launch. Detach so the studio outlives this process.
  const logPath = join(workspace, ".haywire", "studio.log");
  let fd: number;
  try {
    fd = openSync(logPath, "a");
  } catch {
    fd = openSync(process.platform === "win32" ? "NUL" : "/dev/null", "a");
  }

  const child = spawn("uv", ["run", "haywire"], {
    cwd: workspace,
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  child.unref();

  // Poll until the studio answers or we time out.
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await isPortOpen(port)) {
      const identity = readIdentity(workspace);
      return { status: "started", url: identity?.url ?? `http://127.0.0.1:${port}/mcp` };
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  // Timed out — surface the log tail to help diagnose.
  let tail = "";
  try {
    tail = readFileSync(logPath, "utf8").split("\n").slice(-20).join("\n");
  } catch {
    /* no log */
  }
  throw new Error(`Studio did not come up on :${port} within ${timeout}ms.\n--- studio.log tail ---\n${tail}`);
}

// CLI entrypoint: `node dist/studioctl.js [resolve|start] [workspace]`.
if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, ws] = process.argv.slice(2);
  const workspace = ws ?? process.cwd();
  (async () => {
    if (cmd === "start") {
      const r = await startStudio(workspace);
      console.log(JSON.stringify(r, null, 2));
    } else {
      const r = await resolveStudio(workspace);
      console.log(JSON.stringify(r, null, 2));
    }
    process.exit(0);
  })().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
