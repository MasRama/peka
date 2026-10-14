import fs from "node:fs";
import path from "node:path";
import { isInside } from "./guard.mjs";
import { projectsOf, readFrontmatter } from "./frontmatter.mjs";
import { loadProjects, localDate } from "./state.mjs";

const DAY = 86400000;

export function listSkills(d) {
  let entries;
  try {
    entries = fs.readdirSync(d.skills, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(d.skills, e.name, "SKILL.md")))
    .map((e) => e.name)
    .sort();
}

function linkTarget(link) {
  try {
    if (!fs.lstatSync(link).isSymbolicLink()) return null;
    return path.resolve(path.dirname(link), fs.readlinkSync(link));
  } catch {
    return null;
  }
}

function pointsIntoPeka(target, d) {
  return [d.skills, d.archive].some((root) => {
    if (isInside(target, root)) return true;
    try {
      return isInside(target, fs.realpathSync(root));
    } catch {
      return false;
    }
  });
}

export function syncLinks(d, claudeSkillsDir) {
  const result = { created: [], removed: [], conflicts: [] };
  const live = new Set(listSkills(d));
  fs.mkdirSync(claudeSkillsDir, { recursive: true });

  for (const name of live) {
    const link = path.join(claudeSkillsDir, name);
    const expected = path.join(d.skills, name);
    const target = linkTarget(link);
    if (target === expected) continue;
    if (target === null && !fs.existsSync(link)) {
      fs.symlinkSync(expected, link, "junction");
      result.created.push(name);
      continue;
    }
    result.conflicts.push(name);
  }

  for (const name of fs.readdirSync(claudeSkillsDir).sort()) {
    if (live.has(name)) continue;
    const link = path.join(claudeSkillsDir, name);
    const target = linkTarget(link);
    if (target && pointsIntoPeka(target, d)) {
      fs.unlinkSync(link);
      result.removed.push(name);
    }
  }
  return result;
}

export function recordUse(usage, name, nowIso) {
  const entry = (usage.skills[name] ??= { uses: 0 });
  entry.uses = (entry.uses ?? 0) + 1;
  entry.lastUsed = nowIso;
  entry.state = "active";
}

function stamp(now) {
  return now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

export function archiveSkill(d, name, now, usage) {
  fs.mkdirSync(d.archive, { recursive: true });
  let dest = path.join(d.archive, name);
  if (fs.existsSync(dest)) dest = path.join(d.archive, `${name}-${stamp(now)}`);
  fs.renameSync(path.join(d.skills, name), dest);
  if (usage) (usage.skills[name] ??= {}).state = "archived";
  return dest;
}

export function skillProjects(d, name) {
  try {
    return projectsOf(readFrontmatter(fs.readFileSync(path.join(d.skills, name, "SKILL.md"), "utf8")));
  } catch {
    return [];
  }
}

// Days a skill has gone unused. A project skill only ages on days one of its projects was
// worked on, so a rarely needed procedure survives while its project sits idle.
export function skillAge(d, name, entry, now, projects) {
  const since = new Date(entry.lastUsed ?? entry.created);
  const tags = skillProjects(d, name);
  if (!tags.length) return (now.getTime() - since.getTime()) / DAY;
  const after = localDate(since);
  const days = new Set();
  for (const p of tags) {
    for (const day of projects[p]?.activeDays ?? []) if (day > after) days.add(day);
  }
  return days.size;
}

export function applyLifecycle(d, usage, now, cfg, projects = loadProjects(d)) {
  const result = { stale: [], archived: [], reactivated: [] };
  for (const name of listSkills(d)) {
    const entry = (usage.skills[name] ??= {});
    if (!entry.created) {
      entry.created = now.toISOString();
      entry.uses ??= 0;
      entry.state = "active";
      continue;
    }
    if (entry.pinned) continue;
    const ageDays = skillAge(d, name, entry, now, projects);
    if (ageDays >= cfg.archiveAfterDays) {
      archiveSkill(d, name, now, usage);
      result.archived.push(name);
    } else if (ageDays >= cfg.staleAfterDays) {
      if (entry.state !== "stale") {
        entry.state = "stale";
        result.stale.push(name);
      }
    } else if (entry.state === "stale") {
      entry.state = "active";
      result.reactivated.push(name);
    }
  }
  return result;
}

function memoryStats(d) {
  let files = [];
  try {
    files = fs.readdirSync(d.memory).filter((f) => f.endsWith(".md"));
  } catch {
    // No memory yet.
  }
  let indexLines = 0;
  try {
    indexLines = fs.readFileSync(path.join(d.memory, "MEMORY.md"), "utf8").split("\n").filter(Boolean).length;
  } catch {
    // No index yet.
  }
  return { files: files.length, indexLines };
}

export function writeCuratorReport(d, usage, now) {
  const rows = listSkills(d).map((name) => {
    const u = usage.skills[name] ?? {};
    const last = (u.lastUsed ?? "").slice(0, 10) || "never";
    return `| ${name} | ${u.uses ?? 0} | ${last} | ${u.state ?? "active"} | ${u.pinned ? "yes" : "no"} |`;
  });
  const stats = memoryStats(d);
  const text = [
    `# PEKA curator report (${now.toISOString().slice(0, 10)})`,
    "",
    `Skills dir: ${d.skills}`,
    `Memory dir: ${d.memory}`,
    `Memory files: ${stats.files}`,
    `MEMORY.md lines: ${stats.indexLines}`,
    "",
    "| Skill | Uses | Last used | State | Pinned |",
    "|---|---|---|---|---|",
    ...(rows.length ? rows : ["| (none) | | | | |"]),
    "",
  ].join("\n");
  const file = path.join(d.state, "curator-report.md");
  fs.mkdirSync(d.state, { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}
