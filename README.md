# farmhand4claude

[![CI](https://github.com/going-haywire/farmhand4claude/actions/workflows/ci.yml/badge.svg)](https://github.com/going-haywire/farmhand4claude/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@going-haywire/farmhand4claude.svg)](https://www.npmjs.com/package/@going-haywire/farmhand4claude)

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

The proxy is published on npm as
[`@going-haywire/farmhand4claude`](https://www.npmjs.com/package/@going-haywire/farmhand4claude);
the plugin (proxy + skills) installs via the marketplace. See
[`docs/plans/`](docs/plans/) for the build history.

## Development

The repo has two independent Node/TS packages, each with its own test suite:

```sh
cd proxy && npm install && npm test     # the MCP proxy + end-to-end harness
cd scripts && npm install && npm test   # doctor / studioctl / bootstrap
```

`npm run build` in either package runs `tsc`. The proxy bridges to the Haywire
studio's MCP endpoint (`http://127.0.0.1:8082/mcp`) — see the
[haywire repo](https://github.com/going-haywire/haywire). CI
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs both suites on
Node 20 & 22 for every push and PR.

## Releasing (maintainers)

The proxy publishes to npm automatically when you push a `v*` tag — the
[`publish.yml`](.github/workflows/publish.yml) workflow runs both test suites,
verifies the tag matches `proxy/package.json`'s version, then `npm publish`es.

### One-time setup (already done — recorded here so it can be redone)

The publish workflow needs an npm token stored as the repo secret `NPM_TOKEN`.
The npm account has 2FA, so the token **must** be allowed to bypass it:

1. On [npmjs.com](https://www.npmjs.com) → avatar → **Access Tokens** →
   **Generate New Token** → **Granular Access Token**.
2. Set:
   - ☑ **Bypass two-factor authentication** (required — without it CI's publish
     hangs waiting for an interactive 2FA prompt).
   - **Permissions: Read and write** (needed to publish).
   - **Packages and scopes:** scope it to **`@going-haywire`** (narrower than
     account-wide).
   - **Expiration:** pick a date; the token must be rotated when it expires.
3. Copy the token (npm shows it only once), then store it on the repo — the
   command prompts you to *paste* the token (keeps it out of shell history):

   ```sh
   gh secret set NPM_TOKEN --repo going-haywire/farmhand4claude
   ```

   Verify with `gh secret list --repo going-haywire/farmhand4claude` (shows the
   name + timestamp; the value is write-only and can't be read back).

### Cutting a release

```sh
# 1. Bump the version in proxy/package.json (e.g. 0.1.0 -> 0.1.1).
# 2. Commit it on main and push.
# 3. Tag with the SAME version, prefixed 'v', and push the tag:
git tag v0.1.1
git push origin v0.1.1
```

The tag push triggers `publish.yml`. Watch it with
`gh run watch` (or the Actions tab). The tag-vs-package version check will fail
the release if step 1 and step 3 disagree, so bump before you tag.

> **Manual publish** (if ever needed): `cd proxy && npm publish`. With 2FA on,
> npm opens a browser auth step — you must complete it, or the upload silently
> does not happen (the tarball notice prints but nothing lands on the registry).

## License

MIT
