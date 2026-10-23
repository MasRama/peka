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

// One git call for the common dir (the main repository, also for worktrees), the checkout
// root, and the exclude file every checkout of the repository shares.
function gitPaths(cwd) {
  try {
    const out = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel", "--git-path", "info/exclude"],
      { cwd, stdio: ["ignore", "pipe", "ignore"], timeout: 2000 },
    );
    const [common, root, exclude] = out.toString().trim().split("\n");
    return common && root && exclude ? { common, root, exclude } : null;
  } catch {
    return null;
  }
}

// The repository a session works in: its project (the folder of the main repository, so
// worktrees resolve to it), the checkout root, and the exclude file. Outside git, and for home
// or the filesystem root, there is none, so folders like Downloads or /tmp never turn into a
// project.
export function repoOf(cwd, { home = os.homedir() } = {}) {
  if (typeof cwd !== "string" || !cwd) return null;
  const dir = path.resolve(cwd);
  if (!fs.existsSync(dir)) return null;
  if (dir === path.resolve(home) || dir === path.parse(dir).root) return null;
  const git = gitPaths(dir);
  if (!git) return null;
  const main = path.dirname(git.common);
  if (main === path.resolve(home) || main === path.parse(main).root) return null;
  const project = normalizeProject(path.basename(main));
  return project ? { project, root: git.root, exclude: git.exclude } : null;
}

export function projectOf(cwd, options) {
  return repoOf(cwd, options)?.project ?? null;
}
