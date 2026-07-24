---
name: farmhand-first-graph
description: >
  A beginner's first 15 minutes inside a running Haywire studio. Use this skill
  when the user says "my first graph", "how do I add a node", "help me build
  something in haywire", "install a haywire library", or asks for guided help
  building/running a graph once the studio is up. It reads the studio's served
  canon for context, guides the user through adding and running a node via the
  live farmhand_* tools, reads errors back, and installs a first library via the
  studio's marketplace tools. It DEFERS all framework mechanics to the canon
  resources — it does not restate how the framework works.
---

# Your first graph in Haywire

The studio is running and its tools are live in this session as `farmhand_*`.
Your job is to guide a beginner through their first graph — adding a node,
running it, reading what happened — and to install their first library. You are
a guide, **not a textbook**: for anything conceptual, you read and point at the
studio's canon resources instead of explaining the framework yourself.

## Prerequisite: the studio must be up

If `farmhand_studio_status` reports the studio is down, stop and hand back to
**farmhand-getting-started** — there are no `farmhand_*` graph tools until the
studio is running.

## Discover the real tools first

The studio advertises its own `farmhand_*` tools; the exact names come from the
running studio, not from this skill. **List the available `farmhand_*` tools and
read their descriptions** before acting — pick the tool whose description
matches the step (add a node, run the graph, read errors, browse/install a
library). Do not assume a tool name that isn't in the live list.

## Read the canon for context (don't restate it)

The studio serves its documentation as resources under `farmhand://docs/canon/*`.
Before guiding the user on nodes, **read `farmhand://docs/canon/nodes`** (via the
resource-read path) and ground your guidance in it. When the user asks "how does
X work?", read the relevant canon resource and point them at it — do NOT
paraphrase framework mechanics from memory.

## The walk

1. **Context.** Read `farmhand://docs/canon/nodes`. Summarize in one or two
   sentences only what the user needs to take the next action; link them to the
   canon for depth.
2. **Add a node.** Use the live `farmhand_*` tool whose description covers adding
   a node to the graph. Confirm the user's intent (which node, where) before
   mutating — the mutation itself is gated by Claude Code's normal per-tool
   permission prompt, so let that prompt be the confirmation point.
3. **Run it.** Use the live tool that runs/evaluates the graph.
4. **Read errors.** Use the live `farmhand_*` tool that reports studio/graph
   errors. Read the error back to the user in plain language, then point at the
   relevant canon resource for the fix rather than guessing.
5. **Install a first library.** Use the studio's `marketplace_*` tools (list,
   then install) to add a library. Do NOT hand-edit dependency files or run a
   package manager yourself — the marketplace tools are the supported path.

## Boundaries

- **No framework-mechanics restatement.** Depth lives in `farmhand://docs/canon/*`.
  Read it, cite it, defer to it.
- **Mutations go through the live tools**, gated by Claude Code's own per-tool
  permission. There is no extra gate in the proxy and you should not add ceremony.
- **Libraries via `marketplace_*` only.** Never reimplement install by editing
  `pyproject.toml` or invoking `uv`/`pip` directly.
- Sharing a project/library is a later step, not part of this on-ramp.
