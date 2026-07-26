// studioctl.launch.test.ts — the startStudio() launch path, against a fake `uv`.
//
// startStudio hardcodes `spawn("uv", ["run", "haywire"])`, so these tests put a
// stub `uv` first on PATH rather than adding a test-only seam to the production
// signature. spawn resolves the command through the PATH in the env it is
// handed, and startStudio spreads process.env — so mutating process.env.PATH
// here is what the child actually resolves against.
//
// The stub is driven by files in the workspace (its cwd) because the argv is
// fixed: `.fake-uv-port` says which port to listen on; absent/empty means
// "crash on startup", which exercises the timeout diagnostic path.
//
// POSIX only — the stub relies on a shebang, and studioctl's port-owner and cwd
// lookups already degrade to "unknown" on Windows by design.
import { startStudio } from "./studioctl.js";
import { writeFileSync, mkdirSync, mkdtempSync, existsSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.error("[studioctl.launch.test] PASS:", msg);
  else {
    failures++;
    console.error("[studioctl.launch.test] FAIL:", msg);
  }
}

if (process.platform === "win32") {
  console.error("[studioctl.launch.test] SKIP: POSIX-only (shebang stub)");
  process.exit(0);
}

/** PIDs of stub studios to reap, so a failed assert never leaks a listener. */
const spawned: number[] = [];

/** A workspace with NO .haywire/ — the state a first-ever launch starts from. */
function freshWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "fc-launch-"));
}

/** Grab an ephemeral port number, then release it so the stub can bind it. */
async function freePort(): Promise<number> {
  const srv = createServer();
  const port: number = await new Promise((resolve) => {
    srv.listen(0, () => {
      const addr = srv.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });
  await new Promise((r) => srv.close(r));
  return port;
}

function log(ws: string): string {
  try {
    return readFileSync(join(ws, ".haywire", "studio.log"), "utf8");
  } catch {
    return "";
  }
}

// --- install the stub `uv` on PATH -------------------------------------------
// Writes its sidecar BEFORE listening, mirroring the real studio (identity.py
// runs at startup) and making the returned URL deterministic: startStudio reads
// the sidecar the instant the port answers.
const binDir = mkdtempSync(join(tmpdir(), "fc-bin-"));
writeFileSync(
  join(binDir, "uv"),
  `#!/usr/bin/env node
const { readFileSync, writeFileSync, mkdirSync } = require("node:fs");
const { createServer } = require("node:net");
const { join } = require("node:path");

console.log("FAKE_UV_STARTED args=" + process.argv.slice(2).join(" "));
console.log("PYTHONUNBUFFERED=" + process.env.PYTHONUNBUFFERED);

let port = 0;
try { port = Number(readFileSync("./.fake-uv-port", "utf8").trim()) || 0; } catch {}
if (!port) {
  console.log("FAKE_UV_CRASHED: no port file");
  process.exit(3);
}

mkdirSync(".haywire", { recursive: true });
writeFileSync(join(".haywire", "studio.json"), JSON.stringify({
  pid: process.pid,
  port,
  project: "fake-studio",
  project_path: process.cwd(),
  started_at: Date.now() / 1000,
  url: "http://127.0.0.1:" + port,
}));
createServer().listen(port, () => console.log("FAKE_UV_LISTENING"));
`,
);
chmodSync(join(binDir, "uv"), 0o755);
process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;

// --- fresh workspace: .haywire/ is created, output is captured ----------------
// Regression: .haywire/ is created by the STUDIO at startup, so it does not
// exist when startStudio opens the log. openSync used to ENOENT and fall back
// to /dev/null, silently discarding every byte the studio wrote.
{
  const ws = freshWorkspace();
  const port = await freePort();
  writeFileSync(join(ws, ".fake-uv-port"), String(port));

  assert(!existsSync(join(ws, ".haywire")), "precondition: workspace has no .haywire/ yet");

  const r = await startStudio(ws, { port, timeout: 10_000 });
  const identity = JSON.parse(readFileSync(join(ws, ".haywire", "studio.json"), "utf8"));
  spawned.push(identity.pid);

  assert(r.status === "started", `fresh workspace -> started, got ${r.status}`);
  assert(existsSync(join(ws, ".haywire", "studio.log")), "studio.log was created, not /dev/null'd");
  assert(log(ws).includes("FAKE_UV_STARTED"), "child stdout landed in studio.log");
  assert(log(ws).includes("args=run haywire"), "child was invoked as `uv run haywire`");
  assert(
    r.url === `http://127.0.0.1:${port}`,
    `url comes from the sidecar the child wrote, got ${r.url}`,
  );
}

// --- PYTHONUNBUFFERED reaches the child --------------------------------------
// Without it, fd 1 being a file puts CPython in 8 KiB block-buffered mode and
// plain print() never reaches the log until the process exits.
{
  const ws = freshWorkspace();
  const port = await freePort();
  writeFileSync(join(ws, ".fake-uv-port"), String(port));

  const r = await startStudio(ws, { port, timeout: 10_000 });
  spawned.push(JSON.parse(readFileSync(join(ws, ".haywire", "studio.json"), "utf8")).pid);

  assert(r.status === "started", `second launch -> started, got ${r.status}`);
  assert(log(ws).includes("PYTHONUNBUFFERED=1"), "PYTHONUNBUFFERED=1 was passed to the child");
  assert(log(ws).includes("PATH") === false, "sanity: log holds child output, not a dumped env");
}

// --- "mine" short-circuits: reuse, never spawn -------------------------------
{
  const ws = freshWorkspace();
  mkdirSync(join(ws, ".haywire"), { recursive: true });
  const srv = createServer();
  const port: number = await new Promise((resolve) => {
    srv.listen(0, () => {
      const addr = srv.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });
  // WE hold the port, and the sidecar names us -> state "mine".
  writeFileSync(
    join(ws, ".haywire", "studio.json"),
    JSON.stringify({ pid: process.pid, port, project: "p", project_path: ws, url: `http://127.0.0.1:${port}` }),
  );

  const r = await startStudio(ws, { port, timeout: 10_000 });
  assert(r.status === "reused", `port held by my own studio -> reused, got ${r.status}`);
  assert(r.url === `http://127.0.0.1:${port}`, `reuse returns the sidecar url, got ${r.url}`);
  assert(log(ws) === "", "reuse spawned nothing (studio.log never written)");
  await new Promise((res) => srv.close(res));
}

// --- busy port we cannot attribute: refuse to launch -------------------------
{
  const ws = freshWorkspace();
  const srv = createServer();
  const port: number = await new Promise((resolve) => {
    srv.listen(0, () => {
      const addr = srv.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });
  // No sidecar in ws, and our cwd has none either -> "unknown".
  let threw = "";
  try {
    await startStudio(ws, { port, timeout: 10_000 });
  } catch (e) {
    threw = (e as Error).message;
  }
  assert(threw.includes("already in use"), `unattributable busy port throws, got "${threw}"`);
  assert(log(ws) === "", "refusal spawned nothing");
  await new Promise((res) => srv.close(res));
}

// --- the studio lands on a port we did NOT predict ---------------------------
// `network.port` is a user setting, and on a first launch there is no sidecar to
// read it from — so the port startStudio probes is only a guess. The wait must
// follow the studio's own announcement, not the guess. Here the guess is a
// closed port and the studio comes up somewhere else entirely.
{
  const ws = freshWorkspace();
  const actualPort = await freePort();
  const predictedPort = await freePort(); // closed, and NOT where the studio lands
  writeFileSync(join(ws, ".fake-uv-port"), String(actualPort));

  const r = await startStudio(ws, { port: predictedPort, timeout: 10_000 });
  spawned.push(JSON.parse(readFileSync(join(ws, ".haywire", "studio.json"), "utf8")).pid);

  assert(r.status === "started", `studio on an unpredicted port -> started, got ${r.status}`);
  assert(
    r.url === `http://127.0.0.1:${actualPort}`,
    `url follows the sidecar to :${actualPort}, got ${r.url}`,
  );
}

// --- a STALE sidecar must not satisfy the wait -------------------------------
// The file a dead studio left behind is not evidence. Its port is even held
// open here, so accepting it would return a plausible-looking wrong answer.
{
  const ws = freshWorkspace();
  mkdirSync(join(ws, ".haywire"), { recursive: true });
  const decoy = createServer();
  const decoyPort: number = await new Promise((resolve) => {
    decoy.listen(0, () => {
      const addr = decoy.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });
  writeFileSync(
    join(ws, ".haywire", "studio.json"),
    JSON.stringify({
      pid: 999999, // dead
      port: decoyPort, // ...but this port IS open
      project: "old-run",
      project_path: ws,
      started_at: 1,
      url: `http://127.0.0.1:${decoyPort}`,
    }),
  );

  const actualPort = await freePort();
  const predictedPort = await freePort();
  writeFileSync(join(ws, ".fake-uv-port"), String(actualPort));

  const r = await startStudio(ws, { port: predictedPort, timeout: 10_000 });
  spawned.push(JSON.parse(readFileSync(join(ws, ".haywire", "studio.json"), "utf8")).pid);

  assert(
    r.url === `http://127.0.0.1:${actualPort}`,
    `waited for the NEW sidecar, not the stale one (:${decoyPort}), got ${r.url}`,
  );
  await new Promise((res) => decoy.close(res));
}

// --- child dies on startup: fail fast, carrying the log tail ------------------
// The tail is also the payoff for the /dev/null fix — the diagnostic only
// exists if the log file was really opened.
{
  const ws = freshWorkspace(); // no .fake-uv-port -> stub exits 3 immediately
  const port = await freePort();

  const t0 = Date.now();
  let threw = "";
  try {
    await startStudio(ws, { port, timeout: 15_000 });
  } catch (e) {
    threw = (e as Error).message;
  }
  const elapsed = Date.now() - t0;

  assert(threw.includes("exited with code 3"), `dead child -> reports the exit code, got "${threw}"`);
  assert(threw.includes("FAKE_UV_CRASHED"), "error surfaces the child's own log tail");
  assert(elapsed < 5_000, `failed fast rather than burning the 15s timeout, took ${elapsed}ms`);
}

for (const pid of spawned) {
  try {
    process.kill(pid);
  } catch {
    /* already gone */
  }
}

console.error(
  failures === 0
    ? "[studioctl.launch.test] studioctl launch checks passed"
    : `[studioctl.launch.test] ${failures} FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
