// doctor.test.ts — probe returns structured facts; never mutates the system.
import { doctor } from "./doctor.js";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.error("[doctor.test] PASS:", msg);
  else {
    failures++;
    console.error("[doctor.test] FAIL:", msg);
  }
}

const report = await doctor();

// python: the check must parse "Python 3.12.x" and compare >= 3.12
assert(typeof report.python.ok === "boolean", "python.ok is boolean");
assert("hint" in report.python, "python carries a hint field");
assert(typeof report.uv.ok === "boolean", "uv.ok is boolean");
assert(typeof report.git.ok === "boolean", "git.ok is boolean");

// On a system missing a tool, the hint must be a non-empty string.
for (const key of ["python", "uv", "git"] as const) {
  if (!report[key].ok) assert(report[key].hint.length > 0, `${key} miss has a hint`);
}

// --- flight-readiness: an old DEFAULT python must not mask a newer suffixed one.
// Shim a PATH where `python3` reports 3.10 but `python3.12` reports 3.12; doctor
// must pass and name the interpreter that satisfied the floor (not raise a flag).
if (process.platform !== "win32") {
  const bin = mkdtempSync(join(tmpdir(), "fc-pybin-"));
  const shim = (name: string, ver: string) => {
    const p = join(bin, name);
    writeFileSync(p, `#!/bin/sh\necho "Python ${ver}"\n`);
    chmodSync(p, 0o755);
  };
  shim("python3", "3.10.11"); // the old default
  shim("python3.12", "3.12.4"); // the newer, floor-eligible interpreter

  const prevPath = process.env.PATH;
  process.env.PATH = bin; // ONLY our shims are visible — nothing else on PATH
  try {
    const r = await doctor();
    assert(r.python.ok === true, "old default python3 does not mask a newer python3.12");
    assert(r.python.version === "3.12.4", `reports the qualifying version, got ${r.python.version}`);
    assert(r.python.interpreter === "python3.12", `names the interpreter, got ${r.python.interpreter}`);
    assert(r.python.hint === "", "no install hint when the box is flight-ready");
  } finally {
    process.env.PATH = prevPath;
  }

  // And the true-miss case: only an old python3 -> flag it, with a hint.
  const bin2 = mkdtempSync(join(tmpdir(), "fc-pybin2-"));
  const shim2 = (name: string, ver: string) => {
    const p = join(bin2, name);
    writeFileSync(p, `#!/bin/sh\necho "Python ${ver}"\n`);
    chmodSync(p, 0o755);
  };
  shim2("python3", "3.10.11");
  process.env.PATH = bin2;
  try {
    const r = await doctor();
    assert(r.python.ok === false, "only an old python -> not flight-ready");
    assert(r.python.version === "3.10.11", `miss still reports what was found, got ${r.python.version}`);
    assert(r.python.hint.length > 0, "true miss carries an install hint");
  } finally {
    process.env.PATH = prevPath;
  }
}

console.error(failures === 0 ? "[doctor.test] doctor checks passed" : `[doctor.test] ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
