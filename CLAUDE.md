# farmhand4claude

**Farmhand** is Haywire's umbrella term for the AI harness that helps and supports a user with
Haywire. This repo is the **Claude-Code-only** slice of it: a plugin that is a beginner's on-ramp
from a cold machine to a running Haywire studio, plus the always-on MCP proxy that makes studio
tools appear in Claude Code.

## What this repo is (and is NOT)

- **IS:** the `farmhand4claude` Claude Code plugin — an MCP **proxy** (stdio↔HTTP bridge) + beginner
  **onboarding skills** + deterministic **scripts** (`doctor`, `bootstrap`, studio launch/lifecycle).
- **IS NOT:** the Haywire framework, the in-studio Farmhand **server**, or the `@farmhand` tools.
  Those live in the `haywire` repo (sibling: `../haywire-repo`). This repo only *talks to* a running
  studio's `/mcp` endpoint.
- The "4claude" scopes the **plugin**, not the concept "Farmhand." Skills are CC-specific → the plugin
  is CC-only. The proxy alone is portable to any MCP harness but that is NOT the advertised path.

## Architecture (two surfaces)

1. **Pre-studio** (no MCP yet): beginner **skills** orchestrate deterministic **scripts** —
   `doctor` (probe Python≥3.12 / uv / git, never clobber), `bootstrap` (glorified
   `uvx --from haywire-studio haywire init <name>`), studio launch (detached, poll :8082).
2. **Post-studio:** the **`farmhand` MCP proxy** (`proxy/src/index.ts`) — a stdio MCP server Claude
   Code spawns at session start, forwarding to the studio's HTTP `/mcp` and re-emitting
   `list_changed` so tools appear mid-session with no reconnect.

## Key facts (verified against primary sources — do not re-derive)

- **SDK:** `@modelcontextprotocol/sdk@^1.29` (npm `latest`). **v2 is beta — do NOT target it.**
- **Client → studio:** `new Client(...)` + `StreamableHTTPClientTransport(url, { requestInit: {
  headers: { Authorization: \`Bearer ${token}\` } } })`. Read the token **lazily** from
  `<workspace>/.haywire/farmhand_token` — it does not exist until the studio has run once.
- **Proxy front:** low-level `Server` (NOT `McpServer`, because the tool list is dynamic):
  `setRequestHandler`, `sendToolListChanged()`, `sendResourceListChanged()`, `registerCapabilities()`.
- **List-changed forwarding:** the client subscribes with
  `setNotificationHandler(ToolListChangedNotificationSchema | ResourceListChangedNotificationSchema)`;
  the stdio Server re-emits downstream. This is the whole point of the proxy.
- **stdio discipline:** MUST NOT write non-MCP data to stdout → **all logs go to stderr.**
- **MCP server `name` = "farmhand"** (tools appear as `farmhand_*`), NOT the package name.
- Settled behavior: discovery = **poll** (~2s); while studio down = one `farmhand_studio_status`
  **sentinel** tool; mutation gated **solely** by Claude Code's native per-tool permission (no proxy
  filtering).

## Studio identity sidecar (the daemon-lifecycle contract)

The studio (haywire repo) writes `<workspace>/.haywire/studio.json` at startup — fields: `pid`, `port`,
`project`, `project_path`, `started_at`, `host`, `role`, `url`. **This repo is the CONSUMER:** the
studio-launch script reads it to decide, when `:8082` is busy, whether to reuse (pid == `lsof`
port-owner → return URL), or `lsof` port→PID→cwd→that project's sidecar to NAME a different project
and **ask the user** ([Open][Stop&start][Cancel]). Stale file + dead pid → clean up, start fresh.
The PRODUCER half already landed in the haywire repo (`farmhand/identity.py`).

## Layout

- `proxy/` — the TS MCP proxy (npm package `@going-haywire/farmhand4claude`). `src/index.ts` is the
  **proven prototype seed** (tested green vs sdk@1.29.0). Build: `cd proxy && npm install && npm run build`.
- `scripts/` — deterministic bootstrap/doctor/studio-lifecycle scripts (to build).
- `skills/` — beginner onboarding skills (to build).
- `.claude-plugin/` — plugin manifest + marketplace (to build).
- `internals/proxy-prototype-harness.ts` — the proven end-to-end test harness from the prototype
  session (down-mode → studio-up → list_changed → forwarded call). Reference for the real test suite.
- `docs/plans/` — implementation plans.

## Related

- Sibling repo `../haywire-repo` — the Haywire framework + Farmhand server + sidecar producer.
- Full settled design: the haywire repo's memory `project_farmhand_proxy_repo.md`.
