import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dirs, ensureDirs } from "../scripts/lib/paths.mjs";
import { classify } from "../scripts/lib/guard.mjs";

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "peka-guard-"));
  const d = dirs(path.join(root, "peka"));
  ensureDirs(d);
  const claudeSkills = path.join(root, "claude", "skills");
  fs.mkdirSync(claudeSkills, { recursive: true });
  return { root, d, claudeSkills };
}

test("allows markdown writes in memory", () => {
  const { d, claudeSkills } = setup();
  const r = classify("Write", { file_path: path.join(d.memory, "user_role.md") }, d, claudeSkills);
  assert.equal(r.decision, "allow");
  assert.equal(r.kind, "memory");
});

test("allows markdown edits in skills", () => {
  const { d, claudeSkills } = setup();
  const r = classify("Edit", { file_path: path.join(d.skills, "deploy", "SKILL.md") }, d, claudeSkills);
  assert.equal(r.decision, "allow");
  assert.equal(r.kind, "skill");
});

test("does not allow non-markdown writes in skills", () => {
  const { d, claudeSkills } = setup();
  const r = classify("Write", { file_path: path.join(d.skills, "deploy", "run.sh") }, d, claudeSkills);
  assert.equal(r.decision, null);
});

test("does not allow traversal out of memory", () => {
  const { d, claudeSkills } = setup();
  const r = classify("Write", { file_path: path.join(d.memory, "..", "..", "x.md") }, d, claudeSkills);
  assert.equal(r.decision, null);
});

test("does not allow a symlink inside skills that escapes", () => {
  const { root, d, claudeSkills } = setup();
  const outside = path.join(root, "outside");
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(d.skills, "evil"));
  const r = classify("Write", { file_path: path.join(d.skills, "evil", "SKILL.md") }, d, claudeSkills);
  assert.equal(r.decision, null);
});

test("denies writes through a PEKA skill link with the real path", () => {
  const { d, claudeSkills } = setup();
  fs.mkdirSync(path.join(d.skills, "deploy"));
  fs.symlinkSync(path.join(d.skills, "deploy"), path.join(claudeSkills, "deploy"));
  const r = classify("Edit", { file_path: path.join(claudeSkills, "deploy", "SKILL.md") }, d, claudeSkills);
  assert.equal(r.decision, "deny");
  assert.ok(r.reason.includes(path.join(fs.realpathSync(d.skills), "deploy", "SKILL.md")));
});

test("leaves user-owned skills in ~/.claude/skills alone", () => {
  const { d, claudeSkills } = setup();
  fs.mkdirSync(path.join(claudeSkills, "mine"));
  const r = classify("Edit", { file_path: path.join(claudeSkills, "mine", "SKILL.md") }, d, claudeSkills);
  assert.equal(r.decision, null);
});

test("allows reads anywhere inside PEKA home", () => {
  const { d, claudeSkills } = setup();
  assert.equal(classify("Grep", { pattern: "x", path: d.state }, d, claudeSkills).decision, "allow");
  assert.equal(classify("Glob", { pattern: "**/*.md", path: d.memory }, d, claudeSkills).decision, "allow");
  assert.equal(classify("Read", { file_path: path.join(d.digests, "a.md") }, d, claudeSkills).decision, "allow");
});

test("allows writing curator actions but no other state file", () => {
  const { d, claudeSkills } = setup();
  const ok = classify("Write", { file_path: path.join(d.state, "curator-actions.json") }, d, claudeSkills);
  assert.equal(ok.decision, "allow");
  const no = classify("Write", { file_path: path.join(d.state, "usage.json") }, d, claudeSkills);
  assert.equal(no.decision, null);
});

test("returns null for unrelated paths and missing input", () => {
  const { d, claudeSkills } = setup();
  assert.equal(classify("Write", { file_path: "/etc/hosts" }, d, claudeSkills).decision, null);
  assert.equal(classify("Glob", { pattern: "*.md" }, d, claudeSkills).decision, null);
  assert.equal(classify("Bash", { command: "ls" }, d, claudeSkills).decision, null);
  assert.equal(classify("Write", undefined, d, claudeSkills).decision, null);
});
