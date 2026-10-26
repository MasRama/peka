import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dirs, ensureDirs } from "../scripts/lib/paths.mjs";
import { loadConfig } from "../scripts/lib/config.mjs";
import {
  listSkills,
  syncLinks,
  recordUse,
  applyLifecycle,
  archiveSkill,
  writeCuratorReport,
  globalSkills,
  projectSkills,
  syncProjectLinks,
} from "../scripts/lib/skills.mjs";
import { execFileSync } from "node:child_process";
import { repoOf } from "../scripts/lib/project.mjs";

const DAY = 86400000;
const cfg = loadConfig({});

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "peka-skills-"));
  const d = dirs(path.join(root, "peka"));
  ensureDirs(d);
  const claudeSkills = path.join(root, "claude", "skills");
  fs.mkdirSync(claudeSkills, { recursive: true });
  return { d, claudeSkills };
}

function addSkill(d, name) {
  fs.mkdirSync(path.join(d.skills, name), { recursive: true });
  fs.writeFileSync(path.join(d.skills, name, "SKILL.md"), `---\nname: ${name}\ndescription: test\n---\n`);
}

test("listSkills returns dirs that contain SKILL.md, sorted", () => {
  const { d } = setup();
  addSkill(d, "zeta");
  addSkill(d, "alpha");
  fs.mkdirSync(path.join(d.skills, "empty"));
  assert.deepEqual(listSkills(d), ["alpha", "zeta"]);
});

test("syncLinks creates links and is idempotent", () => {
  const { d, claudeSkills } = setup();
  addSkill(d, "deploy");
  assert.deepEqual(syncLinks(d, claudeSkills), { created: ["deploy"], removed: [], conflicts: [] });
  assert.equal(fs.realpathSync(path.join(claudeSkills, "deploy")), fs.realpathSync(path.join(d.skills, "deploy")));
  assert.deepEqual(syncLinks(d, claudeSkills), { created: [], removed: [], conflicts: [] });
});

test("syncLinks never touches a user-owned skill with the same name", () => {
  const { d, claudeSkills } = setup();
  addSkill(d, "deploy");
  fs.mkdirSync(path.join(claudeSkills, "deploy"));
  fs.writeFileSync(path.join(claudeSkills, "deploy", "SKILL.md"), "mine");
  assert.deepEqual(syncLinks(d, claudeSkills).conflicts, ["deploy"]);
  assert.equal(fs.readFileSync(path.join(claudeSkills, "deploy", "SKILL.md"), "utf8"), "mine");
});

test("syncLinks removes dangling PEKA links but not foreign links", () => {
  const { d, claudeSkills } = setup();
  addSkill(d, "old");
  syncLinks(d, claudeSkills);
  fs.rmSync(path.join(d.skills, "old"), { recursive: true });
  const foreignTarget = fs.mkdtempSync(path.join(os.tmpdir(), "peka-foreign-"));
  fs.symlinkSync(foreignTarget, path.join(claudeSkills, "foreign"));
  assert.deepEqual(syncLinks(d, claudeSkills).removed, ["old"]);
  assert.ok(fs.lstatSync(path.join(claudeSkills, "foreign")).isSymbolicLink());
});

test("recordUse counts uses and reactivates", () => {
  const usage = { skills: { a: { uses: 2, state: "stale" } } };
  recordUse(usage, "a", "2026-05-01T00:00:00.000Z");
  assert.deepEqual(usage.skills.a, { uses: 3, state: "active", lastUsed: "2026-05-01T00:00:00.000Z" });
  recordUse(usage, "b", "2026-05-02T00:00:00.000Z");
  assert.equal(usage.skills.b.uses, 1);
});

test("applyLifecycle seeds, stales at 14 days, archives at 30 days", () => {
  const { d, claudeSkills } = setup();
  addSkill(d, "s");
  const usage = { skills: {} };
  const t0 = new Date("2026-01-01T00:00:00Z");
  applyLifecycle(d, usage, t0, cfg);
  assert.equal(usage.skills.s.created, t0.toISOString());
  assert.equal(usage.skills.s.state, "active");
  recordUse(usage, "s", t0.toISOString());

  assert.deepEqual(applyLifecycle(d, usage, new Date(t0.getTime() + 13 * DAY), cfg).stale, []);
  assert.deepEqual(applyLifecycle(d, usage, new Date(t0.getTime() + 14 * DAY), cfg).stale, ["s"]);
  assert.equal(usage.skills.s.state, "stale");

  syncLinks(d, claudeSkills);
  assert.deepEqual(applyLifecycle(d, usage, new Date(t0.getTime() + 30 * DAY), cfg).archived, ["s"]);
  assert.equal(usage.skills.s.state, "archived");
  assert.ok(fs.existsSync(path.join(d.archive, "s", "SKILL.md")));
  assert.deepEqual(listSkills(d), []);
  assert.deepEqual(syncLinks(d, claudeSkills).removed, ["s"]);
});

test("a skill that was never used goes stale after 7 days and is archived after 10", () => {
  const { d } = setup();
  addSkill(d, "unused");
  const t0 = new Date("2026-01-01T00:00:00Z");
  const usage = { skills: { unused: { created: t0.toISOString(), uses: 0, state: "active" } } };
  assert.deepEqual(applyLifecycle(d, usage, new Date(t0.getTime() + 6 * DAY), cfg).stale, []);
  assert.deepEqual(applyLifecycle(d, usage, new Date(t0.getTime() + 7 * DAY), cfg).stale, ["unused"]);
  assert.deepEqual(applyLifecycle(d, usage, new Date(t0.getTime() + 10 * DAY), cfg).archived, ["unused"]);
});

test("a project skill that was never used is archived after 10 active days of its project", () => {
  const { d } = setup();
  addProjectSkill(d, "fix", "wajom-portal");
  const t0 = new Date("2026-01-01T12:00:00Z");
  const usage = { skills: { fix: { created: t0.toISOString(), uses: 0, state: "active" } } };
  const late = new Date(t0.getTime() + 90 * DAY);
  assert.deepEqual(applyLifecycle(d, usage, late, cfg, { "wajom-portal": { activeDays: activeDays(t0, 9) } }).archived, []);
  assert.deepEqual(applyLifecycle(d, usage, late, cfg, { "wajom-portal": { activeDays: activeDays(t0, 10) } }).archived, ["fix"]);
});

test("applyLifecycle reactivates a stale skill that was used", () => {
  const { d } = setup();
  addSkill(d, "s");
  const now = new Date("2026-03-01T00:00:00Z");
  const usage = { skills: { s: { created: "2026-01-01T00:00:00.000Z", state: "stale", uses: 0 } } };
  recordUse(usage, "s", now.toISOString());
  usage.skills.s.state = "stale";
  assert.deepEqual(applyLifecycle(d, usage, now, cfg).reactivated, ["s"]);
});

test("pinned skills are never staled or archived", () => {
  const { d } = setup();
  addSkill(d, "keep");
  const usage = { skills: { keep: { created: "2025-01-01T00:00:00.000Z", pinned: true, state: "active" } } };
  const r = applyLifecycle(d, usage, new Date("2026-06-01T00:00:00Z"), cfg);
  assert.deepEqual(r, { stale: [], archived: [], reactivated: [] });
  assert.deepEqual(listSkills(d), ["keep"]);
});

test("archiveSkill avoids overwriting an earlier archive", () => {
  const { d } = setup();
  addSkill(d, "x");
  const usage = { skills: {} };
  archiveSkill(d, "x", new Date("2026-01-01T00:00:00Z"), usage);
  addSkill(d, "x");
  const dest = archiveSkill(d, "x", new Date("2026-02-03T04:05:06Z"), usage);
  assert.equal(path.basename(dest), "x-20260203040506");
  assert.ok(fs.existsSync(path.join(d.archive, "x", "SKILL.md")));
});

test("writeCuratorReport lists skills and memory stats", () => {
  const { d } = setup();
  addSkill(d, "deploy");
  fs.writeFileSync(path.join(d.memory, "MEMORY.md"), "- a\n- b\n");
  fs.writeFileSync(path.join(d.memory, "a.md"), "x");
  const usage = { skills: { deploy: { uses: 4, lastUsed: "2026-01-02T00:00:00.000Z", state: "active", pinned: true } } };
  const file = writeCuratorReport(d, usage, new Date("2026-01-10T00:00:00Z"));
  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /\| deploy \| 4 \| 2026-01-02 \| active \| yes \| — \| 8 \|/);
  assert.match(text, /Memory files: 2/);
  assert.match(text, /MEMORY\.md lines: 2/);
});

function addProjectSkill(d, name, project) {
  fs.mkdirSync(path.join(d.skills, name), { recursive: true });
  fs.writeFileSync(
    path.join(d.skills, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: test\nmetadata:\n  project: ${project}\n---\n`,
  );
}

function activeDays(start, count) {
  return Array.from({ length: count }, (_, i) => {
    const t = new Date(start.getTime() + (i + 1) * DAY);
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
  });
}

test("skillProjects reads the project tags of a skill", async () => {
  const { skillProjects } = await import("../scripts/lib/skills.mjs");
  const { d } = setup();
  addProjectSkill(d, "deploy", "wajom-portal, wajom-client");
  addSkill(d, "plain");
  assert.deepEqual(skillProjects(d, "deploy"), ["wajom-portal", "wajom-client"]);
  assert.deepEqual(skillProjects(d, "plain"), []);
  assert.deepEqual(skillProjects(d, "missing"), []);
});

test("a project skill does not age while its project is idle", () => {
  const { d } = setup();
  addProjectSkill(d, "deploy", "wajom-portal");
  const t0 = new Date("2026-01-01T12:00:00Z");
  const usage = { skills: { deploy: { created: t0.toISOString(), uses: 1, lastUsed: t0.toISOString(), state: "active" } } };
  const r = applyLifecycle(d, usage, new Date(t0.getTime() + 40 * DAY), cfg, { "wajom-portal": { activeDays: [] } });
  assert.deepEqual(r, { stale: [], archived: [], reactivated: [] });
  assert.equal(usage.skills.deploy.state, "active");
});

test("a project skill goes stale after 14 active days and is archived after 30", () => {
  const { d } = setup();
  addProjectSkill(d, "deploy", "wajom-portal");
  const t0 = new Date("2026-01-01T12:00:00Z");
  const usage = { skills: { deploy: { created: t0.toISOString(), uses: 1, lastUsed: t0.toISOString(), state: "active" } } };
  const late = new Date(t0.getTime() + 90 * DAY);
  assert.deepEqual(applyLifecycle(d, usage, late, cfg, { "wajom-portal": { activeDays: activeDays(t0, 13) } }).stale, []);
  assert.deepEqual(applyLifecycle(d, usage, late, cfg, { "wajom-portal": { activeDays: activeDays(t0, 14) } }).stale, ["deploy"]);
  assert.deepEqual(applyLifecycle(d, usage, late, cfg, { "wajom-portal": { activeDays: activeDays(t0, 30) } }).archived, ["deploy"]);
});

test("a multi-project skill counts the active days of all its projects once", () => {
  const { d } = setup();
  addProjectSkill(d, "build", "wajom-portal, wajom-client");
  const t0 = new Date("2026-01-01T12:00:00Z");
  const usage = { skills: { build: { created: t0.toISOString(), uses: 1, lastUsed: t0.toISOString(), state: "active" } } };
  const days = activeDays(t0, 14);
  const projects = { "wajom-portal": { activeDays: days.slice(0, 10) }, "wajom-client": { activeDays: days.slice(4) } };
  assert.deepEqual(applyLifecycle(d, usage, new Date(t0.getTime() + 90 * DAY), cfg, projects).stale, ["build"]);
});

test("a skill tagged with a project never seen is never staled by age", () => {
  const { d } = setup();
  addProjectSkill(d, "deploy", "never-opened");
  const t0 = new Date("2026-01-01T12:00:00Z");
  const usage = { skills: { deploy: { created: t0.toISOString(), uses: 0, state: "active" } } };
  const r = applyLifecycle(d, usage, new Date(t0.getTime() + 365 * DAY), cfg, {});
  assert.deepEqual(r.stale.concat(r.archived), []);
});

test("missingPaths reports local paths that do not exist and skips remote ones", async () => {
  const { missingPaths } = await import("../scripts/lib/skills.mjs");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "peka-home-"));
  fs.mkdirSync(path.join(home, "real", "dir"), { recursive: true });
  const text = [
    `Build in ${home}/real/dir, then copy to ${home}/gone/dir.`,
    "Notes live in ~/real/dir and ~/missing/notes.md;",
    "Docs: https://example.com/a/b and git@github.com:/org/repo",
    "Deploy with ssh admin@host, then cd /srv/app/current",
    "Config is (/etc/peka-nope/x.json).",
    "Single segment /tmp is ignored.",
  ].join("\n");
  assert.deepEqual(missingPaths(text, home), [`${home}/gone/dir`, "~/missing/notes.md", "/etc/peka-nope/x.json"]);
});

test("writeCuratorReport adds projects, age, untagged candidates, missing paths, and overflow", () => {
  const { d } = setup();
  const home = path.dirname(d.home);
  addProjectSkill(d, "portal-deploy", "wajom-portal");
  addProjectSkill(d, "ghost-deploy", "never-opened");
  addSkill(d, "abqary-export");
  fs.writeFileSync(path.join(d.state, "projects.json"), JSON.stringify({ "wajom-portal": { activeDays: [] }, "abqary-new": { activeDays: [] } }));
  fs.writeFileSync(
    path.join(d.memory, "billing.md"),
    `---\nname: billing\ndescription: abqary-new billing\nmetadata:\n  type: project\n---\nSee ${home}/no-such-dir/x.\n`,
  );
  fs.writeFileSync(path.join(d.memory, "tagged.md"), "---\nname: tagged\ndescription: about abqary-new\nmetadata:\n  project: abqary-new\n---\n");
  fs.writeFileSync(path.join(d.skills, "abqary-export", "SKILL.md"), "---\nname: abqary-export\ndescription: export in abqary-new\n---\n");
  const text = fs.readFileSync(writeCuratorReport(d, { skills: {} }, new Date("2026-01-10T00:00:00Z"), { overflow: 3 }), "utf8");
  assert.match(text, /\| Skill \| Uses \| Last used \| State \| Pinned \| Project \| Age \(days\) \|/);
  assert.match(text, /\| portal-deploy \| 0 \| never \| active \| no \| wajom-portal \| 0 \|/);
  assert.match(text, /## Project tags with no recorded activity\n\n- never-opened/);
  assert.match(text, /## Untagged memories and skills that mention a known project\n\n- memory billing\.md: abqary-new\n- skill abqary-export: abqary-new/);
  assert.doesNotMatch(text, /memory tagged\.md/);
  assert.match(text, new RegExp(`## Memories mentioning missing local paths\\n\\n- billing\\.md: ${home}/no-such-dir/x`));
  assert.match(text, /MEMORY\.md overflow: 3 global memories did not fit/);
});

test("syncLinks links only the names it is given and drops other PEKA links", () => {
  const { d, claudeSkills } = setup();
  addSkill(d, "a");
  addSkill(d, "b");
  syncLinks(d, claudeSkills);
  assert.deepEqual(syncLinks(d, claudeSkills, ["a"]), { created: [], removed: ["b"], conflicts: [] });
  assert.deepEqual(fs.readdirSync(claudeSkills), ["a"]);
});

test("syncLinks with nothing to link does not create the directory", () => {
  const { d } = setup();
  addSkill(d, "a");
  const dir = path.join(path.dirname(d.home), "repo", ".claude", "skills");
  assert.deepEqual(syncLinks(d, dir, []), { created: [], removed: [], conflicts: [] });
  assert.equal(fs.existsSync(dir), false);
});

test("globalSkills and projectSkills split skills by their project tag", () => {
  const { d } = setup();
  addSkill(d, "slugpost");
  addProjectSkill(d, "deploy", "wajom-portal, wajom-client");
  addProjectSkill(d, "trace", "wajom-portal");
  assert.deepEqual(globalSkills(d), ["slugpost"]);
  assert.deepEqual(projectSkills(d, "wajom-client"), ["deploy"]);
  assert.deepEqual(projectSkills(d, "wajom-portal"), ["deploy", "trace"]);
  assert.deepEqual(projectSkills(d, null), []);
});

function gitRepo(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "peka-repo-"));
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

const gitStatus = (dir) => execFileSync("git", ["status", "--porcelain", "-uall"], { cwd: dir }).toString().trim();

test("syncProjectLinks links a project's skills into its repo and keeps git status clean", () => {
  const { d } = setup();
  addSkill(d, "global");
  addProjectSkill(d, "deploy", "shop");
  addProjectSkill(d, "other", "blog");
  const dir = gitRepo("shop");
  const r = syncProjectLinks(d, repoOf(dir));
  assert.deepEqual(r.created, ["deploy"]);
  const linked = path.join(dir, ".claude", "skills");
  assert.deepEqual(fs.readdirSync(linked), ["deploy"]);
  assert.equal(fs.realpathSync(path.join(linked, "deploy")), fs.realpathSync(path.join(d.skills, "deploy")));
  assert.equal(gitStatus(dir), "");
});

test("syncProjectLinks drops a link and its exclude line once the skill leaves the project", () => {
  const { d } = setup();
  addProjectSkill(d, "deploy", "shop");
  const dir = gitRepo("shop");
  syncProjectLinks(d, repoOf(dir));
  addProjectSkill(d, "deploy", "blog");
  assert.deepEqual(syncProjectLinks(d, repoOf(dir)).removed, ["deploy"]);
  const exclude = fs.readFileSync(path.join(dir, ".git", "info", "exclude"), "utf8");
  assert.doesNotMatch(exclude, /deploy|PEKA/);
});

test("syncProjectLinks leaves a repo's own skill with the same name alone", () => {
  const { d } = setup();
  addProjectSkill(d, "deploy", "shop");
  const dir = gitRepo("shop");
  fs.mkdirSync(path.join(dir, ".claude", "skills", "deploy"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".claude", "skills", "deploy", "SKILL.md"), "mine");
  assert.deepEqual(syncProjectLinks(d, repoOf(dir)).conflicts, ["deploy"]);
  assert.equal(fs.readFileSync(path.join(dir, ".claude", "skills", "deploy", "SKILL.md"), "utf8"), "mine");
});

test("syncProjectLinks never links skills into the PEKA home itself", () => {
  const { d } = setup();
  addProjectSkill(d, "deploy", "peka");
  execFileSync("git", ["init", "-q"], { cwd: d.home });
  assert.deepEqual(syncProjectLinks(d, repoOf(d.home)), { created: [], removed: [], conflicts: [] });
  assert.equal(fs.existsSync(path.join(d.home, ".claude")), false);
});

test("writeCuratorReport measures the global skill listing", () => {
  const { d } = setup();
  addSkill(d, "deploy");
  addProjectSkill(d, "trace", "shop");
  const text = fs.readFileSync(writeCuratorReport(d, { skills: {} }, new Date("2026-01-10T00:00:00Z")), "utf8");
  assert.match(text, /Global skill listing: 1 skills, \d+ characters/);
  assert.doesNotMatch(text, /over budget/i);
});

test("writeCuratorReport flags a global skill listing over budget", () => {
  const { d } = setup();
  for (let i = 0; i < 20; i++) {
    fs.mkdirSync(path.join(d.skills, `s${i}`), { recursive: true });
    fs.writeFileSync(path.join(d.skills, `s${i}`, "SKILL.md"), `---\nname: s${i}\ndescription: ${"x".repeat(500)}\n---\n`);
  }
  const text = fs.readFileSync(writeCuratorReport(d, { skills: {} }, new Date("2026-01-10T00:00:00Z")), "utf8");
  assert.match(text, /over budget/i);
});
