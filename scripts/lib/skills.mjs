import fs from "node:fs";
import path from "node:path";
import { isInside } from "./guard.mjs";
import { projectsOf, readFrontmatter } from "./frontmatter.mjs";
import { loadProjects, localDate } from "./state.mjs";
import { readMemories } from "./memory-index.mjs";
import { expandHome } from "./paths.mjs";

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

// Links `names` (every live skill by default) into a skills directory and removes PEKA links
// that are no longer wanted there. Anything else in the directory belongs to the user.
export function syncLinks(d, claudeSkillsDir, names = listSkills(d)) {
  const result = { created: [], removed: [], conflicts: [] };
  const live = new Set(names);
  if (!live.size && !fs.existsSync(claudeSkillsDir)) return result;
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

// Skills without a project tag: Claude Code lists these in every session.
export function globalSkills(d) {
  return listSkills(d).filter((name) => !skillProjects(d, name).length);
}

export function projectSkills(d, project) {
  return project ? listSkills(d).filter((name) => skillProjects(d, name).includes(project)) : [];
}

const EXCLUDE_START = "# PEKA: project skill links (managed by PEKA)";
const EXCLUDE_END = "# PEKA: end";

// Lists the PEKA links in the checkout's exclude file so they never show up in git status.
function writeExclude(file, names) {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    // No exclude file yet.
  }
  const lines = text.split("\n");
  const start = lines.indexOf(EXCLUDE_START);
  const end = lines.indexOf(EXCLUDE_END, start);
  if (start !== -1 && end !== -1) lines.splice(start, end - start + 1);
  let next = lines.join("\n").replace(/\n+$/, "");
  if (names.length) {
    next += `${next ? "\n\n" : ""}${[EXCLUDE_START, ...names.map((n) => `/.claude/skills/${n}`), EXCLUDE_END].join("\n")}`;
  }
  next = next ? `${next}\n` : "";
  if (next === text) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next);
}

// Project skills live in the project's own .claude/skills, so other projects never list them.
export function syncProjectLinks(d, repo) {
  const empty = { created: [], removed: [], conflicts: [] };
  if (!repo?.project || !repo.root) return empty;
  const home = fs.existsSync(d.home) ? fs.realpathSync(d.home) : d.home;
  if (isInside(repo.root, d.home) || isInside(repo.root, home)) return empty;
  const dir = path.join(repo.root, ".claude", "skills");
  const result = syncLinks(d, dir, projectSkills(d, repo.project));
  if (fs.existsSync(dir) && repo.exclude) {
    const linked = fs.readdirSync(dir).filter((name) => {
      const target = linkTarget(path.join(dir, name));
      return target && pointsIntoPeka(target, d);
    });
    writeExclude(repo.exclude, linked.sort());
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

const PATH_TOKEN = /(?<![\w:@/.~-])(~\/[^\s`'"()<>[\]]+|\/[\w.-]+(?:\/[^\s`'"()<>[\]]*)+)/g;
const MAX_MISSING = 50;

// Local paths a memory mentions that no longer exist. Lines about ssh, URLs, and host:path
// forms are skipped, since those paths live on other machines.
export function missingPaths(text, home) {
  const found = [];
  for (const line of String(text).split("\n")) {
    if (/\bssh\b/i.test(line)) continue;
    for (const [token] of line.matchAll(PATH_TOKEN)) {
      const p = token.replace(/[.,;:!?'"`)\]]+$/, "");
      if (p.split("/").filter(Boolean).length < 2) continue;
      const abs = p.startsWith("~/") ? path.join(home, p.slice(2)) : p;
      if (!fs.existsSync(abs) && !found.includes(p)) found.push(p);
    }
  }
  return found;
}

function bodyOf(text) {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

function mentions(text, project) {
  const escaped = project.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, "i").test(text);
}

function section(title, items) {
  return items.length ? ["", `## ${title}`, "", ...items.map((i) => `- ${i}`)] : [];
}

function storeItems(d) {
  const skills = listSkills(d).map((name) => {
    let raw = "";
    try {
      raw = fs.readFileSync(path.join(d.skills, name, "SKILL.md"), "utf8");
    } catch {
      // Listed skills have a SKILL.md; a race just leaves it empty.
    }
    return { name, raw, tags: projectsOf(readFrontmatter(raw)) };
  });
  const memories = readMemories(d).map((m) => {
    let raw = "";
    try {
      raw = fs.readFileSync(path.join(d.memory, m.file), "utf8");
    } catch {
      // Unreadable: nothing to check.
    }
    return { ...m, raw };
  });
  return { skills, memories };
}

function knownProjects(d, { skills, memories }) {
  const tagged = new Set([...skills.flatMap((k) => k.tags), ...memories.flatMap((m) => m.projects)]);
  return { tagged, known: [...new Set([...Object.keys(loadProjects(d)), ...tagged])].sort() };
}

// Untagged memories and skills that name a project PEKA knows: candidates for a project tag.
export function untaggedCandidates(d, items = storeItems(d)) {
  const { known } = knownProjects(d, items);
  return [
    ...items.memories.filter((m) => !m.projects.length).map((m) => ({ label: `memory ${m.file}`, text: m.raw })),
    ...items.skills.filter((k) => !k.tags.length).map((k) => ({ label: `skill ${k.name}`, text: k.raw })),
  ]
    .map(({ label, text }) => ({ label, hits: known.filter((p) => mentions(text, p)) }))
    .filter((x) => x.hits.length)
    .map((x) => `${x.label}: ${x.hits.join(", ")}`);
}

// Claude Code lists every global skill in every session and shortens the descriptions once the
// listing passes about 1% of the context window: 8,000 characters on a 200k-token model.
export const LISTING_BUDGET = 8000;

export function globalListingChars(d) {
  return globalSkills(d).reduce((n, name) => {
    let fm = {};
    try {
      fm = readFrontmatter(fs.readFileSync(path.join(d.skills, name, "SKILL.md"), "utf8"));
    } catch {
      // Unreadable: counts as its name only.
    }
    return n + name.length + String(fm.description ?? "").length + String(fm.when_to_use ?? "").length;
  }, 0);
}

export function listingSummary(d) {
  const count = globalSkills(d).length;
  const chars = globalListingChars(d);
  const over = chars > LISTING_BUDGET;
  return [
    `Global skill listing: ${count} skills, ${chars} characters of names and descriptions (budget about ${LISTING_BUDGET}).`,
    ...(over ? [`Global skill listing is over budget: tag project-only skills, merge overlapping ones, or archive unused ones.`] : []),
  ];
}

export function writeCuratorReport(d, usage, now, { overflow = 0, home = expandHome("~") } = {}) {
  const projects = loadProjects(d);
  const items = storeItems(d);
  const { skills, memories } = items;

  const rows = skills.map(({ name, tags }) => {
    const u = usage.skills[name] ?? {};
    const last = (u.lastUsed ?? "").slice(0, 10) || "never";
    const age = u.created || u.lastUsed ? Math.floor(skillAge(d, name, u, now, projects)) : 0;
    return `| ${name} | ${u.uses ?? 0} | ${last} | ${u.state ?? "active"} | ${u.pinned ? "yes" : "no"} | ${tags.join(", ") || "—"} | ${age} |`;
  });

  const { tagged } = knownProjects(d, items);
  const untagged = untaggedCandidates(d, items);
  const missing = memories
    .flatMap((m) => missingPaths(bodyOf(m.raw), home).map((p) => `${m.file}: ${p}`))
    .slice(0, MAX_MISSING);

  const stats = memoryStats(d);
  const text = [
    `# PEKA curator report (${now.toISOString().slice(0, 10)})`,
    "",
    `Skills dir: ${d.skills}`,
    `Memory dir: ${d.memory}`,
    `Memory files: ${stats.files}`,
    `MEMORY.md lines: ${stats.indexLines}`,
    ...listingSummary(d),
    ...(overflow ? [`MEMORY.md overflow: ${overflow} global memories did not fit; merge or tag some.`] : []),
    "",
    "Age is calendar days since last use for global skills, and days the project was worked on for project skills.",
    "",
    "| Skill | Uses | Last used | State | Pinned | Project | Age (days) |",
    "|---|---|---|---|---|---|---|",
    ...(rows.length ? rows : ["| (none) | | | | | | |"]),
    ...section(
      "Project tags with no recorded activity",
      [...tagged].filter((p) => !projects[p]).sort(),
    ),
    ...section("Untagged memories and skills that mention a known project", untagged),
    ...section("Memories mentioning missing local paths", missing),
    "",
  ].join("\n");
  const file = path.join(d.state, "curator-report.md");
  fs.mkdirSync(d.state, { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}
