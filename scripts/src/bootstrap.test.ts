// bootstrap.test.ts — assert the command shape, not a real network install.
import { buildInitCommand, validateName } from "./bootstrap.js";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.error("[bootstrap.test] PASS:", msg);
  else {
    failures++;
    console.error("[bootstrap.test] FAIL:", msg);
  }
}

const cmd = buildInitCommand("my-project");
assert(
  cmd.join(" ") === "uvx --from haywire-studio haywire init my-project",
  `init command shape, got: ${cmd.join(" ")}`,
);

// Name validation: accept sane names, reject path traversal / spaces / empties.
assert(validateName("my-project") === null, "valid name passes");
assert(validateName("my_project.v2") === null, "dots/underscores/digits pass");
assert(validateName("") !== null, "empty name is rejected");
assert(validateName("has space") !== null, "spaces are rejected");
assert(validateName("../escape") !== null, "path traversal is rejected");
assert(validateName("a/b") !== null, "slashes are rejected");

console.error(
  failures === 0 ? "[bootstrap.test] bootstrap checks passed" : `[bootstrap.test] ${failures} FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
