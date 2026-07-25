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

- **Studio down** → exposes a single sentinel tool, `farmhand_studio_status`.
- **Studio comes up mid-session** → the proxy forwards the studio's tools and
  resources and re-emits `list_changed`, so they appear with **no reconnect**.
- **Studio dies** → a liveness poll returns the proxy to down-mode and re-emits
  `list_changed` again.

All logs go to stderr; stdout carries only MCP frames.

## Usage (as a Claude Code plugin)

You normally don't run this directly — install the plugin and it runs the proxy:

```
/plugin marketplace add going-haywire/farmhand4claude
/plugin install farmhand4claude
```

## Configuration (environment variables)

| Variable              | Default                              | Purpose                                            |
| --------------------- | ------------------------------------ | -------------------------------------------------- |
| `FARMHAND_URL`        | `http://127.0.0.1:8082/mcp`          | The studio's streamable-HTTP MCP endpoint.         |
| `FARMHAND_TOKEN_PATH` | *(derived from the workspace)*       | Explicit path to the bearer-token file.            |
| `HAYWIRE_WORKSPACE`   | —                                    | Workspace root; token read from `<ws>/.haywire/farmhand_token`. |
| `CLAUDE_PROJECT_DIR`  | *(set by Claude Code)*               | Fallback workspace root when the plugin runs it.   |
| `FARMHAND_POLL_MS`    | `2000`                               | Studio discovery / liveness poll interval.         |

The bearer token is read **lazily** — the file does not exist until the studio
has run once.

## License

MIT
