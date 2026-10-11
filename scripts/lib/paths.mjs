import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function expandHome(p) {
  const home = os.homedir();
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(home, p.slice(2));
  return p;
}

export function pekaHome(env = process.env) {
  const configured = env.PEKA_HOME?.trim();
  return configured ? path.resolve(expandHome(configured)) : path.join(os.homedir(), ".peka");
}

export function claudeHome(env = process.env) {
  const configured = env.CLAUDE_CONFIG_DIR?.trim();
  return configured ? path.resolve(expandHome(configured)) : path.join(os.homedir(), ".claude");
}

export function dirs(home) {
  const state = path.join(home, "state");
  return {
    home,
    memory: path.join(home, "memory"),
    skills: path.join(home, "skills"),
    archive: path.join(home, "archive", "skills"),
    state,
    sessions: path.join(state, "sessions"),
    digests: path.join(state, "digests"),
    log: path.join(state, "peka.log"),
  };
}

export function ensureDirs(d) {
  for (const dir of [d.memory, d.skills, d.archive, d.sessions, d.digests]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
