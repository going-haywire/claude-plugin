/**
 * permissions — offer the farmhand tool-wildcard allow-rule.
 *
 * The studio's tools appear as 40+ distinct `farmhand_*` MCP tools; Claude
 * Code prompts per-tool on first use of each. This script adds ONE rule to a
 * Claude Code settings.json's `permissions.allow` that pre-approves the
 * whole server's tool surface:
 *
 *   mcp__plugin_haywire_farmhand__*
 *
 * That name is fixed, not detected: it's derived from this plugin's own
 * manifest (plugin name "haywire" + mcpServers key "farmhand"), which is the
 * advertised install path (see repo CLAUDE.md). It is stable for anyone who
 * installed via the marketplace, which is the only audience this script
 * targets.
 *
 * This is a standalone, explicitly-invoked convenience — NOT wired into the
 * default onboarding flow. The skill may OFFER to run it; it never runs
 * unasked. Merge is idempotent (a second run is a no-op) and additive: every
 * other key and every other allow-rule in the file is preserved byte-for-byte
 * where untouched. Scope defaults to the PROJECT file (this Haywire project
 * only) — global (~/.claude/settings.json, every project) requires an
 * explicit --global flag, since a wildcard-approval for one project's studio
 * tools should not silently apply to unrelated projects the user opens later.
 *
 * Caveat this script cannot paper over: the proxy does no read/mutate
 * distinction between the studio's tools, so this rule also pre-approves
 * mutating tools (graph edits, publishing). It trades per-tool review away
 * for convenience — the CLI and the skill must say so, not just do it.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
export const FARMHAND_WILDCARD_RULE = "mcp__plugin_haywire_farmhand__*";
/** Resolve the settings.json path for a scope, given the project directory. */
export function settingsPath(scope, projectDir) {
    return scope === "global"
        ? join(homedir(), ".claude", "settings.json")
        : join(projectDir, ".claude", "settings.json");
}
/**
 * Add `rule` to `settings.permissions.allow` if it isn't already there.
 * Pure and total: never throws, never mutates the input. Any existing shape
 * for keys other than `permissions.allow` is preserved as-is; `permissions`
 * and `allow` are created only if missing.
 */
export function mergeAllowRule(settings, rule) {
    const permissions = settings.permissions && typeof settings.permissions === "object"
        ? settings.permissions
        : {};
    const allow = Array.isArray(permissions.allow) ? permissions.allow : [];
    if (allow.includes(rule)) {
        return { settings, changed: false };
    }
    return {
        settings: {
            ...settings,
            permissions: { ...permissions, allow: [...allow, rule] },
        },
        changed: true,
    };
}
/** Read a settings.json file, or `{}` if it does not exist yet. */
function readSettings(path) {
    if (!existsSync(path))
        return {};
    const raw = readFileSync(path, "utf-8");
    if (raw.trim() === "")
        return {};
    return JSON.parse(raw);
}
/**
 * Add the farmhand wildcard rule to the settings file for `scope`, creating
 * the file (and its `.claude/` directory) if it doesn't exist yet. Refuses to
 * touch a file whose JSON doesn't parse — surfaces the parse error instead of
 * guessing, since this file may hold rules the user cares about.
 */
export function apply(scope, projectDir) {
    const path = settingsPath(scope, projectDir);
    let existing;
    try {
        existing = readSettings(path);
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`Refusing to modify ${path}: it exists but is not valid JSON (${msg})`);
    }
    const { settings, changed } = mergeAllowRule(existing, FARMHAND_WILDCARD_RULE);
    if (changed) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
    }
    return { path, changed };
}
const USAGE = `usage: permissions allow [--global] [projectDir]

Add ONE allow-rule to a Claude Code settings.json that pre-approves every
tool the farmhand MCP proxy exposes (mcp__plugin_haywire_farmhand__*),
instead of Claude Code prompting per-tool on first use of each. Idempotent —
safe to run more than once. Preserves everything else already in the file.

This also pre-approves the studio's MUTATING tools (graph edits, publishing,
etc.) since the proxy does not distinguish read from mutate — it trades away
per-tool review for convenience. Only run this if that tradeoff is wanted.

arguments:
  projectDir   Project directory (default: current directory). Ignored with
               --global.

options:
  --global     Write to ~/.claude/settings.json (every project) instead of
               <projectDir>/.claude/settings.json (this project only, the
               default).

examples:
  permissions allow
  permissions allow /path/to/my-project
  permissions allow --global
  permissions allow --help`;
// CLI entrypoint: `node dist/permissions.js allow [--global] [projectDir]`.
if (import.meta.url === `file://${process.argv[1]}`) {
    const argv = process.argv.slice(2);
    if (argv.includes("--help") || argv.includes("-h")) {
        console.log(USAGE);
        process.exit(0);
    }
    const [sub, ...rest] = argv;
    if (sub !== "allow") {
        console.error(`error: unknown subcommand ${JSON.stringify(sub ?? "")}`);
        console.error(`help: ${USAGE.split("\n")[0]}`);
        process.exit(2);
    }
    const isGlobal = rest.includes("--global");
    const positional = rest.filter((a) => a !== "--global");
    if (positional.length > 1) {
        console.error(`error: unexpected argument(s): ${positional.slice(1).join(" ")}`);
        process.exit(2);
    }
    const projectDir = positional[0] ?? process.cwd();
    try {
        const result = apply(isGlobal ? "global" : "local", projectDir);
        if (result.changed) {
            console.log(`Added ${FARMHAND_WILDCARD_RULE} to ${result.path}`);
        }
        else {
            console.log(`Already present in ${result.path} — nothing to do.`);
        }
        process.exit(0);
    }
    catch (e) {
        console.error(e instanceof Error ? e.message : e);
        process.exit(1);
    }
}
