import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { normalizeProject, projectOf, repoOf } from "../scripts/lib/project.mjs";
import { projectsOf, readFrontmatter } from "../scripts/lib/frontmatter.mjs";

function git(cwd, ...args) {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "ignore" });
}

function repo(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "peka-project-"));
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, "src", "lib"), { recursive: true });
  git(dir, "init", "-q");
  fs.writeFileSync(path.join(dir, "README.md"), "x\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return { root, dir };
}

test("normalizeProject lowercases and replaces odd characters", () => {
  assert.equal(normalizeProject("My App!"), "my-app");
  assert.equal(normalizeProject("abqary-new"), "abqary-new");
  assert.equal(normalizeProject("wajom_client.v2"), "wajom_client.v2");
  assert.equal(normalizeProject("  "), null);
  assert.equal(normalizeProject("!!!"), null);
  assert.equal(normalizeProject(undefined), null);
});

test("projectOf uses the git repository folder from the root and from a subdirectory", () => {
  const { dir } = repo("Abqary-New");
  assert.equal(projectOf(dir), "abqary-new");
  assert.equal(projectOf(path.join(dir, "src", "lib")), "abqary-new");
});

test("projectOf resolves a git worktree to its main repository", () => {
  const { root, dir } = repo("wajom-client");
  const wt = path.join(root, "feat-x");
  git(dir, "worktree", "add", "-q", wt);
  assert.equal(projectOf(wt), "wajom-client");
});

test("projectOf has no project outside a git repository", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "peka-nogit-"));
  const dir = path.join(root, "Downloads");
  fs.mkdirSync(dir);
  assert.equal(projectOf(dir, { home: os.homedir() }), null);
});

test("projectOf has no project for home, root, or a missing cwd", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "peka-home-"));
  assert.equal(projectOf(home, { home }), null);
  assert.equal(projectOf(path.parse(home).root, { home }), null);
  assert.equal(projectOf(undefined, { home }), null);
  assert.equal(projectOf("", { home }), null);
  assert.equal(projectOf(path.join(home, "does-not-exist"), { home }), null);
});

test("readFrontmatter reads project at the top level or under metadata", () => {
  assert.equal(readFrontmatter("---\nname: a\nproject: x\n---\n").project, "x");
  assert.equal(
    readFrontmatter("---\nname: a\nmetadata:\n  type: project\n  project: wajom-portal, Wajom-Client\n---\n").project,
    "wajom-portal, Wajom-Client",
  );
});

test("projectsOf splits, normalizes, and dedups project tags", () => {
  assert.deepEqual(projectsOf({ project: "wajom-portal, Wajom-Client, wajom-portal" }), ["wajom-portal", "wajom-client"]);
  assert.deepEqual(projectsOf({ project: "" }), []);
  assert.deepEqual(projectsOf({}), []);
  assert.deepEqual(projectsOf(readFrontmatter("no frontmatter")), []);
});

test("repoOf gives the project, the checkout root, and the exclude file of the main repository", () => {
  const { root, dir } = repo("wajom-client");
  const wt = path.join(root, "feat-x");
  git(dir, "worktree", "add", "-q", wt);
  const r = repoOf(wt);
  assert.equal(r.project, "wajom-client");
  assert.equal(r.root, fs.realpathSync(wt));
  assert.equal(r.exclude, path.join(fs.realpathSync(dir), ".git", "info", "exclude"));
  assert.equal(repoOf(fs.mkdtempSync(path.join(os.tmpdir(), "peka-nogit-")), { home: os.homedir() }), null);
});
