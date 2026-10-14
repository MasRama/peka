import fs from "node:fs";
import path from "node:path";

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic(file, data, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

export function safeId(id) {
  const cleaned = String(id ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 128);
  return cleaned || "unknown";
}

const SESSION_DEFAULTS = { turnsSinceMemory: 0, toolsSinceSkill: 0, lastDigestLine: 0 };
const CURATOR_DEFAULTS = { lastRunAt: null, lastPromptAt: null, lastLifecycleAt: null };

function sessionFile(d, id) {
  return path.join(d.sessions, `${safeId(id)}.json`);
}

export function loadSession(d, id) {
  return { ...SESSION_DEFAULTS, ...readJson(sessionFile(d, id), {}) };
}

export function saveSession(d, id, session) {
  writeJsonAtomic(sessionFile(d, id), session);
}

export function loadUsage(d) {
  const usage = readJson(path.join(d.state, "usage.json"), {});
  return { skills: usage && typeof usage.skills === "object" && usage.skills ? usage.skills : {} };
}

export function saveUsage(d, usage) {
  writeJsonAtomic(path.join(d.state, "usage.json"), usage);
}

export function loadCurator(d) {
  return { ...CURATOR_DEFAULTS, ...readJson(path.join(d.state, "curator.json"), {}) };
}

export function saveCurator(d, curator) {
  writeJsonAtomic(path.join(d.state, "curator.json"), curator);
}

export function isSetUp(d) {
  return fs.existsSync(path.join(d.state, "setup.json"));
}

export function log(d, message) {
  try {
    fs.mkdirSync(path.dirname(d.log), { recursive: true });
    fs.appendFileSync(d.log, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Logging must never break a hook.
  }
}

export function localDate(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const MAX_ACTIVE_DAYS = 120;

export function loadProjects(d) {
  const data = readJson(path.join(d.state, "projects.json"), {});
  return data && typeof data === "object" && !Array.isArray(data) ? data : {};
}

export function saveProjects(d, projects) {
  writeJsonAtomic(path.join(d.state, "projects.json"), projects);
}

// Remember that `project` was worked on today; the lifecycle ages project skills by these days.
export function markActive(d, project, now) {
  if (!project) return;
  const projects = loadProjects(d);
  const days = Array.isArray(projects[project]?.activeDays) ? projects[project].activeDays : [];
  const today = localDate(now);
  if (days.includes(today)) return;
  projects[project] = { ...projects[project], activeDays: [...days, today].sort().slice(-MAX_ACTIVE_DAYS) };
  saveProjects(d, projects);
}

const NOTICE_DEFAULTS = { lastNoticeAt: null, lastNoticeCommit: null };

export function loadNotice(d) {
  return { ...NOTICE_DEFAULTS, ...readJson(path.join(d.state, "notice.json"), {}) };
}

export function saveNotice(d, notice) {
  writeJsonAtomic(path.join(d.state, "notice.json"), notice);
}
