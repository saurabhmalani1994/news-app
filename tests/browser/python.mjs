// P1: the Python interpreter the browser proofs build pages with, so no proof hard-codes
// a path on one machine. PYTHON wins when set. Otherwise the repo's own .venv, looked up
// in this checkout and then in the main checkout, because a git worktree has no .venv
// of its own. Otherwise python (Windows) or python3 on PATH.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

function mainCheckout() {
  try {
    const common = execFileSync("git", ["-C", ROOT, "rev-parse", "--git-common-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
    return dirname(resolve(ROOT, common));
  } catch {
    return ROOT;
  }
}

function venvPython() {
  for (const root of [ROOT, mainCheckout()]) {
    for (const rel of [".venv/Scripts/python.exe", ".venv/bin/python"]) {
      const candidate = join(root, rel);
      if (existsSync(candidate)) return candidate;
    }
  }
  return process.platform === "win32" ? "python" : "python3";
}

export const PYTHON = process.env.PYTHON || venvPython();
