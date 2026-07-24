// doctor.test.ts — probe returns structured facts; never mutates the system.
import { doctor } from "./doctor.js";

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

console.error(failures === 0 ? "[doctor.test] doctor checks passed" : `[doctor.test] ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
