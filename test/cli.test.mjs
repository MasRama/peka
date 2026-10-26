import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
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
  assert.match(s.run("status").stdout, /- deploy — d\n    0 uses, last never, active, pinned/);
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
  assert.match(r.stdout, /run_in_background: false/);
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

function seedStore(s) {
  s.run("setup", "--apply");
  const mem = path.join(s.home, "memory");
  fs.writeFileSync(path.join(mem, "MEMORY.md"), "- [pnpm](prefers-pnpm.md) — package manager\n");
  fs.writeFileSync(
    path.join(mem, "prefers-pnpm.md"),
    '---\nname: prefers-pnpm\ndescription: "Always use pnpm, never npm"\nmetadata:\n  type: feedback\n---\n\nUse pnpm.\n**Why:** monorepo.\n',
  );
  fs.writeFileSync(path.join(mem, "loose.md"), "no frontmatter here\n");
  fs.mkdirSync(path.join(s.home, "skills", "deploy-api"), { recursive: true });
  fs.writeFileSync(
    path.join(s.home, "skills", "deploy-api", "SKILL.md"),
    "---\nname: deploy-api\ndescription: Deploy the API to staging with pm2\n---\n\n# Deploy\n1. ssh in\n",
  );
}

test("status lists every memory and skill with its description", () => {
  const s = sandbox();
  seedStore(s);
  const r = s.run("status");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Memories: 2/);
  assert.match(r.stdout, /prefers-pnpm \[feedback\] — Always use pnpm, never npm/);
  assert.match(r.stdout, /loose \[\?\] — \(no description\)/);
  assert.match(r.stdout, /deploy-api — Deploy the API to staging with pm2/);
  assert.match(r.stdout, /\/peka:status show <name>/);
});

test("setup links only global skills into ~/.claude/skills", () => {
  const s = sandbox();
  for (const [name, meta] of [["slugpost", ""], ["shop-deploy", "metadata:\n  project: shop\n"]]) {
    fs.mkdirSync(path.join(s.home, "skills", name), { recursive: true });
    fs.writeFileSync(path.join(s.home, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: d\n${meta}---\n`);
  }
  assert.equal(s.run("setup", "--apply").status, 0);
  assert.deepEqual(fs.readdirSync(path.join(s.claude, "skills")), ["slugpost"]);
});

test("status says which skills load everywhere and which only in their project", () => {
  const s = sandbox();
  seedStore(s);
  fs.mkdirSync(path.join(s.home, "skills", "shop-deploy"), { recursive: true });
  fs.writeFileSync(path.join(s.home, "skills", "shop-deploy", "SKILL.md"), "---\nname: shop-deploy\ndescription: d\nmetadata:\n  project: shop\n---\n");
  const r = s.run("status");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Global skill listing: 1 skills, \d+ characters/);
  assert.match(r.stdout, /Global \(every session\):/);
  assert.match(r.stdout, /shop \(only in that project\):/);
});

test("status lists memories and skills over their size budget", () => {
  const s = sandbox();
  seedStore(s);
  fs.mkdirSync(path.join(s.home, "skills", "fat"), { recursive: true });
  fs.writeFileSync(path.join(s.home, "skills", "fat", "SKILL.md"), "---\nname: fat\ndescription: d\n---\n" + "x".repeat(7000));
  const r = s.run("status");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Over the size budget \(the curator rewrites these shorter\): 1\n  - skill fat: \d+ characters \(budget 6000\)/);
});

test("show prints a memory or skill in full and rejects paths", () => {
  const s = sandbox();
  seedStore(s);
  const mem = s.run("show", "prefers-pnpm");
  assert.equal(mem.status, 0, mem.stderr);
  assert.match(mem.stdout, /\*\*Why:\*\* monorepo/);
  assert.match(mem.stdout, /prefers-pnpm\.md/);
  assert.match(s.run("show", "prefers-pnpm.md").stdout, /Use pnpm/);
  assert.match(s.run("show", "deploy-api").stdout, /1\. ssh in/);
  assert.match(s.run("show", "MEMORY").stdout, /package manager/);
  assert.equal(s.run("show", "nope").status, 1);
  assert.equal(s.run("show", "../state/setup").status, 1);
  assert.equal(s.run("show").status, 2);
});

test("learn prepares a digest and the learner launch instruction", () => {
  const s = sandbox();
  s.run("setup", "--apply");
  const dir = path.join(s.claude, "projects", "-work-a");
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(fixture, path.join(dir, "sess-1.jsonl"));
  for (const mode of ["decide", "skill"]) {
    const r = s.run("learn", "--session", "sess-1", "--mode", mode);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /peka:learner/);
    assert.match(r.stdout, new RegExp(`Mode: ${mode}`));
    assert.match(r.stdout, /Request: /);
    assert.match(fs.readFileSync(r.stdout.match(/Digest: (\S+)/)[1], "utf8"), /stop using npm/);
  }
  const sess = () => JSON.parse(fs.readFileSync(path.join(s.home, "state", "sessions", "sess-1.json"), "utf8"));
  assert.equal(sess().toolsSinceSkill, 0);
  assert.equal(sess().lastDigestLine, 0, "the next review still sees the whole conversation");
  fs.writeFileSync(path.join(s.home, "state", "sessions", "sess-1.json"), JSON.stringify({ turnsSinceMemory: 7, toolsSinceSkill: 9, lastDigestLine: 0 }));
  s.run("learn", "--session", "sess-1", "--mode", "decide");
  assert.deepEqual(sess(), { turnsSinceMemory: 0, toolsSinceSkill: 9, lastDigestLine: 0 });
  assert.match(s.run("learn", "--session", "sess-1", "--mode", "decide").stdout, /learner-actions\.json/);
  assert.equal(s.run("learn", "--session", "--mode", "skill").status, 2, "a missing id must not swallow the next flag");
  const none = s.run("learn", "--session", "missing", "--mode", "decide");
  assert.equal(none.status, 0, none.stderr);
  assert.match(none.stdout, /Digest: none/);
  assert.equal(s.run("learn", "--session", "x", "--mode", "bogus").status, 2);
});

test("audit reports misplaced knowledge and store problems", () => {
  const s = sandbox();
  seedStore(s);
  const mem = path.join(s.home, "memory");
  fs.writeFileSync(
    path.join(mem, "deploy-howto.md"),
    "---\nname: deploy-howto\ndescription: how to deploy\nmetadata:\n  type: reference\n---\n1. build\n2. upload\n3. restart pm2\n",
  );
  fs.appendFileSync(path.join(mem, "MEMORY.md"), "- [Gone](gone.md) — missing file\n- [Docs](https://example.com/README.md) — external\n- [Titled](deploy-howto.md \"t\") — titled link\n");
  fs.mkdirSync(path.join(s.home, "skills", "api-port"), { recursive: true });
  fs.writeFileSync(path.join(s.home, "skills", "api-port", "SKILL.md"), "---\nname: api-port\ndescription: API port\n---\nThe API listens on 8080.\n");
  const own = path.join(s.claude, "skills", "my-own");
  fs.mkdirSync(own, { recursive: true });
  fs.writeFileSync(path.join(own, "SKILL.md"), "---\nname: my-own\ndescription: mine\n---\n");
  const r = s.run("audit");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Memories that read like procedures[\s\S]*deploy-howto/);
  assert.match(r.stdout, /Skills that read like plain facts[\s\S]*api-port/);
  assert.match(r.stdout, /Skills outside PEKA[\s\S]*my-own — mine/);
  assert.match(r.stdout, /missing frontmatter fields[\s\S]*loose/);
  assert.doesNotMatch(r.stdout, /not in MEMORY\.md|points to a missing file/);
  const index = fs.readFileSync(path.join(mem, "MEMORY.md"), "utf8");
  assert.match(index, /^- \[loose\]\(loose\.md\)/m, "audit rebuilds the index first");
  assert.doesNotMatch(index, /gone\.md/);
  assert.doesNotMatch(r.stdout, /Skills that read like plain facts[^\n]*\n[^\n]*deploy-api/);
  assert.doesNotMatch(r.stdout, /README\.md/);
});

test("audit of a tidy store says so", () => {
  const s = sandbox();
  s.run("setup", "--apply");
  assert.match(s.run("audit").stdout, /Nothing to fix/);
});

test("adopt moves a skill from ~/.claude/skills into PEKA and links it back", () => {
  const s = sandbox();
  s.run("setup", "--apply");
  const own = path.join(s.claude, "skills", "deploy-staging");
  fs.mkdirSync(own, { recursive: true });
  fs.writeFileSync(path.join(own, "SKILL.md"), "---\nname: deploy-staging\ndescription: d\n---\nsteps\n");
  const r = s.run("adopt", "deploy-staging");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /pinned/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.home, "state", "usage.json"), "utf8")).skills["deploy-staging"].pinned, true);
  assert.equal(fs.readFileSync(path.join(s.home, "skills", "deploy-staging", "SKILL.md"), "utf8").includes("steps"), true);
  assert.ok(fs.lstatSync(own).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(own, "SKILL.md"), "utf8").includes("steps"), true);
  assert.equal(s.run("adopt", "deploy-staging").status, 1, "already a PEKA link");
  assert.equal(s.run("adopt", "missing").status, 1);
  assert.equal(s.run("adopt", "../etc").status, 1);
  fs.mkdirSync(path.join(s.claude, "skills", "clash"), { recursive: true });
  fs.writeFileSync(path.join(s.claude, "skills", "clash", "SKILL.md"), "x");
  fs.mkdirSync(path.join(s.home, "skills", "clash"), { recursive: true });
  fs.writeFileSync(path.join(s.home, "skills", "clash", "SKILL.md"), "peka");
  assert.equal(s.run("adopt", "clash").status, 1);
  assert.equal(fs.readFileSync(path.join(s.claude, "skills", "clash", "SKILL.md"), "utf8"), "x");
  for (const extra of [".git", "node_modules", ".env"]) {
    const dir = path.join(s.claude, "skills", `has${extra.replace(".", "-")}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), "x");
    if (extra === ".env") fs.writeFileSync(path.join(dir, extra), "SECRET=1");
    else fs.mkdirSync(path.join(dir, extra));
    const res = s.run("adopt", path.basename(dir));
    assert.equal(res.status, 1, extra);
    assert.ok(fs.lstatSync(dir).isDirectory() && !fs.lstatSync(dir).isSymbolicLink(), extra);
  }
});

test("status mentions skills outside PEKA", () => {
  const s = sandbox();
  s.run("setup", "--apply");
  fs.mkdirSync(path.join(s.claude, "skills", "mine"), { recursive: true });
  fs.writeFileSync(path.join(s.claude, "skills", "mine", "SKILL.md"), "---\nname: mine\ndescription: m\n---\n");
  assert.match(s.run("status").stdout, /Skills outside PEKA: 1 \(see \/peka:audit\)/);
});

function commitStore(home, message) {
  execFileSync("git", ["add", "-A"], { cwd: home });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message], { cwd: home });
  return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: home }).toString().trim();
}

test("log lists recent store changes and how to undo them", () => {
  const s = sandbox();
  seedStore(s);
  const sha = commitStore(s.home, "peka: reviewer update");
  fs.writeFileSync(path.join(s.home, "memory", "MEMORY.md"), "only the index\n");
  commitStore(s.home, "peka: index only");
  const r = s.run("log");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /PEKA changes in the last 7 days:/);
  assert.match(r.stdout, new RegExp(`\\d{4}-\\d{2}-\\d{2} ${sha} peka: reviewer update\\n  - memory loose added\\n  - memory prefers-pnpm added\\n  - skill deploy-api added`));
  assert.doesNotMatch(r.stdout, /index only/);
  assert.ok(r.stdout.includes(`git -C ${s.home} revert <hash>`));
  assert.equal(s.run("log", "400").status, 0);
  assert.equal(s.run("log", "abc").status, 2);
});

test("log explains when there is no history", () => {
  const s = sandbox();
  s.run("setup", "--apply");
  fs.rmSync(path.join(s.home, ".git"), { recursive: true });
  const r = s.run("log");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /needs git and auto-commit/);
});

test("status groups skills by project and shows memory projects", () => {
  const s = sandbox();
  seedStore(s);
  fs.mkdirSync(path.join(s.home, "skills", "abq-deploy"), { recursive: true });
  fs.writeFileSync(
    path.join(s.home, "skills", "abq-deploy", "SKILL.md"),
    "---\nname: abq-deploy\ndescription: Deploy abqary\nmetadata:\n  project: abqary-new\n---\n",
  );
  fs.writeFileSync(
    path.join(s.home, "memory", "billing.md"),
    "---\nname: billing\ndescription: billing context\nmetadata:\n  type: project\n  project: abqary-new\n---\n",
  );
  fs.writeFileSync(path.join(s.home, "state", "usage.json"), JSON.stringify({ skills: { "abq-deploy": { created: new Date().toISOString(), uses: 0, state: "active" } } }));
  const r = s.run("status");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /billing \[project\] \(abqary-new\) — billing context/);
  assert.match(r.stdout, /  Global \(every session\):\n  - deploy-api — Deploy the API/);
  assert.match(r.stdout, /  abqary-new \(only in that project\):\n  - abq-deploy — Deploy abqary\n    0 uses, last never, active, 0 active days since last use/);
});

test("audit lists untagged items that mention a known project", () => {
  const s = sandbox();
  seedStore(s);
  fs.writeFileSync(path.join(s.home, "state", "projects.json"), JSON.stringify({ "deploy-api": { activeDays: [] }, "abqary-new": { activeDays: [] } }));
  fs.writeFileSync(
    path.join(s.home, "memory", "abq-fact.md"),
    "---\nname: abq-fact\ndescription: fact about abqary-new\nmetadata:\n  type: project\n---\nx\n",
  );
  const r = s.run("audit");
  assert.match(r.stdout, /mention a known project but have no project tag[\s\S]*memory abq-fact\.md: abqary-new/);
  assert.match(r.stdout, /skill deploy-api: deploy-api/);
});

test("learn and curate pass the project and keep the index fresh", () => {
  const s = sandbox();
  s.run("setup", "--apply");
  fs.writeFileSync(path.join(s.home, "state", "sessions", "sess-p.json"), JSON.stringify({ project: "abqary-new" }));
  assert.match(s.run("learn", "--session", "sess-p", "--mode", "memory").stdout, /^Project: abqary-new$/m);
  fs.writeFileSync(path.join(s.home, "memory", "m.md"), "---\nname: m\ndescription: d\n---\n");
  assert.match(s.run("curate").stdout, /^Project: none$/m);
  assert.match(fs.readFileSync(path.join(s.home, "memory", "MEMORY.md"), "utf8"), /\[m\]\(m\.md\)/);
});
