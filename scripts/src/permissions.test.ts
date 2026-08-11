// permissions.test.ts — merge purity, idempotency, scope paths, and real file I/O.
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FARMHAND_WILDCARD_RULE, mergeAllowRule, settingsPath, apply } from "./permissions.js";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.error("[permissions.test] PASS:", msg);
  else {
    failures++;
    console.error("[permissions.test] FAIL:", msg);
  }
}

// --- mergeAllowRule: pure merge behavior ---

{
  const { settings, changed } = mergeAllowRule({}, FARMHAND_WILDCARD_RULE);
  assert(changed === true, "empty settings: rule is added");
  assert(
    JSON.stringify((settings as any).permissions.allow) === JSON.stringify([FARMHAND_WILDCARD_RULE]),
    "empty settings: allow list contains exactly the rule",
  );
}

{
  const before = { permissions: { allow: [FARMHAND_WILDCARD_RULE] } };
  const { settings, changed } = mergeAllowRule(before, FARMHAND_WILDCARD_RULE);
  assert(changed === false, "already present: no-op reported");
  assert(settings === before, "already present: same object returned, not a copy");
}

{
  const before = {
    permissions: { allow: ["Bash(git diff *)", "mcp__farmhand__haystack_list_graphs"] },
    otherTopLevelKey: { nested: true },
  };
  const { settings } = mergeAllowRule(before, FARMHAND_WILDCARD_RULE);
  const s = settings as any;
  assert(s.permissions.allow.includes("Bash(git diff *)"), "existing allow rule 1 preserved");
  assert(
    s.permissions.allow.includes("mcp__farmhand__haystack_list_graphs"),
    "existing allow rule 2 preserved",
  );
  assert(s.permissions.allow.includes(FARMHAND_WILDCARD_RULE), "new rule appended");
  assert(s.otherTopLevelKey.nested === true, "unrelated top-level key preserved");
  assert(before.permissions.allow.length === 2, "original input array not mutated");
}

{
  // permissions present but no `allow` key yet (e.g. only `deny` set).
  const before = { permissions: { deny: ["NotebookEdit"] } };
  const { settings } = mergeAllowRule(before, FARMHAND_WILDCARD_RULE);
  const s = settings as any;
  assert(s.permissions.deny[0] === "NotebookEdit", "existing deny list preserved");
  assert(s.permissions.allow[0] === FARMHAND_WILDCARD_RULE, "allow list created alongside deny");
}

// --- settingsPath: scope resolution ---

{
  const local = settingsPath("local", "/some/project");
  assert(local === join("/some/project", ".claude", "settings.json"), `local scope path, got: ${local}`);
  const global = settingsPath("global", "/some/project");
  assert(global.endsWith(join(".claude", "settings.json")), `global scope path ends correctly, got: ${global}`);
  assert(!global.startsWith("/some/project"), "global scope path ignores projectDir");
}

// --- apply: real file I/O against a tmp dir ---

const tmp = mkdtempSync(join(tmpdir(), "haywire-permissions-test-"));

// Fresh project, no .claude/ dir yet: apply must create it.
{
  const projectDir = join(tmp, "fresh-project");
  const result = apply("local", projectDir);
  assert(result.changed === true, "fresh project: reports changed");
  const written = JSON.parse(readFileSync(result.path, "utf-8"));
  assert(written.permissions.allow.includes(FARMHAND_WILDCARD_RULE), "fresh project: file written with rule");
}

// Second run against the same project: idempotent no-op.
{
  const projectDir = join(tmp, "fresh-project");
  const result = apply("local", projectDir);
  assert(result.changed === false, "second run: reports unchanged");
}

// Existing settings.json with unrelated content: merged, not clobbered.
{
  const projectDir = join(tmp, "existing-project");
  mkdirSync(join(projectDir, ".claude"), { recursive: true });
  const existingPath = join(projectDir, ".claude", "settings.json");
  writeFileSync(
    existingPath,
    JSON.stringify({ permissions: { allow: ["Bash(gh issue *)"] }, enableAllProjectMcpServers: true }),
  );
  const result = apply("local", projectDir);
  const written = JSON.parse(readFileSync(existingPath, "utf-8"));
  assert(written.permissions.allow.includes("Bash(gh issue *)"), "existing rule preserved on disk");
  assert(written.permissions.allow.includes(FARMHAND_WILDCARD_RULE), "new rule added on disk");
  assert(written.enableAllProjectMcpServers === true, "unrelated top-level key preserved on disk");
  assert(result.changed === true, "existing file: reports changed");
}

// Malformed JSON: refuse rather than guess/clobber.
{
  const projectDir = join(tmp, "broken-project");
  mkdirSync(join(projectDir, ".claude"), { recursive: true });
  writeFileSync(join(projectDir, ".claude", "settings.json"), "{ not valid json");
  let threw = false;
  try {
    apply("local", projectDir);
  } catch {
    threw = true;
  }
  assert(threw, "malformed existing settings.json: apply refuses instead of clobbering");
}

rmSync(tmp, { recursive: true, force: true });

console.error(
  failures === 0 ? "[permissions.test] permissions checks passed" : `[permissions.test] ${failures} FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
