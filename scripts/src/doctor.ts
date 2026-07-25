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
  /**
   * For Python: the interpreter command that satisfied the floor (e.g.
   * "python3.12"). May differ from the default `python3` when a newer
   * interpreter is installed under a version-suffixed name. Absent for
   * uv/git.
   */
  interpreter?: string;
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

/** Does a parsed version meet the floor? */
function meetsFloor(v: { major: number; minor: number }): boolean {
  return v.major > PY_MIN.major || (v.major === PY_MIN.major && v.minor >= PY_MIN.minor);
}

/**
 * Interpreter commands to probe, newest floor-eligible suffix first, then the
 * generic names. The default `python3`/`python` may point at an OLDER Python
 * even when a newer one is installed under a version-suffixed name (common with
 * Homebrew's python@3.12/@3.13/…), so we look for a qualifying interpreter
 * anywhere before deciding the box needs action.
 */
function pythonCandidates(): string[] {
  const suffixed: string[] = [];
  // A generous ceiling so future minors are found without another edit.
  for (let minor = 20; minor >= PY_MIN.minor; minor--) suffixed.push(`python${PY_MIN.major}.${minor}`);
  return [...suffixed, "python3", "python"];
}

async function checkPython(p: Platform): Promise<ToolCheck> {
  // Track the newest interpreter we saw, so a miss can report what IS there.
  let best: { version: string; interpreter: string } | null = null;

  for (const cmd of pythonCandidates()) {
    const out = await tryRun(cmd, ["--version"]);
    if (out === null) continue;
    const parsed = parsePython(out);
    if (!parsed) continue;

    if (meetsFloor(parsed)) {
      // First qualifying interpreter wins — the box is flight-ready. Silent pass.
      return { ok: true, version: parsed.version, interpreter: cmd, hint: "" };
    }
    if (!best) best = { version: parsed.version, interpreter: cmd };
  }

  // Nothing installed meets the floor — this is a real, user-actionable miss.
  return { ok: false, version: best?.version, hint: pythonHint(p) };
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
    if (c.ok) {
      const via =
        c.interpreter && c.interpreter !== "python3" && c.interpreter !== "python"
          ? ` via ${c.interpreter}`
          : "";
      return `  ✓ ${label}${c.version ? ` (${c.version}${via})` : ""}`;
    }
    const found = c.version ? ` (found ${c.version})` : "";
    return `  ✗ ${label} — not found${found}\n      install: ${c.hint}`;
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
