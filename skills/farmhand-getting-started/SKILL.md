---
name: farmhand-getting-started
description: >
  Onboards a beginner from a bare machine to a running Haywire studio. Use this
  skill whenever the user says "help me get started with Haywire", "set up
  haywire", "install haywire", "I want to try haywire", or otherwise asks to go
  from nothing to a working Haywire studio. It runs the prerequisite check
  (Python 3.12+/uv/git), scaffolds a project, launches the studio detached, and
  confirms the studio's tools appeared in this session. It NEVER installs or
  overwrites a toolchain — on a missing prerequisite it shows the exact install
  command and waits for the user. Defers all framework teaching to the studio's
  served canon resources.
---

# Getting started with Haywire

Your job: walk a non-terminal user from a cold machine to a running Haywire
studio whose tools are live in this Claude Code session. You orchestrate three
deterministic scripts. **You never install or overwrite anything** — on a
prerequisite miss you show the copy-pasteable hint and wait.

The scripts live in the plugin's `scripts/` package (built to `scripts/dist/`).
Run them with `node`. All three print structured/JSON output to stdout.

## The path (do these in order)

### 1. Check prerequisites — `doctor`

Run:

```
node <plugin>/scripts/dist/doctor.js
```

This probes Python (≥3.12), `uv`, and git. It reports; it does not fix.

- **All three OK** → continue to step 2.
- **Any miss** → show the user the exact `install:` hint the report gives for
  that tool (it is OS-specific and copy-pasteable). Explain what the tool is in
  one line. **Do NOT run the install command yourself and do NOT try to "fix"
  their toolchain** — the user runs it, then you re-run `doctor` to confirm.
  Only proceed once all three are OK.

Never clobber: if a tool is present but old (e.g. Python 3.11), still just show
the hint — do not attempt to upgrade or replace what's there.

### 2. Choose a project name + scaffold — `bootstrap`

Claude Code is already anchored to a working folder (the one the user opened).
That folder is the **parent** for the new project.

Ask the user for a short project name. It must be a plain slug (letters, digits,
`.`, `_`, `-` — no spaces or slashes). If they give something else, suggest a
sanitized version and confirm.

Then run:

```
node <plugin>/scripts/dist/bootstrap.js <parentDir> <projectName>
```

This runs `uvx --from haywire-studio haywire init <name>` then `uv sync`. It
refuses to overwrite an existing `<projectName>/`. If it errors that the path
exists, offer a different name — never delete their folder.

### 3. Launch the studio — `studioctl`

First resolve the port situation:

```
node <plugin>/scripts/dist/studioctl.js resolve <projectPath>
```

Read the `state`:

- **`free`** or **`stale`** → safe to start. Run
  `node <plugin>/scripts/dist/studioctl.js start <projectPath>`. This launches
  `uv run haywire` **detached** (it keeps running after this session) and polls
  until the studio answers, returning the URL.
- **`mine`** → a studio for THIS project is already up. Reuse it — do not start
  a second one. Tell the user it's already running.
- **`other`** → the port is held by a **different** project (the result names it
  via `other_identity.project`). Present three choices and let the USER decide:
  **[Open that project]** (switch to it), **[Stop it & start yours]** (only if
  they confirm — stopping another project's studio is their call, not yours), or
  **[Cancel]**. Never stop another project's studio without explicit consent.
- **`unknown`** → the port is busy but not attributable to a Haywire project.
  Tell the user something else is on port 8082 and let them decide (free the
  port, or cancel).

### 4. Confirm the tools appeared

The `farmhand` MCP proxy polls the studio (~2s) and surfaces its tools
mid-session with no reconnect. After a successful start, the studio's tools
appear as `farmhand_*`. Confirm by calling **`farmhand_studio_status`** (the
always-available sentinel) — it reports whether the studio is reachable and how
many tools are live.

- Sentinel says up → tell the user the studio is running (share the URL so they
  can open it in a browser) and hand off to the first-graph on-ramp.
- Sentinel still down after a start returned success → the proxy may not have
  polled yet; wait a couple seconds and re-check. If it stays down, show the
  `studio.log` tail from `<projectPath>/.haywire/studio.log`.

## Teaching depth is not your job

Do NOT explain how Haywire graphs/nodes/framework internals work here. The
studio serves that as canon resources (`farmhand://docs/canon/*`). Once the
studio is up, defer to the **farmhand-first-graph** skill and the canon
resources for anything conceptual.
