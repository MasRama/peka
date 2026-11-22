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

export function isDevinRuntime(env = process.env) {
  if (!env) return false;
  return Boolean(
    env.DEVIN_PLUGIN_ROOT?.trim() ||
      env.DEVIN_PROJECT_DIR?.trim() ||
      /^devin_/i.test(env.AI_AGENT?.trim() ?? ""),
  );
}

export function devinHome(env = process.env) {
  const configured = env.DEVIN_CONFIG_DIR?.trim();
  if (configured) return path.resolve(expandHome(configured));
  if (process.platform === "win32") {
    const appData = env.APPDATA?.trim() || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "devin");
  }
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return path.join(xdg ? path.resolve(expandHome(xdg)) : path.join(os.homedir(), ".config"), "devin");
}

export function devinSessionsDb(env = process.env) {
  const configured = env.DEVIN_SESSIONS_DIR?.trim();
  if (configured) return path.join(path.resolve(expandHome(configured)), "sessions.db");
  if (process.platform === "win32") {
    const local = env.LOCALAPPDATA?.trim() || path.join(os.homedir(), "AppData", "Local");
    return path.join(local, "devin", "cli", "sessions.db");
  }
  const xdg = env.XDG_DATA_HOME?.trim();
  return path.join(xdg ? path.resolve(expandHome(xdg)) : path.join(os.homedir(), ".local", "share"), "devin", "cli", "sessions.db");
}

export function pluginRoot(env = process.env) {
  return env?.DEVIN_PLUGIN_ROOT?.trim() || env?.PLUGIN_ROOT?.trim() || env?.CLAUDE_PLUGIN_ROOT?.trim() || null;
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
