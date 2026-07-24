/**
 * doctor — prerequisite probe for a Haywire studio.
 *
 * Reports whether Python (>=3.12), uv, and git are present. It NEVER installs
 * or modifies anything: on a miss it returns an OS-specific, copy-pasteable
 * install hint and lets the caller (the onboarding skill) decide what to do.
 *
 * The report is data, not a pass/fail gate — the process exits 0 either way.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Minimum Python the haywire repo requires (matches its `requires-python`). */
const PY_MIN = { major: 3, minor: 12 } as const;

export interface ToolCheck {
  ok: boolean;
  /** Parsed version string when we could read one (e.g. "3.12.4"). */
  version?: string;
  /** Copy-pasteable install hint, OS-specific. Empty when ok. */
  hint: string;
}

export interface DoctorReport {
  python: ToolCheck;
  uv: ToolCheck;
  git: ToolCheck;
}

type Platform = "darwin" | "linux" | "win32" | "other";

function platform(): Platform {
  const p = process.platform;
  if (p === "darwin" || p === "linux" || p === "win32") return p;
  return "other";
}

/** Spawn `cmd args...` and return stdout+stderr, or null if it can't run. */
async function tryRun(cmd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout, stderr } = await run(cmd, args, { timeout: 5000 });
    return `${stdout}${stderr}`;
  } catch {
    return null;
  }
}

function pythonHint(p: Platform): string {
  switch (p) {
    case "darwin":
      return "brew install python@3.12";
    case "linux":
      return "sudo apt install python3.12   # or your distro's equivalent";
    case "win32":
      return "winget install Python.Python.3.12   # or download from https://www.python.org/downloads/";
    default:
      // uv can manage a Python for you on any platform.
      return "uv python install 3.12   # or install Python 3.12+ from https://www.python.org/downloads/";
  }
}

function uvHint(p: Platform): string {
  if (p === "win32") {
    return 'powershell -c "irm https://astral.sh/uv/install.ps1 | iex"   # or: winget install astral-sh.uv';
  }
  // macOS + Linux + unknown: the official one-liner.
  return "curl -LsSf https://astral.sh/uv/install.sh | sh";
}

function gitHint(p: Platform): string {
  switch (p) {
    case "darwin":
      return "xcode-select --install   # or: brew install git";
    case "linux":
      return "sudo apt install git   # or your distro's equivalent";
    case "win32":
      return "winget install Git.Git   # or download from https://git-scm.com/download/win";
    default:
      return "Install git from https://git-scm.com/downloads";
  }
}

/** Parse the first "Python X.Y[.Z]" out of `python --version` output. */
function parsePython(out: string): { version: string; major: number; minor: number } | null {
  const m = out.match(/Python\s+(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = m[3] ?? "0";
  return { version: `${major}.${minor}.${patch}`, major, minor };
}

async function checkPython(p: Platform): Promise<ToolCheck> {
  // Prefer python3, fall back to python (Windows / some setups).
  for (const cmd of ["python3", "python"]) {
    const out = await tryRun(cmd, ["--version"]);
    if (out === null) continue;
    const parsed = parsePython(out);
    if (!parsed) continue;
    const ok =
      parsed.major > PY_MIN.major ||
      (parsed.major === PY_MIN.major && parsed.minor >= PY_MIN.minor);
    return {
      ok,
      version: parsed.version,
      hint: ok ? "" : pythonHint(p),
    };
  }
  return { ok: false, hint: pythonHint(p) };
}

async function checkVersioned(
  cmd: string,
  hint: string,
): Promise<ToolCheck> {
  const out = await tryRun(cmd, ["--version"]);
  if (out === null) return { ok: false, hint };
  const version = out.trim().split("\n")[0]?.trim();
  return { ok: true, version, hint: "" };
}

/** Probe the toolchain. Pure read: nothing is installed or modified. */
export async function doctor(): Promise<DoctorReport> {
  const p = platform();
  const [python, uv, git] = await Promise.all([
    checkPython(p),
    checkVersioned("uv", uvHint(p)),
    checkVersioned("git", gitHint(p)),
  ]);
  return { python, uv, git };
}

/** Render the report as human-readable text for the skill/CLI to show. */
export function formatReport(r: DoctorReport): string {
  const line = (label: string, c: ToolCheck): string => {
    if (c.ok) return `  ✓ ${label}${c.version ? ` (${c.version})` : ""}`;
    return `  ✗ ${label} — not found\n      install: ${c.hint}`;
  };
  return [
    "Haywire prerequisite check:",
    line("Python 3.12+", r.python),
    line("uv", r.uv),
    line("git", r.git),
  ].join("\n");
}

// CLI entrypoint: `node dist/doctor.js` prints the report to stdout, exits 0.
if (import.meta.url === `file://${process.argv[1]}`) {
  doctor().then((r) => {
    console.log(formatReport(r));
    process.exit(0);
  });
}
