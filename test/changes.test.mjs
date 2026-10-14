import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { changesSince, commitExists, describe, headCommit, mergeItems, summarize } from "../scripts/lib/changes.mjs";

function store() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "peka-changes-"));
  execFileSync("git", ["init", "-q"], { cwd: home });
  return home;
}

function write(home, rel, text = "x\n") {
  fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
  fs.writeFileSync(path.join(home, rel), text);
}

function commit(home, message) {
  execFileSync("git", ["add", "-A"], { cwd: home });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message], { cwd: home });
  return headCommit(home);
}

test("add, update, and archive of memories and skills are reported per commit", () => {
  const home = store();
  write(home, "memory/MEMORY.md");
  write(home, "memory/old.md", "old memory\nwith several lines\nso rename detection works\n");
  write(home, "skills/stale/SKILL.md", "---\nname: stale\n---\nbody that is long enough\nto be detected as a rename\n");
  const base = commit(home, "peka: initialize");

  write(home, "memory/new.md");
  write(home, "memory/MEMORY.md", "y\n");
  write(home, "memory/projects/abqary-new.md");
  write(home, "skills/deploy/SKILL.md");
  write(home, "skills/deploy/notes.md");
  commit(home, "peka: reviewer update");

  write(home, "memory/new.md", "changed\n");
  fs.mkdirSync(path.join(home, "archive", "memory"), { recursive: true });
  fs.renameSync(path.join(home, "memory/old.md"), path.join(home, "archive/memory/old.md"));
  fs.mkdirSync(path.join(home, "archive", "skills"), { recursive: true });
  fs.renameSync(path.join(home, "skills/stale"), path.join(home, "archive/skills/stale"));
  const head = commit(home, "peka: curator update");

  const commits = changesSince(home, base);
  assert.equal(commits.length, 2);
  assert.equal(commits[0].sha, head);
  assert.equal(commits[0].subject, "peka: curator update");
  assert.match(commits[0].date, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(commits[0].items, [
    { kind: "memory", name: "new", status: "updated" },
    { kind: "memory", name: "old", status: "archived" },
    { kind: "skill", name: "stale", status: "archived" },
  ]);
  assert.deepEqual(commits[1].items, [
    { kind: "memory", name: "new", status: "added" },
    { kind: "skill", name: "deploy", status: "added" },
  ]);

  assert.deepEqual(mergeItems(commits), [
    { kind: "memory", name: "new", status: "added" },
    { kind: "memory", name: "old", status: "archived" },
    { kind: "skill", name: "deploy", status: "added" },
    { kind: "skill", name: "stale", status: "archived" },
  ]);
  assert.equal(summarize(mergeItems(commits)), "+1 memory, 1 memory archived, +1 skill, 1 skill archived");
  assert.equal(describe(commits[0].items), "memory new updated; memory old archived; skill stale archived");
  assert.equal(changesSince(home, null).length, 3);
});

test("summarize counts updates and plurals", () => {
  assert.equal(
    summarize([
      { kind: "memory", name: "a", status: "added" },
      { kind: "memory", name: "b", status: "added" },
      { kind: "skill", name: "c", status: "updated" },
      { kind: "memory", name: "d", status: "updated" },
    ]),
    "+2 memories, 1 memory updated, 1 skill updated",
  );
  assert.equal(summarize([]), "");
});

test("an empty range or a store without git gives nothing", () => {
  const home = store();
  write(home, "memory/a.md");
  const head = commit(home, "one");
  assert.deepEqual(changesSince(home, head), []);
  assert.equal(commitExists(home, head), true);
  assert.equal(commitExists(home, "0".repeat(40)), false);

  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "peka-nogit-"));
  assert.equal(headCommit(plain), null);
  assert.deepEqual(changesSince(plain, null), []);
  assert.equal(commitExists(plain, head), false);
  assert.equal(headCommit(path.join(plain, "missing")), null);
});

test("changesSince can limit by date", () => {
  const home = store();
  write(home, "memory/a.md");
  commit(home, "one");
  assert.equal(changesSince(home, null, { since: new Date(Date.now() + 86400000) }).length, 0);
  assert.equal(changesSince(home, null, { since: new Date(Date.now() - 86400000) }).length, 1);
});
