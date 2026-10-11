import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { searchTranscripts } from "../scripts/lib/search.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "scripts", "peka.mjs");
const fixture = path.join(root, "test", "fixtures", "transcript.jsonl");

function sandbox() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "peka-cli-"));
  const env = { ...process.env, PEKA_HOME: path.join(tmp, "peka"), CLAUDE_CONFIG_DIR: path.join(tmp, "claude") };
  delete env.CLAUDE_PLUGIN_OPTION_REVIEWER_MODEL;
  fs.mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { env, encoding: "utf8" });
  return { tmp, env, run, home: env.PEKA_HOME, claude: env.CLAUDE_CONFIG_DIR };
}

function session(claude, project, id, lines, mtime) {
  const dir = path.join(claude, "projects", project);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  if (mtime) fs.utimesSync(file, mtime, mtime);
  return file;
}

const user = (text) => ({ type: "user", message: { role: "user", content: text } });
const assistant = (text) => ({ type: "assistant", message: { content: [{ type: "text", text }] } });

test("setup --check reports planned changes and writes nothing", () => {
  const s = sandbox();
  const r = s.run("setup", "--check");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /autoMemoryDirectory/);
  assert.match(r.stdout, /cleanupPeriodDays/);
  assert.match(r.stdout, /not set up/i);
  assert.equal(fs.existsSync(path.join(s.claude, "settings.json")), false);
  assert.equal(fs.existsSync(s.home), false);
});

test("setup --apply configures settings, home, and marks setup done", () => {
  const s = sandbox();
  fs.writeFileSync(path.join(s.claude, "settings.json"), JSON.stringify({ theme: "dark" }));
  const r = s.run("setup", "--apply");
  assert.equal(r.status, 0, r.stderr);
  const settings = JSON.parse(fs.readFileSync(path.join(s.claude, "settings.json"), "utf8"));
  assert.equal(settings.theme, "dark");
  assert.equal(settings.autoMemoryDirectory, path.join(s.home, "memory"));
  assert.equal(settings.cleanupPeriodDays, 365);
  assert.ok(fs.existsSync(path.join(s.home, "state", "setup.json")));
  assert.ok(fs.existsSync(path.join(s.home, ".git")));
  assert.match(r.stdout, /backup/i);
  assert.match(s.run("setup", "--check").stdout, /already set up/i);
});

test("setup --apply refuses a broken settings file", () => {
  const s = sandbox();
  fs.writeFileSync(path.join(s.claude, "settings.json"), "{ nope");
  const r = s.run("setup", "--apply");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /will not overwrite/);
  assert.equal(fs.readFileSync(path.join(s.claude, "settings.json"), "utf8"), "{ nope");
  assert.equal(fs.existsSync(path.join(s.home, "state", "setup.json")), false);
});

test("legacy lists old per-project memories grouped by project", () => {
  const s = sandbox();
  for (const [proj, file] of [["-work-a", "MEMORY.md"], ["-work-a", "deploy.md"], ["-work-b", "style.md"]]) {
    fs.mkdirSync(path.join(s.claude, "projects", proj, "memory"), { recursive: true });
    fs.writeFileSync(path.join(s.claude, "projects", proj, "memory", file), "x");
  }
  fs.mkdirSync(path.join(s.claude, "projects", "-work-c"), { recursive: true });
  const r = s.run("legacy");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /-work-a[\s\S]*deploy\.md/);
  assert.match(r.stdout, /-work-b[\s\S]*style\.md/);
  assert.doesNotMatch(r.stdout, /-work-c/);
  assert.match(s.run("legacy").stdout, /3 files/);
});

test("searchTranscripts matches all terms, newest first, with snippets", () => {
  const s = sandbox();
  session(s.claude, "-work-a", "old", [user("deploy the API to staging"), assistant("Deploy done on staging.")], new Date("2026-01-01"));
  session(s.claude, "-work-b", "new", [user("staging deploy failed again"), assistant("unrelated")], new Date("2026-02-01"));
  session(s.claude, "-work-b", "none", [user("deploy prod")], new Date("2026-03-01"));
  const hits = searchTranscripts(s.claude, ["DEPLOY", "staging"]);
  assert.deepEqual(hits.map((h) => h.session), ["new", "old", "old"]);
  assert.equal(hits[0].project, "-work-b");
  assert.match(hits[0].snippet, /staging deploy failed/);
  assert.equal(searchTranscripts(s.claude, ["deploy", "staging"], { limit: 1 }).length, 1);
  assert.deepEqual(
    searchTranscripts(s.claude, ["deploy"], { project: "work-a" }).map((h) => h.project),
    ["-work-a", "-work-a"],
  );
  assert.deepEqual(searchTranscripts(s.claude, []), []);
});

test("search snippets stay short around the match", () => {
  const s = sandbox();
  session(s.claude, "-p", "x", [user(`${"a".repeat(1000)} needle ${"b".repeat(1000)}`)]);
  const [hit] = searchTranscripts(s.claude, ["needle"]);
  assert.ok(hit.snippet.length <= 320, String(hit.snippet.length));
  assert.match(hit.snippet, /needle/);
});

test("search command prints hits and honors --limit", () => {
  const s = sandbox();
  session(s.claude, "-work-a", "one", [user("pnpm migration notes"), user("more pnpm migration")]);
  const r = s.run("search", "pnpm", "migration", "--limit", "1");
  assert.equal(r.status, 0, r.stderr);
  assert.equal((r.stdout.match(/^- /gm) ?? []).length, 1);
  assert.match(s.run("search", "zzz-nothing").stdout, /No matches/);
});

test("pin and unpin persist; unknown skills are rejected", () => {
  const s = sandbox();
  s.run("setup", "--apply");
  fs.mkdirSync(path.join(s.home, "skills", "deploy"), { recursive: true });
  fs.writeFileSync(path.join(s.home, "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: d\n---\n");
  assert.equal(s.run("pin", "deploy").status, 0);
  const usage = () => JSON.parse(fs.readFileSync(path.join(s.home, "state", "usage.json"), "utf8"));
  assert.equal(usage().skills.deploy.pinned, true);
  assert.match(s.run("status").stdout, /deploy.*pinned/);
  assert.equal(s.run("unpin", "deploy").status, 0);
  assert.equal(usage().skills.deploy.pinned, false);
  assert.equal(s.run("pin", "nope").status, 1);
  assert.equal(s.run("pin", "../x").status, 1);
});

test("status before setup says so", () => {
  const r = sandbox().run("status");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /not set up/i);
});

test("review builds a digest for the session and prints the launch instruction", () => {
  const s = sandbox();
  s.run("setup", "--apply");
  const dir = path.join(s.claude, "projects", "-work-a");
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(fixture, path.join(dir, "abc-123.jsonl"));
  const r = s.run("review", "--session", "abc-123");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /peka:reviewer/);
  assert.match(r.stdout, /run_in_background/);
  const digest = r.stdout.match(/Digest: (\S+)/)[1];
  assert.match(fs.readFileSync(digest, "utf8"), /stop using npm/);
  const sess = JSON.parse(fs.readFileSync(path.join(s.home, "state", "sessions", "abc-123.json"), "utf8"));
  assert.equal(sess.lastDigestLine, 8);
  assert.equal(s.run("review", "--session", "missing").status, 1);
});

test("curate writes the report and prints the launch instruction", () => {
  const s = sandbox();
  s.run("setup", "--apply");
  const r = s.run("curate");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /peka:curator/);
  assert.ok(fs.existsSync(path.join(s.home, "state", "curator-report.md")));
});

test("commands other than setup, legacy, search and status require setup", () => {
  const s = sandbox();
  const r = s.run("curate");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\/peka:setup/);
  assert.equal(s.run("bogus").status, 2);
});

test("where prints the store locations once set up", () => {
  const s = sandbox();
  assert.equal(s.run("where").status, 1);
  s.run("setup", "--apply");
  const r = s.run("where");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(`Memory dir: ${path.join(s.home, "memory")}`));
  assert.ok(r.stdout.includes(`Skills dir: ${path.join(s.home, "skills")}`));
});
