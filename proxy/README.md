# @going-haywire/farmhand4claude

The **Farmhand** MCP proxy — a stdio↔HTTP bridge that connects Claude Code (or
any MCP client) to a running [Haywire](https://github.com/going-haywire/haywire)
studio, so the studio's tools appear mid-session with no reconnect.

> This npm package is just the proxy binary. The full beginner experience —
> onboarding skills that take you from a bare machine to a running studio — ships
> as the **`farmhand4claude` Claude Code plugin**, which runs this proxy for you.
> See the [plugin repo](https://github.com/going-haywire/farmhand4claude).

## What it does

Claude Code spawns this over stdio at session start (it always starts, even when
no studio is running). Behind it, the proxy dials the Haywire studio's
streamable-HTTP `/mcp` endpoint:

- **Studio down** → exposes two sentinel tools: `farmhand_studio_status` and
  `farmhand_studio_connect` (see below).
- **Studio comes up mid-session** → the proxy forwards the studio's tools and
  resources and re-emits `list_changed`, so they appear with **no reconnect**.
- **Studio dies** → a liveness poll returns the proxy to down-mode and re-emits
  `list_changed` again.

Discovery only ever looks inside the current workspace (see below) and only
ever guesses one port, the compiled-in default. A studio running under a
**different** project on the same machine — or on a non-default port with no
sidecar to read it from — is outside all of that and needs the escape hatch:

- `farmhand_studio_status` tells you when this has happened: if something
  answered but rejected the request with 401, the report says so explicitly
  and names the port, rather than reporting it identically to "nothing
  running" — that would leave no way to tell "wrong port" apart from "right
  port, needs a token I don't have."
- `farmhand_studio_connect(port, token?)` points the proxy at that studio for
  the rest of the session. Nothing is written to disk — set `FARMHAND_URL`
  (and read the token yourself into the request) if you want it to persist
  across restarts instead.

All logs go to stderr; stdout carries only MCP frames.

## Usage (as a Claude Code plugin)

You normally don't run this directly — install the plugin and it runs the proxy:

```text
/plugin marketplace add going-haywire/farmhand4claude
/plugin install farmhand4claude@farmhand-marketplace
```

## Configuration (environment variables)

| Variable              | Default                        | Purpose                                                                    |
| --------------------- | ------------------------------ | -------------------------------------------------------------------------- |
| `FARMHAND_URL`        | *(discovered; see below)*      | The studio's streamable-HTTP MCP endpoint. Set only to override discovery. |
| `FARMHAND_TOKEN_PATH` | *(derived from the workspace)* | Explicit path to the bearer-token file.                                    |
| `HAYWIRE_WORKSPACE`   | —                              | Workspace root; token read from `<ws>/.haywire/farmhand_token`.            |
| `CLAUDE_PROJECT_DIR`  | *(set by Claude Code)*         | Fallback workspace root when the plugin runs it.                           |
| `FARMHAND_POLL_MS`    | `2000`                         | Studio discovery / liveness poll interval.                                 |

The endpoint is resolved at each connect attempt, not at startup — the studio
may not exist when the proxy launches. Precedence: `FARMHAND_URL` → the `url`
(or `port`) in the `.haywire/studio.json` sidecar the studio writes beside the
token → `http://127.0.0.1:8124/mcp`. That last value only mirrors the *default*
of the studio's `network.port` setting, which users can change; the sidecar is
the authority whenever it exists.

The bearer token is read **lazily** — the file does not exist until the studio
has run once.

## License

MIT
