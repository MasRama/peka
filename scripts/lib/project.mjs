import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export function normalizeProject(name) {
  if (typeof name !== "string") return null;
  const cleaned = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return cleaned || null;
}

function gitCommonDir(cwd) {
  try {
    const out = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    });
    return out.toString().trim() || null;
  } catch {
    return null;
  }
}

// The project a session works in: the folder of its git repository (worktrees resolve to the
// main repository). Outside git, and for home or the filesystem root, there is no project, so
// folders like Downloads or /tmp never turn into one.
export function projectOf(cwd, { home = os.homedir() } = {}) {
  if (typeof cwd !== "string" || !cwd) return null;
  const dir = path.resolve(cwd);
  if (!fs.existsSync(dir)) return null;
  if (dir === path.resolve(home) || dir === path.parse(dir).root) return null;
  const common = gitCommonDir(dir);
  if (!common) return null;
  const root = path.dirname(common);
  if (root === path.resolve(home) || root === path.parse(root).root) return null;
  return normalizeProject(path.basename(root));
}
