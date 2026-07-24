# farmhand4claude Build Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the scaffolded `farmhand4claude` repo into a working Claude Code plugin: a hardened, tested MCP proxy; deterministic bootstrap scripts (`doctor`, `bootstrap`, studio-lifecycle with sidecar consumption); beginner onboarding skills; and the plugin/marketplace packaging that lets a user `/plugin install` it.

**Architecture:** Two surfaces. **Pre-studio** = beginner skills orchestrating deterministic scripts (Node/TS CLI, no MCP). **Post-studio** = the `farmhand` MCP proxy (`proxy/src/index.ts`, a proven prototype seed) forwarding to the studio's HTTP `/mcp` and re-emitting `list_changed`. The plugin manifest wires both into Claude Code; the proxy publishes to npm and the manifest runs it via `npx -y @going-haywire/farmhand4claude`.

**Tech Stack:** TypeScript on `@modelcontextprotocol/sdk@^1.29` (Node ≥18), a Node-based test harness (the prototype's `internals/proxy-prototype-harness.ts` is the seed), Claude Code plugin format.

## Global Constraints

Every task's requirements implicitly include this section.

- **SDK pin:** `@modelcontextprotocol/sdk@^1.29`. **v2 is beta — do NOT target it.**
- **stdio discipline:** the proxy MUST NOT write non-MCP data to stdout. **All logs → stderr.** A test must assert stdout carries only MCP frames.
- **Token:** read lazily from `<workspace>/.haywire/farmhand_token` at connect time (the file does not exist until the studio has run once). Pass via `StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: \`Bearer ${token}\` } } })`.
- **Proxy front:** low-level `Server` (NOT `McpServer`), dynamic tool list via `setRequestHandler` + `sendToolListChanged()`/`sendResourceListChanged()`.
- **MCP server name:** `"farmhand"` (tools appear as `farmhand_*`), NOT the package name.
- **Down-mode:** while the studio is unreachable, expose exactly one sentinel tool `farmhand_studio_status`; discovery by poll (~2s).
- **Mutation gating:** NONE at the proxy — Claude Code's native per-tool permission is the only gate. Do NOT add annotation filtering.
- **Never clobber:** the `doctor`/bootstrap scripts must never overwrite or "fix" an existing toolchain; they check and, on a miss, print an OS-specific copy-pasteable install hint.
- **Prerequisite floor:** Python **≥3.12**, `uv`, git. (Matches the haywire repo's `requires-python`.)
- **Bootstrap = wrapper, not reimplementation:** project creation is `uvx --from haywire-studio haywire init <name>`; library install is via the studio's `marketplace_*` MCP tools; teaching defers to server-served `farmhand://docs/canon/*`. Do NOT reimplement any of these.
- **Sidecar contract (consumer side):** the studio writes `<workspace>/.haywire/studio.json` (fields `pid`, `port`, `project`, `project_path`, `started_at`, `host`, `role`, `url`). The studio-lifecycle script READS it. The producer already landed in the haywire repo — do not duplicate it here.
- **Plugin-format caveat:** the Claude Code plugin/marketplace manifest shape moves fast. Before authoring `.claude-plugin/plugin.json` and `marketplace.json`, VERIFY the current field names against the official Claude Code plugin docs (use the claude-code-guide agent or fetch the docs). The scaffolded `plugin.json` is a placeholder, not authoritative.
- **Commit style:** one commit per green task; end every commit body with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

**Key reference files an implementer keeps open:**
- `proxy/src/index.ts` — the proven proxy seed (poll, lazy token, down-mode sentinel, list_changed forwarding, `onclose` reconnect all present but prototype-grade).
- `internals/proxy-prototype-harness.ts` — the proven end-to-end harness (down-mode → studio-up mid-session → list_changed → forwarded call). The real test suite grows from this.
- `CLAUDE.md` — the verified SDK/behavior facts; do not re-derive them.

---

## Stage 1 — Harden and test the proxy

### Task 1: Establish the proxy test harness as a real, runnable suite

**Files:**
- Create: `proxy/src/harness.test.ts` (from `internals/proxy-prototype-harness.ts`)
- Modify: `proxy/package.json` (real `test` script + `zod` devDep the harness's fake studio needs)
- Modify: `proxy/tsconfig.json` if needed so both `index.ts` and the harness compile

**Interfaces:**
- Consumes: `proxy/src/index.ts` (built to `dist/index.js`), spawned via `StdioClientTransport`.
- Produces: `npm test` (in `proxy/`) runs the harness and exits non-zero on any failed check. The harness spins a fake token-gated streamable-HTTP MCP studio, starts the proxy pointed at it via env (`FARMHAND_URL`, `FARMHAND_TOKEN_PATH`, `FARMHAND_POLL_MS`), and asserts: down-mode sentinel only → studio-up + token written → `list_changed` fires → real tools appear without reconnect → forwarded `callTool` returns the upstream result.

- [ ] **Step 1: Copy the proven harness into the compiled source tree**

Copy `internals/proxy-prototype-harness.ts` to `proxy/src/harness.test.ts`. It already contains the full end-to-end test (fake studio via `McpServer` + `StreamableHTTPServerTransport`, a temp workspace, token write, poll-wait loop, and four `check(...)` assertions). Read it first — it is the proven prototype and needs only wiring, not rewriting.

- [ ] **Step 2: Add the harness's dependency and a real test script**

In `proxy/package.json`, add `"zod": "^3.25.76"` to `devDependencies` (the harness's fake studio registers a tool with a `zod` input schema), and set:

```json
    "test": "npm run build && node dist/harness.test.js",
```

- [ ] **Step 3: Run it — verify it passes**

Run: `cd proxy && npm install && npm test`
Expected: the harness prints `ALL CHECKS PASSED` and exits 0. (This is the same flow proven in the prototype session; if a check fails, the proxy regressed in the move — fix `index.ts`, not the assertions.)

- [ ] **Step 4: Commit**

```bash
cd /Volumes/Ddrive/06_open_tracking_tool/haywire/farmhand4claude
git add proxy/src/harness.test.ts proxy/package.json proxy/tsconfig.json proxy/package-lock.json
git commit -m "test(proxy): runnable end-to-end harness (down-mode -> studio-up -> list_changed -> forwarded call)"
```

---

### Task 2: Harden the proxy — real version, resource round-trip test, reconnect test

**Files:**
- Modify: `proxy/src/index.ts` (version strings, minor robustness)
- Modify: `proxy/src/harness.test.ts` (add resource + reconnect assertions)

**Interfaces:**
- Consumes: Task 1's harness and the built proxy.
- Produces: the harness additionally asserts (a) a resource listed/read through the proxy returns the upstream content (closes the prototype's untested-resource gap), and (b) when the fake studio is killed, the proxy returns to down-mode (`onclose` path) and `list_changed` fires again.

- [ ] **Step 1: Add the failing resource + reconnect assertions to the harness**

In `proxy/src/harness.test.ts`, extend the fake studio to also register a resource (e.g. `farmhand://docs/canon/nodes` returning a known text), and after the "tools appeared" check add:

```typescript
// Resource round-trip through the proxy.
const resList = await client.listResources();
check(resList.resources.some((r) => r.uri === "farmhand://docs/canon/nodes"),
  "upstream resource is listed through the proxy");
const read = await client.readResource({ uri: "farmhand://docs/canon/nodes" });
const body = (read.contents?.[0] as { text?: string })?.text;
check(body === "NODE CANON BODY", "resource read is forwarded from upstream");

// Reconnect: kill the studio, proxy must return to down-mode.
studio.close();
let backToDown = false;
for (let i = 0; i < 20; i++) {
  await sleep(500);
  const now = await client.listTools();
  if (now.tools.length === 1 && now.tools[0]!.name === "farmhand_studio_status") {
    backToDown = true; break;
  }
}
check(backToDown, "proxy returns to down-mode after the studio dies");
```

(The fake studio must register the resource via `server.registerResource(...)` returning `{ contents: [{ uri, text: "NODE CANON BODY" }] }`. Verify the exact `registerResource` signature against the installed sdk@1.29 — see CLAUDE.md.)

- [ ] **Step 2: Run — verify the new checks fail or pass honestly**

Run: `cd proxy && npm test`
Expected: the resource checks pass if forwarding already works (the prototype forwarded resources but never asserted them); the reconnect check exercises the `onclose` path. If reconnect hangs, the `onclose` handler needs `void proxy.sendToolListChanged()` after clearing `upstream` — confirm it is present (it is in the seed at the `client.onclose` block).

- [ ] **Step 3: Replace prototype version strings with the real package version**

In `proxy/src/index.ts`, change `"0.0.0-proto"` (server + client `version`) to read the package version, or hardcode `"0.1.0"` to match `package.json`. Keep the server `name` as `"farmhand-mcp-server"` for the proxy's own identity BUT confirm the constant used for the tool-prefix / advertised name is `"farmhand"` per the Global Constraint (the tools come from upstream already prefixed, so this is only the proxy's self-name — leave upstream tool names untouched).

- [ ] **Step 4: Run the full harness, commit**

```bash
cd proxy && npm test
cd /Volumes/Ddrive/06_open_tracking_tool/haywire/farmhand4claude
git add proxy/src/index.ts proxy/src/harness.test.ts
git commit -m "feat(proxy): assert resource round-trip + reconnect-to-down-mode; real version strings"
```

---

## Stage 2 — Deterministic scripts (pre-studio surface)

### Task 3: `doctor` — prerequisite probe (Python≥3.12, uv, git)

**Files:**
- Create: `scripts/doctor.ts` (or `.mjs` — match the proxy's TS/Node setup)
- Create: `scripts/doctor.test.ts`
- Modify: root or `scripts/` build config so scripts compile/run

**Interfaces:**
- Produces: `doctor()` returns a structured report `{ python: {ok, version, hint}, uv: {ok, hint}, git: {ok, hint} }`. Never installs anything. On a miss, `hint` is an OS-specific copy-pasteable command (brew/apt/winget/official installer link). Exits 0 (report is data, not pass/fail — the skill decides).

- [ ] **Step 1: Write the failing test**

```typescript
// scripts/doctor.test.ts — probe returns structured facts; never mutates the system.
import { doctor } from "./doctor.js";

const report = await doctor();
// python: the check must parse "Python 3.12.x" and compare >= 3.12
console.assert(typeof report.python.ok === "boolean", "python.ok is boolean");
console.assert("hint" in report.python, "python carries a hint field");
console.assert(typeof report.uv.ok === "boolean", "uv.ok is boolean");
console.assert(typeof report.git.ok === "boolean", "git.ok is boolean");
// On a system missing a tool, the hint must be a non-empty string.
for (const key of ["python", "uv", "git"] as const) {
  if (!report[key].ok) console.assert(report[key].hint.length > 0, `${key} miss has a hint`);
}
console.log("doctor checks passed");
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd scripts && node --loader ... doctor.test.js` (adapt to the chosen TS runner — e.g. `tsx scripts/doctor.test.ts`)
Expected: FAIL — `doctor` not defined.

- [ ] **Step 3: Implement `doctor`**

Probe each tool by spawning it and parsing `--version`:
- Python: try `python3 --version` then `python --version`; parse `Python (\d+)\.(\d+)`; `ok = major==3 && minor>=12`. Miss hint per platform (macOS: `brew install python@3.12`; Debian/Ubuntu: `sudo apt install python3.12`; Windows: winget or python.org; unknown: the uv-managed-python note `uv python install 3.12`).
- uv: `uv --version`; `ok` on exit 0. Miss hint: the official `curl -LsSf https://astral.sh/uv/install.sh | sh` (macOS/Linux) / winget (Windows).
- git: `git --version`; `ok` on exit 0. Miss hint per platform.

Detect platform with `process.platform` (`darwin`/`linux`/`win32`). Never run an install command — only report the hint string.

- [ ] **Step 4: Run to verify it passes**

Run the test runner; expected: PASS on a dev machine that has all three (all `ok: true`).

- [ ] **Step 5: Commit**

```bash
git add scripts/doctor.ts scripts/doctor.test.ts
git commit -m "feat(scripts): doctor — prerequisite probe (python>=3.12/uv/git) with OS-specific hints, never clobbers"
```

---

### Task 4: `studioctl` — studio launch + sidecar-aware lifecycle (consumer side)

**Files:**
- Create: `scripts/studioctl.ts`
- Create: `scripts/studioctl.test.ts`

**Interfaces:**
- Consumes: reads `<workspace>/.haywire/studio.json` (sidecar) and `farmhand_token`; uses `lsof` (macOS/Linux) / `netstat -ano` (Windows) for port→PID; the haywire repo's studio identity contract.
- Produces:
  - `startStudio(workspace, { timeout })` — if `:8082` free → spawn `uv run haywire` DETACHED (`start_new_session`/`detached`), poll `:8082`, return `{ status: "started", url }`. If busy → resolve identity (below) and return a decision object the skill presents to the user.
  - `resolveStudio(workspace)` — returns `{ state: "mine" | "other" | "unknown" | "stale" | "free", identity?, port_owner_pid?, url? }` per the sidecar contract: read my workspace's `studio.json`; if its `pid` == `lsof` port-owner → `"mine"`; else `lsof` port→PID→that PID's cwd→that dir's `studio.json` → `"other"` (name the project); no file but port held → `"unknown"`; sidecar pid dead → `"stale"`.

- [ ] **Step 1: Write the failing tests** (use a fake studio process holding a port + a temp workspace with a written `studio.json`, mirroring the prototype's `TEST 3`/port tests)

```typescript
// scripts/studioctl.test.ts
import { resolveStudio } from "./studioctl.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// "mine": sidecar pid == the process actually holding the port (simulate with our own pid + a real listener)
// "stale": sidecar records a dead pid, port closed -> "stale"
const ws = mkdtempSync(join(tmpdir(), "fc-"));
mkdirSync(join(ws, ".haywire"), { recursive: true });
writeFileSync(join(ws, ".haywire", "studio.json"),
  JSON.stringify({ pid: 999999, port: 8082, project: "p", project_path: ws, url: "http://127.0.0.1:8082" }));
const r = await resolveStudio(ws);
console.assert(r.state === "stale", `dead-pid sidecar -> stale, got ${r.state}`);
console.log("studioctl resolve checks passed");
```

(Add a "mine" case that starts a real `net.createServer().listen(8082)` in-process, writes a sidecar with `pid: process.pid`, and asserts `state === "mine"`; close the server after. Add a "free" case: no sidecar, port closed → `"free"`.)

- [ ] **Step 2: Run to verify it fails**

Run the test runner; Expected: FAIL — `resolveStudio` not defined.

- [ ] **Step 3: Implement `resolveStudio` + `startStudio`**

`resolveStudio`: port-open check (connect to `:8082`); `read_identity` (parse `<ws>/.haywire/studio.json`, tolerate absent/garbage → null); `os.kill(pid, 0)`-style liveness (Node: `process.kill(pid, 0)` in try/catch); `lsof -nP -iTCP@127.0.0.1:8082 -sTCP:LISTEN -t` for the port owner PID; `lsof -a -p PID -d cwd -Fn` for that PID's cwd (macOS/Linux); on Windows use `netstat -ano | findstr :8082` then no cwd resolution (fall back to `"unknown"` if the sidecar doesn't match — documented limitation). Map to the five states.

`startStudio`: spawn `uv run haywire` with `{ detached: true, stdio: ["ignore", fd, fd] }`, `unref()`, poll `:8082` until `timeout`, return `{status,url}` or a timeout error with the log tail.

- [ ] **Step 4: Run to verify it passes**

Run the test runner; Expected: PASS (stale/mine/free states resolved).

- [ ] **Step 5: Commit**

```bash
git add scripts/studioctl.ts scripts/studioctl.test.ts
git commit -m "feat(scripts): studioctl — detached studio launch + sidecar-aware resolve (mine/other/unknown/stale/free)"
```

---

### Task 5: `bootstrap` — project scaffold wrapper

**Files:**
- Create: `scripts/bootstrap.ts`
- Create: `scripts/bootstrap.test.ts`

**Interfaces:**
- Produces: `bootstrap(parentDir, projectName)` runs `uvx --from haywire-studio haywire init <projectName>` in `parentDir` then `uv sync` in the created `<projectName>/`, returning the project path. Does NOT reimplement scaffolding; it is a thin wrapper with validation (name sanity, parent-dir writable, refuse if `<projectName>/` already exists).

- [ ] **Step 1: Write the failing test** (mock the child-process exec so the test does not actually run `uvx`; assert the exact command + cwd)

```typescript
// scripts/bootstrap.test.ts — assert the command shape, not a real network install.
import { buildInitCommand } from "./bootstrap.js";

const cmd = buildInitCommand("my-project");
console.assert(
  cmd.join(" ") === "uvx --from haywire-studio haywire init my-project",
  `init command shape, got: ${cmd.join(" ")}`,
);
console.log("bootstrap command-shape check passed");
```

- [ ] **Step 2: Run to verify it fails.** Expected: FAIL — `buildInitCommand` not defined.

- [ ] **Step 3: Implement** `buildInitCommand(name)` returning the argv array, plus `bootstrap(parentDir, name)` that validates (`name` matches `^[a-zA-Z0-9._-]+$`, `<parentDir>/<name>` does not exist, `parentDir` writable) then execs the init argv in `parentDir` and `uv sync` in the child. Surface stdout/stderr to the caller.

- [ ] **Step 4: Run to verify it passes.** Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/bootstrap.ts scripts/bootstrap.test.ts
git commit -m "feat(scripts): bootstrap — thin uvx haywire-init wrapper with validation"
```

---

## Stage 3 — Skills (beginner on-ramp)

### Task 6: The bootstrap orchestration skill

**Files:**
- Create: `skills/farmhand-getting-started/SKILL.md`

**Interfaces:**
- Consumes: `scripts/doctor`, `scripts/bootstrap`, `scripts/studioctl`; the proxy's `farmhand_studio_status` sentinel.
- Produces: a skill that, on "help me get started with Haywire", runs doctor → (guides prereq install on a miss, never clobbering) → shapes project name → bootstrap → studioctl start → confirms tools appeared via `farmhand_studio_status`. Defers all teaching depth to `farmhand://docs/canon/*`.

- [ ] **Step 1: Write `SKILL.md`** with YAML frontmatter (`name`, `description` with trigger phrases: "help me get started with Haywire", "set up haywire", "install haywire"), and a body that is a decision tree calling the three scripts in order, with the "never clobber / show the hint" rule for doctor misses, the CC-forced-folder note, and the studio-busy → ask-user branch (reuse/stop&start/cancel) driven by `studioctl resolve`.

- [ ] **Step 2: Validate frontmatter** — `description` is present and specific; body references only scripts that exist (Tasks 3–5). No code to test; review is the gate.

- [ ] **Step 3: Commit**

```bash
git add skills/farmhand-getting-started/
git commit -m "feat(skills): farmhand-getting-started onboarding orchestration skill"
```

### Task 7: The "first 15 minutes" on-ramp skill

**Files:**
- Create: `skills/farmhand-first-graph/SKILL.md`

**Interfaces:**
- Consumes: the live proxy tools (`farmhand_*`) and server-served resources (`farmhand://docs/canon/*`).
- Produces: a beginner skill for the first graph + reading errors, that DEFERS to canon resources for depth (does not restate framework mechanics), and installs a first library via the studio's `marketplace_*` tools.

- [ ] **Step 1: Write `SKILL.md`** — trigger phrases ("my first graph", "how do I add a node", "help me build something in haywire"); body walks: read `farmhand://docs/canon/nodes` for context → guide adding a node via the live tool → run → read errors via `farmhand_studio_get_errors` → point at canon for depth. Explicitly NO framework-mechanics restatement.

- [ ] **Step 2: Review** frontmatter + that it references only real tools/resources.

- [ ] **Step 3: Commit**

```bash
git add skills/farmhand-first-graph/
git commit -m "feat(skills): farmhand-first-graph on-ramp skill (defers to canon resources)"
```

---

## Stage 4 — Plugin packaging

### Task 8: Verify current plugin-format, author the real manifest + marketplace

**Files:**
- Modify: `.claude-plugin/plugin.json` (replace the placeholder)
- Create: `.claude-plugin/marketplace.json`

**Interfaces:**
- Produces: a valid Claude Code plugin manifest declaring the MCP server (`command: npx, args: [-y, @going-haywire/farmhand4claude]`) and the skills, plus a one-repo marketplace so `/plugin marketplace add going-haywire/farmhand4claude` → `/plugin install farmhand4claude` works.

- [ ] **Step 1: VERIFY the current plugin/marketplace manifest schema.** Before writing, fetch the official Claude Code plugin docs (or dispatch the claude-code-guide agent) to confirm the exact field names for: MCP-server declaration inside a plugin, the `skills` array/dir convention, and `marketplace.json` shape. The format moves fast; do not trust the scaffold placeholder or memory. Record the confirmed schema in the commit message.

- [ ] **Step 2: Author `plugin.json`** with the verified fields: `name`, `description`, `version`, `author`, the MCP server entry pointing at `npx -y @going-haywire/farmhand4claude`, and the skills declaration (per the confirmed dir convention — `skills/` holds `farmhand-getting-started/` and `farmhand-first-graph/`).

- [ ] **Step 3: Author `marketplace.json`** listing this repo's single plugin, per the verified marketplace schema.

- [ ] **Step 4: Validate** — if Claude Code offers a plugin-validate command, run it; otherwise verify the JSON parses and every referenced path (skills, proxy bin) exists.

- [ ] **Step 5: Commit**

```bash
git add .claude-plugin/
git commit -m "feat(plugin): real plugin.json + marketplace.json (schema verified against current CC docs)"
```

---

### Task 9: npm publish readiness (dry-run only — do not publish)

**Files:**
- Modify: `proxy/package.json` (verify `files`, `bin`, `prepublishOnly`)

**Interfaces:**
- Produces: `npm publish --dry-run` in `proxy/` succeeds and the tarball contains `dist/index.js` and nothing extraneous (no `src`, no `node_modules`). Actual publish is a human step, out of scope.

- [ ] **Step 1: Build, then dry-run**

Run: `cd proxy && npm run build && npm publish --dry-run`
Expected: the printed tarball contents include `dist/index.js` and `package.json` only (plus README/LICENSE if added); NO `src/`, NO `dist/harness.test.js` (exclude test output from the published `files` — ensure `files: ["dist"]` but the harness compiles to `dist/harness.test.js`; either move the harness build out of the published tsconfig or add an `.npmignore` for `dist/*.test.js`).

- [ ] **Step 2: Fix packaging so the harness is excluded from the published tarball** (add `dist/*.test.js` to `.npmignore`, or give the harness its own tsconfig that outputs elsewhere). Re-run the dry-run.

- [ ] **Step 3: Commit**

```bash
git add proxy/package.json proxy/.npmignore
git commit -m "chore(proxy): npm publish-readiness (dry-run clean; test harness excluded from tarball)"
```

---

## Self-Review

**Spec coverage (against the settled design, memory `project_farmhand_proxy_repo.md`):**
- Proxy hardened + tested (down-mode, list_changed, resources, reconnect) → Tasks 1–2. ✓
- `doctor` prereq probe, never-clobber → Task 3. ✓
- Studio launch DETACHED + sidecar consumer (mine/other/unknown/stale/free, ask-user) → Task 4. ✓
- Bootstrap = `haywire init` wrapper → Task 5. ✓
- Onboarding skill + first-graph skill (defers to canon) → Tasks 6–7. ✓
- Plugin manifest + marketplace, schema re-verified → Task 8. ✓
- npm publish readiness → Task 9. ✓
- Libraries via `marketplace_*` (Task 7), mutation via CC permission only (Global Constraint, no proxy filter), sharing → sharing is DEFERRED beyond this plan (project/library share is a later skill; noted, not built here — matches "phased, later" in the design).

**Placeholder scan:** every code step shows the command/assertion; the two genuinely-external-fact steps (Task 8 manifest schema, Task 4 Windows port→cwd) are marked "verify against current docs/OS" rather than guessed — deliberate, because both move independently of this repo and a guessed value would be worse than an explicit verify instruction.

**Type consistency:** `resolveStudio`/`startStudio` (Task 4), `doctor` report shape (Task 3), `buildInitCommand`/`bootstrap` (Task 5) are referenced consistently by the skills in Tasks 6–7.

**Out of scope (explicit):** actual npm publish; actual GitHub repo creation + remote push; the sharing skills (Q9 "later" rung); any change to the haywire repo (the sidecar producer already landed there).
