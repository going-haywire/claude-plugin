# farmhand4claude

**Your AI guide to [Haywire](https://github.com/going-haywire/haywire).** Install this plugin in
Claude Code and it walks you from a bare machine to a running Haywire studio — checking your setup,
scaffolding a project, launching the studio — then keeps helping you inside the running app. No
terminal experience required.

> **Farmhand** is Haywire's name for its AI helper. `farmhand4claude` is the Claude Code plugin half
> of it: an onboarding guide plus a bridge that surfaces the studio's tools directly in Claude Code.

## Who this is for

You want to try Haywire but you're not comfortable living in a terminal. This plugin does the
console work for you and explains each decision.

*(Already fluent with the terminal? The [Haywire README](https://github.com/going-haywire/haywire)'s
manual `uvx … haywire init` path is for you — you don't need this plugin.)*

## Getting started (no terminal needed)

1. **Install the Claude Code desktop app**
   ([macOS](https://claude.ai/api/desktop/darwin/universal/dmg/latest/redirect) ·
   [Windows](https://claude.ai/api/desktop/win32/x64/setup/latest/redirect)), sign in, and open the
   **Code** tab.
2. When it asks, choose **Local** and **select a folder** — create an empty folder called
   `haywire-projects` and pick it. (Claude Code needs a working folder to start.)
3. Install this plugin: `/plugin install farmhand4claude` *(marketplace instructions coming soon).*
4. Say **"help me get started with Haywire"** — and follow along.

Behind the scenes the plugin checks you have Python 3.12+, `uv`, and git (offering exact install
steps if not), scaffolds your project, launches the studio in your browser, and connects so its
tools are available to your assistant — all in one session.

## What's in the box

- **The `farmhand` proxy** — a small MCP server that bridges Claude Code to your running studio, so
  studio tools appear the moment the studio is up (no reconnect). Portable to any MCP client, but the
  guided experience is Claude-Code-only.
- **Onboarding skills** — the "first 15 minutes": your first graph, reading errors, installing a
  library, sharing your project.

## Status

**Early scaffold.** The proxy is a proven prototype; the plugin packaging, scripts, and skills are
under construction — see [`docs/plans/`](docs/plans/).

## Development

```sh
cd proxy
npm install
npm run build        # tsc -> dist/index.js  (the MCP proxy binary)
```

Requires the Haywire studio's MCP endpoint (`http://127.0.0.1:8082/mcp`) to bridge to — see the
[haywire repo](https://github.com/going-haywire/haywire).

## License

MIT
