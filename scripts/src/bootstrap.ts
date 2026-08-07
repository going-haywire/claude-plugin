/**
 * bootstrap — thin wrapper around Haywire's own project scaffolder.
 *
 * Project creation is `uvx --from haywire-studio haywire init <name>` — we do
 * NOT reimplement scaffolding. bootstrap only validates inputs, runs that
 * command in the parent dir, then `uv sync` in the created project, and hands
 * the result back to the caller (the onboarding skill).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, accessSync, constants } from "node:fs";
import { join } from "node:path";

const run = promisify(execFile);

/** The argv for creating a project. Kept separate so it's trivially testable. */
export function buildInitCommand(name: string): string[] {
  return ["uvx", "--from", "haywire-studio", "haywire", "init", name];
}

/**
 * Validate a project name. Returns null if OK, else a human-readable reason.
 * Rejects anything that isn't a plain single-segment slug — no spaces, no
 * slashes, no `..` traversal.
 */
export function validateName(name: string): string | null {
  if (!name || name.length === 0) return "Project name is empty.";
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    return "Project name may only contain letters, digits, '.', '_' and '-' (no spaces or slashes).";
  }
  if (name === "." || name === "..") return "Project name cannot be '.' or '..'.";
  return null;
}

export interface BootstrapResult {
  /** Absolute path to the created project. */
  projectPath: string;
  initStdout: string;
  syncStdout: string;
}

/**
 * Scaffold `<parentDir>/<name>` via haywire init, then `uv sync` it.
 * Validates first: legal name, parent writable, target does not already exist.
 */
export async function bootstrap(parentDir: string, name: string): Promise<BootstrapResult> {
  const nameError = validateName(name);
  if (nameError) throw new Error(nameError);

  const projectPath = join(parentDir, name);
  if (existsSync(projectPath)) {
    throw new Error(`Refusing to overwrite existing path: ${projectPath}`);
  }
  try {
    accessSync(parentDir, constants.W_OK);
  } catch {
    throw new Error(`Parent directory is not writable: ${parentDir}`);
  }

  const [cmd, ...args] = buildInitCommand(name);
  const init = await run(cmd!, args, { cwd: parentDir, timeout: 300_000 });

  const sync = await run("uv", ["sync"], { cwd: projectPath, timeout: 300_000 });

  return {
    projectPath,
    initStdout: `${init.stdout}${init.stderr}`,
    syncStdout: `${sync.stdout}${sync.stderr}`,
  };
}

const USAGE = `usage: bootstrap <parentDir> <projectName>

Scaffold a new Haywire project: runs \`uvx --from haywire-studio haywire init
<projectName>\` in <parentDir>, then \`uv sync\` inside the created project.
Refuses to overwrite an existing path. Installs/modifies nothing else.

arguments:
  parentDir      Existing, writable directory the project is created under.
  projectName    Plain slug: letters, digits, '.', '_', '-' only (no spaces
                 or slashes, and not '.' or '..').

examples:
  bootstrap . my-project
  bootstrap /path/to/workspace my-project
  bootstrap --help`;

// CLI entrypoint: `node dist/bootstrap.js <parentDir> <name>`.
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);

  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    process.exit(0);
  }

  const [parentDir, name, ...rest] = argv;
  if (!parentDir || !name) {
    console.error("error: bootstrap requires <parentDir> and <projectName>");
    console.error(`help: ${USAGE.split("\n")[0]}`);
    process.exit(2);
  }
  if (rest.length > 0) {
    console.error(`error: unexpected argument(s): ${rest.join(" ")}`);
    console.error("help: usage: bootstrap <parentDir> <projectName> (--help for details)");
    process.exit(2);
  }

  const nameError = validateName(name);
  if (nameError) {
    console.error(`error: ${nameError}`);
    console.error("help: names may only contain letters, digits, '.', '_' and '-'");
    process.exit(2);
  }

  bootstrap(parentDir, name)
    .then((r) => {
      console.log(`Created ${r.projectPath}`);
      process.exit(0);
    })
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    });
}
