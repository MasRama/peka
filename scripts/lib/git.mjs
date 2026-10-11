import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

function git(home, args) {
  return execFileSync("git", args, { cwd: home, stdio: ["ignore", "pipe", "pipe"] }).toString();
}

function hasIdentity(home) {
  try {
    return git(home, ["config", "user.email"]).trim() !== "";
  } catch {
    return false;
  }
}

// The PEKA repo is a private safety net: never sign, never run the user's commit hooks.
function commit(home, message) {
  const identity = hasIdentity(home) ? [] : ["-c", "user.name=PEKA", "-c", "user.email=peka@localhost"];
  git(home, [...identity, "-c", "commit.gpgsign=false", "commit", "--no-verify", "-q", "-m", message]);
}

function stageAndCommit(home, message) {
  git(home, ["add", "-A"]);
  try {
    git(home, ["diff", "--cached", "--quiet"]);
    return false;
  } catch {
    commit(home, message);
    return true;
  }
}

export function ensureRepo(home) {
  try {
    if (fs.existsSync(path.join(home, ".git"))) return true;
    fs.mkdirSync(home, { recursive: true });
    git(home, ["init", "-q"]);
    const ignore = path.join(home, ".gitignore");
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "state/\n");
    stageAndCommit(home, "peka: initialize");
    return true;
  } catch {
    return false;
  }
}

export function autoCommit(home, message) {
  try {
    if (!fs.existsSync(path.join(home, ".git"))) return false;
    return stageAndCommit(home, message);
  } catch {
    return false;
  }
}
