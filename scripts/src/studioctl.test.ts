// studioctl.test.ts — resolve the five sidecar states without launching a studio.
import { resolveStudio } from "./studioctl.js";
import { writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.error("[studioctl.test] PASS:", msg);
  else {
    failures++;
    console.error("[studioctl.test] FAIL:", msg);
  }
}

function tempWorkspace(): string {
  const ws = mkdtempSync(join(tmpdir(), "fc-"));
  mkdirSync(join(ws, ".haywire"), { recursive: true });
  return ws;
}

function writeSidecar(ws: string, sidecar: Record<string, unknown>): void {
  writeFileSync(join(ws, ".haywire", "studio.json"), JSON.stringify(sidecar));
}

/** Bind an ephemeral loopback port and return it (the server holds it open). */
function listenEphemeral(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ port, close: () => srv.close() });
    });
  });
}

// --- "free": no sidecar, port closed -> free ---------------------------------
{
  const { port, close } = await listenEphemeral();
  close(); // free the port again so nothing is listening
  await new Promise((r) => setTimeout(r, 100));
  const ws = tempWorkspace(); // no studio.json written
  const r = await resolveStudio(ws, { port });
  assert(r.state === "free", `no sidecar + closed port -> free, got ${r.state}`);
}

// --- "stale": sidecar records a dead pid, port closed -> stale ---------------
{
  const { port, close } = await listenEphemeral();
  close();
  await new Promise((r) => setTimeout(r, 100));
  const ws = tempWorkspace();
  writeSidecar(ws, {
    pid: 999999, // a pid that (almost certainly) does not exist
    port,
    project: "p",
    project_path: ws,
    url: `http://127.0.0.1:${port}`,
  });
  const r = await resolveStudio(ws, { port });
  assert(r.state === "stale", `dead-pid sidecar + closed port -> stale, got ${r.state}`);
}

// --- "mine": sidecar pid == the process holding the port -> mine -------------
{
  const { port, close } = await listenEphemeral();
  const ws = tempWorkspace();
  writeSidecar(ws, {
    pid: process.pid, // WE hold the port (via the listener above)
    port,
    project: "p",
    project_path: ws,
    url: `http://127.0.0.1:${port}`,
  });
  const r = await resolveStudio(ws, { port });
  assert(r.state === "mine", `sidecar pid == port owner -> mine, got ${r.state}`);
  close();
}

console.error(
  failures === 0 ? "[studioctl.test] studioctl resolve checks passed" : `[studioctl.test] ${failures} FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
