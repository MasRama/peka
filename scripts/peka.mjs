#!/usr/bin/env node
// PEKA command line. Plugin skills call this; it prints plain text for Claude to relay.
import fs from "node:fs";
import path from "node:path";
import { claudeHome, dirs, ensureDirs, pekaHome } from "./lib/paths.mjs";
import { loadConfig } from "./lib/config.mjs";
import {
  isSetUp,
  loadCurator,
  loadProjects,
  loadSession,
  loadUsage,
  readJson,
  saveCurator,
  saveSession,
  saveUsage,
  writeJsonAtomic,
} from "./lib/state.mjs";
import { applySettings, SettingsParseError } from "./lib/settings.mjs";
import { autoCommit, ensureRepo } from "./lib/git.mjs";
import {
  globalSkills,
  listingSummary,
  listSkills,
  skillAge,
  skillProjects,
  syncLinks,
  untaggedCandidates,
  writeCuratorReport,
} from "./lib/skills.mjs";
import { buildDigest, writeDigest } from "./lib/digest.mjs";
import { searchTranscripts } from "./lib/search.mjs";
import { curatorInstruction, learnerInstruction, reviewerInstruction } from "./lib/prompts.mjs";
import { projectsOf, readFrontmatter } from "./lib/frontmatter.mjs";
import { buildIndex } from "./lib/memory-index.mjs";
import { projectOf } from "./lib/project.mjs";
import { changesSince } from "./lib/changes.mjs";
import { isExecutableSkill } from "./lib/guard.mjs";

const env = process.env;
const now = new Date();
const d = dirs(pekaHome(env));
const claude = claudeHome(env);
const settingsFile = path.join(claude, "settings.json");
// Hooks save the effective plugin options at session start; Bash commands never see them.
const cfg = { ...loadConfig(env), ...readJson(path.join(d.state, "config.json"), {}) };

class UsageError extends Error {}

function out(...lines) {
  process.stdout.write(`${lines.join("\n")}\n`);
}

function memoryDirSetting() {
  return env.PEKA_HOME?.trim() ? d.memory : "~/.peka/memory";
}

function option(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const value = args[i + 1];
  if (value === undefined || value.startsWith("--")) throw new UsageError(`${name} needs a value`);
  args.splice(i, 2);
  return value;
}

function requireSetup() {
  if (!isSetUp(d)) throw new Error("PEKA is not set up yet. Run /peka:setup first.");
}

function plainName(name) {
  return typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.includes("..");
}

function legacyMemories() {
  const projects = path.join(claude, "projects");
  const groups = [];
  let entries = [];
  try {
    entries = fs.readdirSync(projects, { withFileTypes: true });
  } catch {
    return groups;
  }
  for (const e of entries.filter((x) => x.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const dir = path.join(projects, e.name, "memory");
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
    } catch {
      continue;
    }
    if (files.length) groups.push({ project: e.name, dir, files });
  }
  return groups;
}

function setup(args) {
  const memoryDir = memoryDirSetting();
  if (args.includes("--apply")) {
    const r = applySettings(settingsFile, { memoryDir });
    ensureDirs(d);
    ensureRepo(d.home);
    writeJsonAtomic(path.join(d.state, "setup.json"), { version: "0.1.5", at: now.toISOString(), memoryDir });
    syncLinks(d, path.join(claude, "skills"), globalSkills(d));
    out(
      `PEKA is set up. Home: ${d.home}`,
      r.changes.length ? `Changed ${settingsFile}:` : `${settingsFile} already had the right values.`,
      ...r.changes.map((c) => `  - ${c}`),
      r.backup ? `Backup of the previous file: ${r.backup}` : "No backup needed.",
      "Start a new session (or /clear) so the new memory location takes effect.",
    );
    return;
  }
  const plan = applySettings(settingsFile, { memoryDir }, { dryRun: true });
  const legacy = legacyMemories().reduce((n, g) => n + g.files.length, 0);
  out(
    isSetUp(d) ? `PEKA is already set up. Home: ${d.home}` : `PEKA is not set up yet. Home will be: ${d.home}`,
    `Settings file: ${settingsFile}`,
    plan.changes.length ? "Planned changes:" : "Settings already match; nothing to change.",
    ...plan.changes.map((c) => `  - ${c}`),
    `Old per-project memory files found: ${legacy}`,
  );
}

function legacy() {
  const groups = legacyMemories();
  if (!groups.length) return out("No old per-project memories found.");
  const total = groups.reduce((n, g) => n + g.files.length, 0);
  out(`${total} files in ${groups.length} projects:`);
  for (const g of groups) out(``, `${g.project}  (${g.dir})`, ...g.files.map((f) => `  - ${f}`));
}

function where() {
  requireSetup();
  out(`Memory dir: ${d.memory}`, `Memory index: ${path.join(d.memory, "MEMORY.md")}`, `Skills dir: ${d.skills}`);
}

function frontmatterOf(file) {
  try {
    return readFrontmatter(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function memoryFiles() {
  try {
    return fs.readdirSync(d.memory).filter((f) => f.endsWith(".md") && f !== "MEMORY.md").sort();
  } catch {
    return [];
  }
}

function unmanagedSkills() {
  const claudeSkills = path.join(claude, "skills");
  let entries = [];
  try {
    entries = fs.readdirSync(claudeSkills, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(claudeSkills, e.name, "SKILL.md")))
    .map((e) => ({ name: e.name, ...frontmatterOf(path.join(claudeSkills, e.name, "SKILL.md")) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function bodyOf(file) {
  try {
    return fs.readFileSync(file, "utf8").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  } catch {
    return "";
  }
}

function shape(body) {
  return {
    numbered: (body.match(/^\s*\d+[.)]\s+\S/gm) ?? []).length,
    bullets: (body.match(/^\s*[-*]\s+\S/gm) ?? []).length,
    fence: body.includes("```"),
  };
}

// Skills under a "Global" heading, then one heading per project (a skill with several
// projects is listed under its first).
function skillGroups(skills, usage, conflicts) {
  const projects = loadProjects(d);
  const groups = new Map([["Global", []]]);
  for (const name of skills) {
    const key = skillProjects(d, name)[0] ?? "Global";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(name);
  }
  const ordered = [...groups].filter(([, list]) => list.length).sort(([a], [b]) => (a === "Global" ? -1 : b === "Global" ? 1 : a.localeCompare(b)));
  return ordered.flatMap(([heading, list]) => [
    heading === "Global" ? "  Global (every session):" : `  ${heading} (only in that project):`,
    ...list.map((name) => {
      const fm = frontmatterOf(path.join(d.skills, name, "SKILL.md"));
      const u = usage.skills[name] ?? {};
      const age = heading !== "Global" && (u.created || u.lastUsed) ? `${Math.floor(skillAge(d, name, u, now, projects))} active days since last use` : null;
      const flags = [u.state ?? "active", u.pinned ? "pinned" : null, conflicts.includes(name) ? "name conflict" : null, age];
      return [
        `  - ${name} — ${fm.description || "(no description)"}`,
        `    ${u.uses ?? 0} uses, last ${(u.lastUsed ?? "never").slice(0, 10)}, ${flags.filter(Boolean).join(", ")}`,
      ].join("\n");
    }),
  ]);
}

function status() {
  if (!isSetUp(d)) return out("PEKA is not set up yet. Run /peka:setup.");
  const usage = loadUsage(d);
  const curator = loadCurator(d);
  const memories = memoryFiles();
  const skills = listSkills(d);
  const claudeSkills = path.join(claude, "skills");
  const conflicts = skills.filter((name) => {
    const link = path.join(claudeSkills, name);
    const st = fs.lstatSync(link, { throwIfNoEntry: false });
    return st && !(st.isSymbolicLink() && path.resolve(claudeSkills, fs.readlinkSync(link)) === path.join(d.skills, name));
  });
  out(
    `PEKA home: ${d.home}`,
    "",
    `Memories: ${memories.length} (${d.memory})`,
    ...memories.map((file) => {
      const fm = frontmatterOf(path.join(d.memory, file));
      const tags = projectsOf(fm);
      return `  - ${file.slice(0, -3)} [${fm.type || "?"}]${tags.length ? ` (${tags.join(", ")})` : ""} — ${fm.description || "(no description)"}`;
    }),
    "",
    `Skills: ${skills.length} (${d.skills})`,
    ...listingSummary(d),
    ...skillGroups(skills, usage, conflicts),
    "",
    `Curator: last run ${curator.lastRunAt ?? "never"}`,
    `Review every ${cfg.memoryInterval} turns (memory) / ${cfg.skillInterval} tool calls (skills); reviewer ${cfg.reviewerModel}, curator ${cfg.curatorModel}, auto-commit ${cfg.autoCommit ? "on" : "off"}`,
    "Open one in full with /peka:status show <name>.",
  );
  if (conflicts.length) out(`Name conflicts (a skill of yours already uses the name, PEKA left it alone): ${conflicts.join(", ")}`);
  const outside = unmanagedSkills().length;
  if (outside) out(`Skills outside PEKA: ${outside} (see /peka:audit)`);
}

function audit() {
  requireSetup();
  // The index is generated, so rebuild it rather than report drift.
  buildIndex(d);
  const sections = [];
  const add = (title, items) => items.length && sections.push([title, ...items.map((i) => `  - ${i}`)].join("\n"));
  const memories = memoryFiles().map((file) => ({
    file,
    name: file.slice(0, -3),
    fm: frontmatterOf(path.join(d.memory, file)),
    body: bodyOf(path.join(d.memory, file)),
  }));
  const skills = listSkills(d).map((name) => {
    const file = path.join(d.skills, name, "SKILL.md");
    return { name, fm: frontmatterOf(file), body: bodyOf(file), raw: fs.readFileSync(file, "utf8") };
  });

  add(
    "Memories that read like procedures (maybe better as skills):",
    memories
      .filter((m) => {
        const sh = shape(m.body);
        return sh.numbered >= 3 || (sh.fence && sh.numbered + sh.bullets >= 2);
      })
      .map((m) => `${m.name} — ${m.fm.description || "(no description)"}`),
  );
  add(
    "Skills that read like plain facts (maybe better as memories):",
    skills
      .filter((k) => {
        const sh = shape(k.body);
        return sh.numbered + sh.bullets === 0 && !sh.fence && k.body.trim().length < 400;
      })
      .map((k) => `${k.name} — ${k.fm.description || "(no description)"}`),
  );
  add(
    "Skills outside PEKA, in ~/.claude/skills (adopt the ones PEKA should manage):",
    unmanagedSkills().map((k) => `${k.name} — ${k.description || "(no description)"}`),
  );

  add("Memories and skills that mention a known project but have no project tag:", untaggedCandidates(d));
  add(
    "Files with missing frontmatter fields (memories need name, description, type; skills need name, description):",
    [
      ...memories.filter((m) => !m.fm.name || !m.fm.description || !m.fm.type).map((m) => `memory ${m.name}`),
      ...skills.filter((k) => !k.fm.name || !k.fm.description).map((k) => `skill ${k.name}`),
    ],
  );
  add(
    "PEKA skills that can run commands or grant tools (review them):",
    skills.filter((k) => isExecutableSkill(k.raw)).map((k) => k.name),
  );

  if (!sections.length) return out("Nothing to fix: memories and skills are where they belong.");
  out(sections.join("\n\n"));
}

function adopt(name) {
  requireSetup();
  if (!plainName(name)) throw new Error(`Not a skill name: "${name}".`);
  const claudeSkills = path.join(claude, "skills");
  const src = path.join(claudeSkills, name);
  const st = fs.lstatSync(src, { throwIfNoEntry: false });
  if (!st) throw new Error(`No skill named "${name}" in ${claudeSkills}.`);
  if (st.isSymbolicLink()) throw new Error(`${src} is a link, not a skill folder; nothing to adopt.`);
  if (!st.isDirectory() || !fs.existsSync(path.join(src, "SKILL.md"))) throw new Error(`${src} has no SKILL.md.`);
  const dest = path.join(d.skills, name);
  if (fs.existsSync(dest)) throw new Error(`PEKA already has a skill named "${name}". Rename one of them first.`);
  // PEKA versions its store in git; a nested repo, dependencies, or secrets do not belong there.
  const unsafe = fs
    .readdirSync(src, { recursive: true })
    .map(String)
    .filter((rel) => rel.split(path.sep).some((part) => part === ".git" || part === "node_modules" || /^\.env(\..*)?$/.test(part)));
  if (unsafe.length) {
    throw new Error(`${src} contains ${unsafe.slice(0, 3).join(", ")}; PEKA does not adopt folders with a git repo, node_modules, or .env files. Remove them first or keep this skill where it is.`);
  }
  fs.mkdirSync(d.skills, { recursive: true });
  // Copy beside the store, swap it in, and only then remove the original, so a failure at any
  // point leaves the skill working where it was.
  const temp = path.join(d.skills, `.adopt-${name}-${process.pid}`);
  const backup = `${src}.peka-adopting-${process.pid}`;
  try {
    fs.cpSync(src, temp, { recursive: true, verbatimSymlinks: true });
    fs.renameSync(temp, dest);
    fs.renameSync(src, backup);
  } catch (err) {
    fs.rmSync(temp, { recursive: true, force: true });
    if (!fs.existsSync(src)) fs.renameSync(backup, src);
    if (fs.existsSync(src) && fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
    throw err;
  }
  syncLinks(d, claudeSkills, [...new Set([...globalSkills(d), name])]);
  if (!fs.lstatSync(src, { throwIfNoEntry: false })?.isSymbolicLink()) {
    fs.rmSync(src, { force: true });
    fs.renameSync(backup, src);
    fs.rmSync(dest, { recursive: true, force: true });
    throw new Error(`Could not link ${src} back to PEKA; the skill was left where it was.`);
  }
  fs.rmSync(backup, { recursive: true, force: true });
  const usage = loadUsage(d);
  usage.skills[name] = {
    ...usage.skills[name],
    created: now.toISOString(),
    uses: usage.skills[name]?.uses ?? 0,
    state: "active",
    pinned: true,
  };
  saveUsage(d, usage);
  if (cfg.autoCommit) autoCommit(d.home, `peka: adopt skill ${name}`);
  out(
    `Adopted ${name}: moved to ${dest} and linked back at ${src}. It works exactly as before.`,
    `It is pinned, so the curator will not archive it. Run /peka:status unpin ${name} to let PEKA manage it like a learned skill.`,
  );
}

const MODES = new Set(["decide", "skill", "memory"]);

function learn(args) {
  const mode = option(args, "--mode") ?? "decide";
  const id = option(args, "--session");
  if (!MODES.has(mode)) throw new UsageError(`--mode must be one of: ${[...MODES].join(", ")}`);
  if (!id) throw new UsageError("learn needs --session <id>");
  requireSetup();
  if (plainName(id)) {
    // The user is saving by hand, so the next automatic review of the same kind can wait.
    const s = loadSession(d, id);
    saveSession(d, id, mode === "skill" ? { ...s, toolsSinceSkill: 0 } : { ...s, turnsSinceMemory: 0 });
  }
  let digest = null;
  const transcript = plainName(id) ? findTranscript(id) : null;
  if (transcript) {
    const built = buildDigest(transcript, 0, { maxChars: 30000 });
    if (built.text) digest = writeDigest(d, { sessionId: id, cwd: process.cwd(), text: built.text, now });
  }
  const saved = plainName(id) ? loadSession(d, id).project : undefined;
  const project = saved !== undefined ? saved : projectOf(process.cwd());
  out(learnerInstruction({ digest, mode, d, model: cfg.reviewerModel, project }));
}

function show(name) {
  requireSetup();
  if (!name) throw new UsageError("show needs a memory or skill name");
  const base = name.endsWith(".md") ? name.slice(0, -3) : name;
  if (!plainName(base)) throw new Error(`Not a memory or skill name: "${name}".`);
  const candidates = [path.join(d.memory, `${base}.md`), path.join(d.skills, base, "SKILL.md")];
  const found = candidates.filter((f) => fs.lstatSync(f, { throwIfNoEntry: false })?.isFile());
  if (!found.length) throw new Error(`No memory or skill named "${base}". Run /peka:status to list them.`);
  for (const file of found) out(`==> ${file}`, fs.readFileSync(file, "utf8").trimEnd(), "");
}

function setPin(name, pinned) {
  requireSetup();
  if (!plainName(name) || !listSkills(d).includes(name)) throw new Error(`No PEKA skill named "${name}".`);
  const usage = loadUsage(d);
  (usage.skills[name] ??= {}).pinned = pinned;
  saveUsage(d, usage);
  out(pinned ? `Pinned ${name}: it will never be marked stale or archived.` : `Unpinned ${name}.`);
}

function search(args) {
  const project = option(args, "--project");
  const limit = Number(option(args, "--limit") ?? 10);
  if (!args.length) throw new UsageError("search needs at least one term");
  const hits = searchTranscripts(claude, args, { project, limit: Number.isFinite(limit) ? limit : 10 });
  if (!hits.length) return out(`No matches for: ${args.join(" ")}`);
  for (const h of hits) out(`- ${h.when.slice(0, 10)} ${h.project} session ${h.session}`, `  ${h.snippet}`);
}

function findTranscript(id) {
  const projects = path.join(claude, "projects");
  let dirs_ = [];
  try {
    dirs_ = fs.readdirSync(projects);
  } catch {
    return null;
  }
  for (const dir of dirs_) {
    const file = path.join(projects, dir, `${id}.jsonl`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

function review(args) {
  requireSetup();
  const id = option(args, "--session");
  if (!plainName(id)) throw new UsageError("review needs --session <id>");
  const transcript = findTranscript(id);
  if (!transcript) throw new Error(`No transcript found for session ${id}.`);
  const s = loadSession(d, id);
  let digest = buildDigest(transcript, s.lastDigestLine);
  if (!digest.text) digest = buildDigest(transcript, 0);
  if (!digest.text) throw new Error("This session has nothing to review yet.");
  const file = writeDigest(d, { sessionId: id, cwd: process.cwd(), text: digest.text, now });
  saveSession(d, id, { ...s, turnsSinceMemory: 0, toolsSinceSkill: 0, lastDigestLine: digest.toLine });
  const project = s.project !== undefined ? s.project : projectOf(process.cwd());
  out(reviewerInstruction({ digest: file, focus: "memory and skills", d, model: cfg.reviewerModel, project }));
}

function curate() {
  requireSetup();
  const { overflow } = buildIndex(d);
  const report = writeCuratorReport(d, loadUsage(d), now, { overflow });
  const c = loadCurator(d);
  c.lastPromptAt = now.toISOString();
  saveCurator(d, c);
  out(curatorInstruction({ report, d, model: cfg.curatorModel }));
}

function history(raw) {
  requireSetup();
  if (raw !== undefined && !/^\d+$/.test(raw)) throw new UsageError("log takes a number of days");
  const days = Math.min(Math.max(Number(raw ?? 7), 1), 365);
  if (!fs.existsSync(path.join(d.home, ".git"))) {
    return out(`PEKA's change log needs git and auto-commit; ${d.home} has no git history.`);
  }
  const commits = changesSince(d.home, null, { since: new Date(now.getTime() - days * 86400000) }).filter((c) => c.items.length);
  if (!cfg.autoCommit) out("Auto-commit is off, so recent changes may not be in the history yet; PEKA's change log needs git and auto-commit.");
  if (!commits.length) return out(`No changes to memories or skills in the last ${days} days.`);
  out(`PEKA changes in the last ${days} days:`, "");
  for (const c of commits) {
    out(`${c.date.slice(0, 10)} ${c.sha.slice(0, 7)} ${c.subject}`, ...c.items.map((i) => `  - ${i.kind} ${i.name} ${i.status}`));
  }
  out("", `Undo a change with: git -C ${d.home} revert <hash>`);
}

const [command, ...args] = process.argv.slice(2);
const commands = {
  setup: () => setup(args),
  legacy,
  status,
  where,
  show: () => show(args[0]),
  audit,
  adopt: () => adopt(args[0]),
  learn: () => learn(args),
  pin: () => setPin(args[0], true),
  unpin: () => setPin(args[0], false),
  search: () => search(args),
  review: () => review(args),
  curate,
  log: () => history(args[0]),
};

try {
  if (!commands[command]) throw new UsageError(`unknown command "${command ?? ""}"`);
  commands[command]();
} catch (err) {
  if (err instanceof UsageError) {
    process.stderr.write(`peka: ${err.message}\nUsage: peka setup --check|--apply | legacy | status | where | show <name> | audit | adopt <skill> | learn --session <id> --mode decide|skill|memory | pin <skill> | unpin <skill> | search <terms…> [--project p] [--limit n] | review --session <id> | curate | log [days]\n`);
    process.exit(2);
  }
  process.stderr.write(`${err instanceof SettingsParseError ? "" : "peka: "}${err.message}\n`);
  process.exit(1);
}
