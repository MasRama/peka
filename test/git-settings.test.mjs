import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ensureRepo, autoCommit } from "../scripts/lib/git.mjs";
import { applySettings, SettingsParseError } from "../scripts/lib/settings.mjs";

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function commitCount(dir) {
  return Number(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: dir }).toString().trim());
}

test("ensureRepo initializes once with an ignore for state", () => {
  const home = tmp("peka-git-");
  assert.equal(ensureRepo(home), true);
  assert.equal(fs.readFileSync(path.join(home, ".gitignore"), "utf8"), "state/\n");
  assert.equal(commitCount(home), 1);
  assert.equal(ensureRepo(home), true);
  assert.equal(commitCount(home), 1);
});

test("autoCommit commits changes once and ignores state", () => {
  const home = tmp("peka-git-");
  ensureRepo(home);
  fs.mkdirSync(path.join(home, "memory"));
  fs.writeFileSync(path.join(home, "memory", "a.md"), "hello");
  fs.mkdirSync(path.join(home, "state"));
  fs.writeFileSync(path.join(home, "state", "x.json"), "{}");
  assert.equal(autoCommit(home, "peka: test"), true);
  assert.equal(autoCommit(home, "peka: test"), false);
  const files = execFileSync("git", ["ls-files"], { cwd: home }).toString();
  assert.match(files, /memory\/a\.md/);
  assert.doesNotMatch(files, /state\//);
});

test("autoCommit is a no-op outside a repo", () => {
  assert.equal(autoCommit(tmp("peka-nogit-"), "x"), false);
});

test("applySettings adds keys, keeps others, writes a backup", () => {
  const dir = tmp("peka-settings-");
  const file = path.join(dir, "settings.json");
  fs.writeFileSync(file, JSON.stringify({ model: "opus", hooks: { Stop: [] }, cleanupPeriodDays: 30 }));
  const r = applySettings(file, { memoryDir: "~/.peka/memory" });
  assert.equal(r.changes.length, 2);
  assert.ok(r.backup && fs.existsSync(r.backup));
  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(after, {
    model: "opus",
    hooks: { Stop: [] },
    cleanupPeriodDays: 365,
    autoMemoryDirectory: "~/.peka/memory",
  });
  assert.deepEqual(applySettings(file, { memoryDir: "~/.peka/memory" }), { changes: [], backup: null });
});

test("applySettings keeps a longer retention", () => {
  const dir = tmp("peka-settings-");
  const file = path.join(dir, "settings.json");
  fs.writeFileSync(file, JSON.stringify({ cleanupPeriodDays: 400 }));
  applySettings(file, { memoryDir: "~/.peka/memory" });
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).cleanupPeriodDays, 400);
});

test("applySettings creates a missing file and dry run writes nothing", () => {
  const dir = tmp("peka-settings-");
  const file = path.join(dir, "nested", "settings.json");
  const dry = applySettings(file, { memoryDir: "/m" }, { dryRun: true });
  assert.equal(dry.changes.length, 2);
  assert.equal(fs.existsSync(file), false);
  applySettings(file, { memoryDir: "/m" });
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).autoMemoryDirectory, "/m");
});

test("applySettings refuses invalid JSON and leaves the file untouched", () => {
  const dir = tmp("peka-settings-");
  const file = path.join(dir, "settings.json");
  fs.writeFileSync(file, "{ broken");
  assert.throws(() => applySettings(file, { memoryDir: "/m" }), SettingsParseError);
  assert.equal(fs.readFileSync(file, "utf8"), "{ broken");
  assert.deepEqual(fs.readdirSync(dir), ["settings.json"]);
});

test("autoCommit falls back to the PEKA identity when none is configured", () => {
  const home = tmp("peka-git-");
  const empty = path.join(tmp("peka-gitcfg-"), "config");
  fs.writeFileSync(empty, "");
  const saved = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_NOSYSTEM };
  process.env.GIT_CONFIG_GLOBAL = empty;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  try {
    assert.equal(ensureRepo(home), true);
    const author = execFileSync("git", ["log", "-1", "--format=%an <%ae>"], { cwd: home }).toString().trim();
    assert.equal(author, "PEKA <peka@localhost>");
  } finally {
    if (saved.g === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = saved.g;
    if (saved.s === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
    else process.env.GIT_CONFIG_NOSYSTEM = saved.s;
  }
});
