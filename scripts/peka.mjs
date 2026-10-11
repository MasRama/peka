#!/usr/bin/env node
// PEKA command line. Plugin skills call this; it prints plain text for Claude to relay.
import fs from "node:fs";
import path from "node:path";
import { claudeHome, dirs, ensureDirs, pekaHome } from "./lib/paths.mjs";
import { loadConfig } from "./lib/config.mjs";
import {
  isSetUp,
  loadCurator,
  loadSession,
  loadUsage,
  readJson,
  saveCurator,
  saveSession,
  saveUsage,
  writeJsonAtomic,
} from "./lib/state.mjs";
import { applySettings, SettingsParseError } from "./lib/settings.mjs";
import { ensureRepo } from "./lib/git.mjs";
import { listSkills, syncLinks, writeCuratorReport } from "./lib/skills.mjs";
import { buildDigest, writeDigest } from "./lib/digest.mjs";
import { searchTranscripts } from "./lib/search.mjs";
import { curatorInstruction, reviewerInstruction } from "./lib/prompts.mjs";

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
    writeJsonAtomic(path.join(d.state, "setup.json"), { version: "0.1.1", at: now.toISOString(), memoryDir });
    syncLinks(d, path.join(claude, "skills"));
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

function status() {
  if (!isSetUp(d)) return out("PEKA is not set up yet. Run /peka:setup.");
  const usage = loadUsage(d);
  const curator = loadCurator(d);
  let memories = [];
  try {
    memories = fs.readdirSync(d.memory).filter((f) => f.endsWith(".md") && f !== "MEMORY.md");
  } catch {
    // No memories yet.
  }
  const skills = listSkills(d);
  const claudeSkills = path.join(claude, "skills");
  const conflicts = skills.filter((name) => {
    const link = path.join(claudeSkills, name);
    const st = fs.lstatSync(link, { throwIfNoEntry: false });
    return st && !(st.isSymbolicLink() && path.resolve(claudeSkills, fs.readlinkSync(link)) === path.join(d.skills, name));
  });
  out(
    `PEKA home: ${d.home}`,
    `Memories: ${memories.length} (${d.memory})`,
    `Skills: ${skills.length} (${d.skills})`,
    ...skills.map((name) => {
      const u = usage.skills[name] ?? {};
      const flags = [u.state ?? "active", u.pinned ? "pinned" : null, conflicts.includes(name) ? "name conflict" : null];
      return `  - ${name}: ${u.uses ?? 0} uses, last ${(u.lastUsed ?? "never").slice(0, 10)}, ${flags.filter(Boolean).join(", ")}`;
    }),
    `Curator: last run ${curator.lastRunAt ?? "never"}`,
    `Review every ${cfg.memoryInterval} turns (memory) / ${cfg.skillInterval} tool calls (skills); reviewer ${cfg.reviewerModel}, curator ${cfg.curatorModel}, auto-commit ${cfg.autoCommit ? "on" : "off"}`,
  );
  if (conflicts.length) out(`Name conflicts (a skill of yours already uses the name, PEKA left it alone): ${conflicts.join(", ")}`);
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
  out(reviewerInstruction({ digest: file, focus: "memory and skills", d, model: cfg.reviewerModel }));
}

function curate() {
  requireSetup();
  const report = writeCuratorReport(d, loadUsage(d), now);
  const c = loadCurator(d);
  c.lastPromptAt = now.toISOString();
  saveCurator(d, c);
  out(curatorInstruction({ report, d, model: cfg.curatorModel }));
}

const [command, ...args] = process.argv.slice(2);
const commands = {
  setup: () => setup(args),
  legacy,
  status,
  where,
  pin: () => setPin(args[0], true),
  unpin: () => setPin(args[0], false),
  search: () => search(args),
  review: () => review(args),
  curate,
};

try {
  if (!commands[command]) throw new UsageError(`unknown command "${command ?? ""}"`);
  commands[command]();
} catch (err) {
  if (err instanceof UsageError) {
    process.stderr.write(`peka: ${err.message}\nUsage: peka setup --check|--apply | legacy | status | where | pin <skill> | unpin <skill> | search <terms…> [--project p] [--limit n] | review --session <id> | curate\n`);
    process.exit(2);
  }
  process.stderr.write(`${err instanceof SettingsParseError ? "" : "peka: "}${err.message}\n`);
  process.exit(1);
}
