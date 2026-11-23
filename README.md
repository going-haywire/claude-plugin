# claude-plugin (retired)

This repository held the `haywire` Claude Code plugin (onboarding skills) and the
`@going-haywire/farmhand-proxy` npm package. Both are retired; the repository is archived.

- **Setting up Haywire with an agent:** tell your agent (Claude Code, Codex, Cursor, …):
  *Set me up for Haywire: read
  <https://raw.githubusercontent.com/going-haywire/haywire/master/docs/agents/start.md> and follow it.*
- **The studio's tools in an agent session** come from the Farmhand bridge,
  `haywire farmhand bridge`, which every Haywire project starts from its own environment through its
  committed `.mcp.json` (going-haywire/haywire, ADR 0093).

If you installed the plugin, remove it: `claude plugin uninstall haywire@haywire-marketplace`, then
`claude plugin marketplace remove haywire-marketplace`.
