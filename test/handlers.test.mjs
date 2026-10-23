import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { handle, contextFrom } from "../scripts/lib/handlers.mjs";
import { loadSession, saveSession, loadUsage, saveUsage, loadCurator } from "../scripts/lib/state.mjs";
import { listSkills } from "../scripts/lib/skills.mjs";

const DAY = 86400000;
const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "transcript.jsonl");
const T0 = new Date("2026-05-01T12:00:00Z");

function make({ setUp = true, env = {}, now = T0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "peka-handlers-"));
  const baseEnv = { PEKA_HOME: path.join(root, "peka"), CLAUDE_CONFIG_DIR: path.join(root, "claude"), ...env };
  const ctx = contextFrom(baseEnv, now);
  if (setUp) {
    fs.mkdirSync(ctx.d.state, { recursive: true });
    fs.writeFileSync(path.join(ctx.d.state, "setup.json"), "{}");
    handle("SessionStart", { session_id: "boot", source: "startup" }, ctx);
  }
  return ctx;
}

function dirty(home) {
  return execFileSync("git", ["status", "--porcelain", "-uall"], { cwd: home }).toString().trim();
}

function at(ctx, now) {
  return { ...ctx, now };
}

function addSkill(ctx, name) {
  fs.mkdirSync(path.join(ctx.d.skills, name), { recursive: true });
  fs.writeFileSync(path.join(ctx.d.skills, name, "SKILL.md"), `---\nname: ${name}\ndescription: t\n---\n`);
}

const stopInput = (extra = {}) => ({
  session_id: "s1",
  transcript_path: fixture,
  cwd: "/work/app",
  stop_hook_active: false,
  last_assistant_message: "Switched to pnpm.",
  background_tasks: [],
  ...extra,
});

test("before setup only SessionStart says something", () => {
  const ctx = make({ setUp: false });
  assert.match(handle("SessionStart", { session_id: "a" }, ctx).systemMessage, /\/peka:setup/);
  for (const ev of ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SubagentStop"]) {
    assert.equal(handle(ev, { session_id: "a", tool_name: "Write", tool_input: { file_path: "/x.md" } }, ctx), null);
  }
  assert.equal(fs.existsSync(ctx.d.memory), false);
});

test("garbage input is ignored", () => {
  const ctx = make();
  for (const input of [null, "x", 3, []]) assert.equal(handle("Stop", input, ctx), null);
});

test("SessionStart creates dirs and asks for a skill reload when links change", () => {
  const ctx = make();
  assert.ok(fs.existsSync(ctx.d.memory));
  assert.ok(fs.existsSync(path.join(ctx.d.home, ".git")));
  addSkill(ctx, "deploy");
  const out = handle("SessionStart", { session_id: "a" }, ctx);
  assert.equal(out.hookSpecificOutput.reloadSkills, true);
  assert.ok(fs.lstatSync(path.join(ctx.claudeSkillsDir, "deploy")).isSymbolicLink());
  assert.equal(handle("SessionStart", { session_id: "a" }, ctx).hookSpecificOutput.reloadSkills, undefined);
});

test("SessionStart briefs Claude to use the global memory", () => {
  const ctx = make();
  for (const source of ["startup", "resume", "clear", "compact"]) {
    const out = handle("SessionStart", { session_id: "a", source }, ctx).hookSpecificOutput;
    assert.equal(out.hookEventName, "SessionStart");
    const text = out.additionalContext;
    assert.ok(text.includes(ctx.d.memory), source);
    assert.match(text, /global/);
    assert.match(text, /MEMORY\.md/);
    assert.match(text, /right away/);
    assert.match(text, /\/peka:remember/);
    assert.ok(text.length < 1500, `brief is ${text.length} chars`);
  }
});

test("SessionStart runs the lifecycle at most once a day", () => {
  const ctx = make();
  addSkill(ctx, "old");
  const usage = loadUsage(ctx.d);
  usage.skills.old = { created: new Date(T0.getTime() - 40 * DAY).toISOString(), uses: 0 };
  saveUsage(ctx.d, usage);
  handle("SessionStart", { session_id: "a" }, at(ctx, new Date(T0.getTime() + 1000)));
  assert.deepEqual(listSkills(ctx.d), ["old"], "lifecycle already ran today");
  handle("SessionStart", { session_id: "a" }, at(ctx, new Date(T0.getTime() + DAY)));
  assert.deepEqual(listSkills(ctx.d), []);
});

test("UserPromptSubmit counts main-agent turns only", () => {
  const ctx = make();
  handle("UserPromptSubmit", { session_id: "s1", prompt: "hi" }, ctx);
  handle("UserPromptSubmit", { session_id: "s1", prompt: "hi" }, ctx);
  handle("UserPromptSubmit", { session_id: "s1", prompt: "hi", agent_id: "sub" }, ctx);
  assert.equal(loadSession(ctx.d, "s1").turnsSinceMemory, 2);
});

test("PreToolUse allows memory writes and denies writes through a PEKA link", () => {
  const ctx = make();
  const allow = handle("PreToolUse", { session_id: "s1", tool_name: "Write", tool_input: { file_path: path.join(ctx.d.memory, "a.md") } }, ctx);
  assert.equal(allow.hookSpecificOutput.permissionDecision, "allow");
  addSkill(ctx, "deploy");
  handle("SessionStart", { session_id: "s1" }, ctx);
  const deny = handle("PreToolUse", { session_id: "s1", agent_id: "r", tool_name: "Edit", tool_input: { file_path: path.join(ctx.claudeSkillsDir, "deploy", "SKILL.md") } }, ctx);
  assert.equal(deny.hookSpecificOutput.permissionDecision, "deny");
  assert.match(deny.hookSpecificOutput.permissionDecisionReason, /Edit the real file instead/);
  assert.equal(handle("PreToolUse", { session_id: "s1", tool_name: "Write", tool_input: { file_path: "/tmp/x.md" } }, ctx), null);
});

test("PostToolUse counts tools and resets on memory and skill writes", () => {
  const ctx = make();
  saveSession(ctx.d, "s1", { turnsSinceMemory: 5, toolsSinceSkill: 7, lastDigestLine: 0 });
  handle("PostToolUse", { session_id: "s1", tool_name: "Bash", tool_input: { command: "ls" } }, ctx);
  handle("PostToolUse", { session_id: "s1", agent_id: "x", tool_name: "Bash", tool_input: {} }, ctx);
  assert.equal(loadSession(ctx.d, "s1").toolsSinceSkill, 8);
  handle("PostToolUse", { session_id: "s1", tool_name: "Write", tool_input: { file_path: path.join(ctx.d.memory, "m.md") } }, ctx);
  assert.equal(loadSession(ctx.d, "s1").turnsSinceMemory, 0);
  addSkill(ctx, "fresh");
  handle("PostToolUse", { session_id: "s1", tool_name: "Write", tool_input: { file_path: path.join(ctx.d.skills, "fresh", "SKILL.md") } }, ctx);
  assert.equal(loadSession(ctx.d, "s1").toolsSinceSkill, 0);
  assert.ok(fs.lstatSync(path.join(ctx.claudeSkillsDir, "fresh")).isSymbolicLink());
});

test("PostToolUse records use of PEKA skills by Skill tool and by Read", () => {
  const ctx = make();
  addSkill(ctx, "deploy");
  handle("SessionStart", { session_id: "s1" }, ctx);
  handle("PostToolUse", { session_id: "s1", tool_name: "Skill", tool_input: { skill: "deploy" } }, ctx);
  handle("PostToolUse", { session_id: "s1", tool_name: "Read", tool_input: { file_path: path.join(ctx.claudeSkillsDir, "deploy", "SKILL.md") } }, ctx);
  handle("PostToolUse", { session_id: "s1", tool_name: "Skill", tool_input: { skill: "someone-else" } }, ctx);
  const usage = loadUsage(ctx.d);
  assert.equal(usage.skills.deploy.uses, 2);
  assert.equal(usage.skills["someone-else"], undefined);
});

test("Stop below the intervals does nothing", () => {
  const ctx = make();
  saveSession(ctx.d, "s1", { turnsSinceMemory: 9, toolsSinceSkill: 19, lastDigestLine: 0 });
  assert.equal(handle("Stop", stopInput(), ctx), null);
});

test("Stop at the memory interval asks for a review", () => {
  const ctx = make();
  saveSession(ctx.d, "s1", { turnsSinceMemory: 10, toolsSinceSkill: 3, lastDigestLine: 0 });
  const out = handle("Stop", stopInput(), ctx);
  const text = out.hookSpecificOutput.additionalContext;
  assert.equal(out.hookSpecificOutput.hookEventName, "Stop");
  for (const needle of ["peka:reviewer", "run_in_background: false", "sonnet", ctx.d.memory, ctx.d.skills, "Focus: memory"]) {
    assert.ok(text.includes(needle), `missing ${needle}`);
  }
  const digest = text.match(/Digest: (\S+)/)[1];
  assert.match(fs.readFileSync(digest, "utf8"), /USER: stop using npm/);
  const s = loadSession(ctx.d, "s1");
  assert.equal(s.turnsSinceMemory, 0);
  assert.equal(s.toolsSinceSkill, 3);
  assert.equal(s.lastDigestLine, 8);
});

test("Stop asks for both when both counters are due and honors the model setting", () => {
  const ctx = make({ env: { CLAUDE_PLUGIN_OPTION_REVIEWER_MODEL: "haiku" } });
  saveSession(ctx.d, "s1", { turnsSinceMemory: 10, toolsSinceSkill: 20, lastDigestLine: 0 });
  const text = handle("Stop", stopInput(), ctx).hookSpecificOutput.additionalContext;
  assert.match(text, /Focus: memory and skills/);
  assert.match(text, /haiku/);
  assert.deepEqual(loadSession(ctx.d, "s1"), { turnsSinceMemory: 0, toolsSinceSkill: 0, lastDigestLine: 8 });
});

test("Stop never fires twice for one checkpoint", () => {
  const ctx = make();
  const due = { turnsSinceMemory: 10, toolsSinceSkill: 0, lastDigestLine: 0 };
  saveSession(ctx.d, "s1", due);
  assert.equal(handle("Stop", stopInput({ stop_hook_active: true }), ctx), null);
  assert.equal(handle("Stop", stopInput({ agent_id: "sub" }), ctx), null);
  const running = [{ id: "t", type: "subagent", status: "running", agent_type: "peka:reviewer" }];
  assert.equal(handle("Stop", stopInput({ background_tasks: running }), ctx), null);
  assert.deepEqual(loadSession(ctx.d, "s1"), due);
  assert.ok(handle("Stop", stopInput(), ctx));
  assert.equal(handle("Stop", stopInput(), ctx), null);
});

test("interval 0 turns that nudge off", () => {
  const ctx = make({ env: { CLAUDE_PLUGIN_OPTION_MEMORY_INTERVAL: "0" } });
  saveSession(ctx.d, "s1", { turnsSinceMemory: 500, toolsSinceSkill: 0, lastDigestLine: 0 });
  assert.equal(handle("Stop", stopInput(), ctx), null);
});

test("curator seeds first, fires after 7 days, waits 24 h before asking again", () => {
  const ctx = make();
  assert.equal(handle("Stop", stopInput(), ctx), null);
  assert.equal(handle("Stop", stopInput(), at(ctx, new Date(T0.getTime() + 6 * DAY))), null);
  const out = handle("Stop", stopInput(), at(ctx, new Date(T0.getTime() + 7 * DAY)));
  const text = out.hookSpecificOutput.additionalContext;
  for (const needle of ["peka:curator", "opus", path.join(ctx.d.state, "curator-report.md"), "run_in_background: false"]) {
    assert.ok(text.includes(needle), `missing ${needle}`);
  }
  assert.ok(fs.existsSync(path.join(ctx.d.state, "curator-report.md")));
  assert.equal(handle("Stop", stopInput(), at(ctx, new Date(T0.getTime() + 7 * DAY + 23 * 3600000))), null);
  assert.ok(handle("Stop", stopInput(), at(ctx, new Date(T0.getTime() + 8 * DAY))));
});

test("SubagentStop for the curator applies safe actions and records the run", () => {
  const ctx = make();
  addSkill(ctx, "dup");
  addSkill(ctx, "pinned");
  addSkill(ctx, "keep");
  const usage = loadUsage(ctx.d);
  usage.skills.pinned = { pinned: true, created: T0.toISOString() };
  saveUsage(ctx.d, usage);
  handle("SessionStart", { session_id: "s1" }, ctx);
  fs.writeFileSync(path.join(ctx.d.memory, "old.md"), "x");
  fs.writeFileSync(path.join(ctx.d.memory, "MEMORY.md"), "- index");
  const outside = path.join(ctx.d.home, "outside.md");
  fs.writeFileSync(outside, "keep me");
  fs.writeFileSync(
    path.join(ctx.d.state, "curator-actions.json"),
    JSON.stringify({
      archiveSkills: ["dup", "pinned", "../keep", "missing"],
      deleteMemories: ["old.md", "MEMORY.md", "../outside.md", "notes.txt"],
    }),
  );
  const later = new Date(T0.getTime() + 3600000);
  assert.equal(handle("SubagentStop", { session_id: "s1", agent_id: "c", agent_type: "peka:curator" }, at(ctx, later)), null);
  assert.deepEqual(listSkills(ctx.d), ["keep", "pinned"]);
  assert.ok(fs.existsSync(path.join(ctx.d.archive, "dup", "SKILL.md")));
  assert.equal(fs.existsSync(path.join(ctx.claudeSkillsDir, "dup")), false);
  assert.equal(fs.existsSync(path.join(ctx.d.memory, "old.md")), false);
  assert.equal(fs.readFileSync(path.join(ctx.d.home, "archive", "memory", "old.md"), "utf8"), "x");
  assert.ok(fs.existsSync(path.join(ctx.d.memory, "MEMORY.md")));
  assert.ok(fs.existsSync(outside));
  assert.equal(fs.existsSync(path.join(ctx.d.state, "curator-actions.json")), false);
  assert.equal(loadCurator(ctx.d).lastRunAt, later.toISOString());
});

test("SubagentStop for the reviewer prunes old digests and commits", () => {
  const ctx = make();
  const old = path.join(ctx.d.digests, "old.md");
  const fresh = path.join(ctx.d.digests, "fresh.md");
  fs.writeFileSync(old, "x");
  fs.writeFileSync(fresh, "x");
  const eightDaysAgo = new Date(T0.getTime() - 8 * DAY);
  fs.utimesSync(old, eightDaysAgo, eightDaysAgo);
  fs.utimesSync(fresh, T0, T0);
  fs.writeFileSync(path.join(ctx.d.memory, "learned.md"), "fact");
  handle("SubagentStop", { session_id: "s1", agent_id: "r", agent_type: "peka:reviewer" }, ctx);
  assert.equal(fs.existsSync(old), false);
  assert.ok(fs.existsSync(fresh));
  assert.equal(dirty(ctx.d.home), "");
  assert.equal(loadCurator(ctx.d).lastRunAt, null);
  assert.equal(handle("SubagentStop", { session_id: "s1", agent_id: "o", agent_type: "Explore" }, ctx), null);
});

test("SubagentStop respects auto_commit off", () => {
  const ctx = make({ env: { CLAUDE_PLUGIN_OPTION_AUTO_COMMIT: "false" } });
  fs.writeFileSync(path.join(ctx.d.memory, "learned.md"), "fact");
  handle("SubagentStop", { session_id: "s1", agent_id: "r", agent_type: "peka:reviewer" }, ctx);
  assert.match(dirty(ctx.d.home), /learned\.md/);
});

test("SessionStart saves the effective config for the CLI", () => {
  const ctx = make({ env: { CLAUDE_PLUGIN_OPTION_CURATOR_MODEL: "sonnet" } });
  const saved = JSON.parse(fs.readFileSync(path.join(ctx.d.state, "config.json"), "utf8"));
  assert.equal(saved.curatorModel, "sonnet");
  assert.equal(saved.reviewerModel, "sonnet");
  assert.equal(saved.memoryInterval, 10);
});

test("PEKA_DISABLE turns every hook off", () => {
  const ctx = make({ env: { PEKA_DISABLE: "1" } });
  saveSession(ctx.d, "s1", { turnsSinceMemory: 50, toolsSinceSkill: 50, lastDigestLine: 0 });
  assert.equal(handle("Stop", stopInput(), ctx), null);
  assert.equal(handle("SessionStart", { session_id: "a" }, ctx), null);
  handle("UserPromptSubmit", { session_id: "s1" }, ctx);
  assert.equal(loadSession(ctx.d, "s1").turnsSinceMemory, 50);
});

test("a skill the user types as /name counts as used", () => {
  const ctx = make();
  addSkill(ctx, "deploy");
  const expand = (name) => handle("UserPromptExpansion", { session_id: "s1", expansion_type: "slash_command", command_name: name, prompt: `/${name}` }, ctx);
  assert.equal(expand("deploy"), null);
  expand("peka:status");
  assert.equal(loadUsage(ctx.d).skills.deploy.uses, 1);
  assert.equal(loadUsage(ctx.d).skills["peka:status"], undefined);
});

test("PreToolUse passes the agent type to the guard", () => {
  const ctx = make();
  const input = (agent_type) => ({ session_id: "s1", agent_id: agent_type ? "a1" : undefined, agent_type, tool_name: "Write", tool_input: { file_path: path.join(ctx.d.skills, "n", "SKILL.md"), content: "---\nname: n\ndescription: d\n---\n" } });
  assert.equal(handle("PreToolUse", input("peka:reviewer"), ctx).hookSpecificOutput.permissionDecision, "allow");
  assert.equal(handle("PreToolUse", input(undefined), ctx), null);
});

test("PostToolUse still resets the skill counter when the user approved a skill write", () => {
  const ctx = make();
  saveSession(ctx.d, "s1", { turnsSinceMemory: 0, toolsSinceSkill: 7, lastDigestLine: 0 });
  addSkill(ctx, "mine");
  handle("PostToolUse", { session_id: "s1", tool_name: "Write", tool_input: { file_path: path.join(ctx.d.skills, "mine", "SKILL.md") } }, ctx);
  assert.equal(loadSession(ctx.d, "s1").toolsSinceSkill, 0);
});

test("launch instructions run the agent in the foreground, end in one line, and handle inherit", () => {
  const ctx = make({ env: { CLAUDE_PLUGIN_OPTION_REVIEWER_MODEL: "inherit" } });
  saveSession(ctx.d, "s1", { turnsSinceMemory: 10, toolsSinceSkill: 0, lastDigestLine: 0 });
  const text = handle("Stop", stopInput(), ctx).hookSpecificOutput.additionalContext;
  assert.match(text, /same model you are running on/);
  assert.doesNotMatch(text, /Do not set a model/);
  assert.match(text, /run_in_background: false and wait for it/);
  assert.doesNotMatch(text, /run_in_background: true|do not wait/);
  assert.match(text, /end your turn with exactly one short line/);
});

test("headless runs never get a checkpoint, interactive hosts still do", () => {
  for (const entrypoint of ["sdk-cli", "claude-code-github-action", "mcp"]) {
    const ctx = make({ env: { CLAUDE_CODE_ENTRYPOINT: entrypoint } });
    saveSession(ctx.d, "s1", { turnsSinceMemory: 10, toolsSinceSkill: 20, lastDigestLine: 0 });
    assert.equal(handle("Stop", stopInput(), ctx), null, entrypoint);
    assert.equal(handle("Stop", stopInput(), at(ctx, new Date(T0.getTime() + 30 * DAY))), null, `${entrypoint} curator`);
  }
  for (const entrypoint of ["cli", "sdk-ts", "claude-vscode", undefined]) {
    const ctx = make({ env: entrypoint ? { CLAUDE_CODE_ENTRYPOINT: entrypoint } : {} });
    saveSession(ctx.d, "s1", { turnsSinceMemory: 10, toolsSinceSkill: 0, lastDigestLine: 0 });
    assert.ok(handle("Stop", stopInput(), ctx), String(entrypoint));
  }
});

test("SubagentStop for the learner applies its actions without counting as a curator run", () => {
  const ctx = make();
  fs.writeFileSync(path.join(ctx.d.memory, "deploy-steps.md"), "1. a\n2. b\n3. c\n");
  fs.writeFileSync(path.join(ctx.d.state, "learner-actions.json"), JSON.stringify({ deleteMemories: ["deploy-steps.md"] }));
  fs.writeFileSync(path.join(ctx.d.state, "curator-actions.json"), JSON.stringify({ deleteMemories: ["keep.md"] }));
  fs.writeFileSync(path.join(ctx.d.memory, "keep.md"), "x");
  addSkill(ctx, "deploy");
  handle("SubagentStop", { session_id: "s1", agent_id: "l", agent_type: "peka:learner" }, ctx);
  assert.equal(fs.existsSync(path.join(ctx.d.memory, "deploy-steps.md")), false);
  assert.ok(fs.existsSync(path.join(ctx.d.home, "archive", "memory", "deploy-steps.md")));
  assert.ok(fs.existsSync(path.join(ctx.d.memory, "keep.md")), "the curator's pending actions are not the learner's");
  assert.ok(fs.existsSync(path.join(ctx.d.state, "curator-actions.json")));
  assert.ok(fs.lstatSync(path.join(ctx.claudeSkillsDir, "deploy")).isSymbolicLink());
  assert.equal(dirty(ctx.d.home), "");
  assert.equal(loadCurator(ctx.d).lastRunAt, null);
});

test("a skill written straight into ~/.claude/skills gets flagged", () => {
  const ctx = make();
  const dir = path.join(ctx.claudeSkillsDir, "deploy-staging");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: deploy-staging\ndescription: d\n---\n");
  const out = handle("PostToolUse", { session_id: "s1", tool_name: "Write", tool_input: { file_path: path.join(dir, "SKILL.md") } }, ctx);
  assert.equal(out.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.match(out.hookSpecificOutput.additionalContext, /outside PEKA/);
  assert.match(out.hookSpecificOutput.additionalContext, /\/peka:audit adopt deploy-staging/);
  assert.equal(handle("PostToolUse", { session_id: "s1", tool_name: "Read", tool_input: { file_path: path.join(dir, "SKILL.md") } }, ctx), null);
  assert.equal(handle("PostToolUse", { session_id: "s1", tool_name: "Write", tool_input: { file_path: path.join(dir, "notes.md") } }, ctx), null);
});

test("the session brief routes teaching through PEKA", () => {
  const ctx = make();
  const text = handle("SessionStart", { session_id: "a" }, ctx).hookSpecificOutput.additionalContext;
  assert.match(text, /\/peka:remember/);
  assert.match(text, /\/peka:skill/);
  assert.match(text, /do not write skills into ~\/\.claude\/skills unless the user asks for a personal skill there/i);
  assert.match(text, /correct.*save.*memory.*yourself/i);
});

function gitRepo(name) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "peka-proj-")), name);
  fs.mkdirSync(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

function memoryFile(ctx, name, project) {
  const meta = project ? `metadata:\n  type: project\n  project: ${project}\n` : "metadata:\n  type: user\n";
  fs.writeFileSync(path.join(ctx.d.memory, `${name}.md`), `---\nname: ${name}\ndescription: about ${name}\n${meta}---\nBody.\n`);
}

test("SessionStart remembers the project, marks it active, and briefs its memories", () => {
  const ctx = make();
  const cwd = gitRepo("Abqary-New");
  memoryFile(ctx, "abq-deploy", "abqary-new");
  memoryFile(ctx, "global-pref");
  const text = handle("SessionStart", { session_id: "p1", cwd }, ctx).hookSpecificOutput.additionalContext;
  assert.equal(loadSession(ctx.d, "p1").project, "abqary-new");
  assert.match(text, /Current project: abqary-new\. Its memories/);
  assert.match(text, /- \[abq-deploy\]\(abq-deploy\.md\) — about abq-deploy/);
  assert.doesNotMatch(text, /global-pref/);
  const projects = JSON.parse(fs.readFileSync(path.join(ctx.d.state, "projects.json"), "utf8"));
  assert.equal(projects["abqary-new"].activeDays.length, 1);
  const index = fs.readFileSync(path.join(ctx.d.memory, "MEMORY.md"), "utf8");
  assert.match(index, /- \[global-pref\]\(global-pref\.md\)/);
  assert.match(index, /- abqary-new: 1 memory/);
});

test("SessionStart names a project without memories and stays quiet in the home folder", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "peka-userhome-"));
  const ctx = make({ env: { HOME: home } });
  const empty = handle("SessionStart", { session_id: "p2", cwd: gitRepo("fresh") }, ctx).hookSpecificOutput.additionalContext;
  assert.match(empty, /Current project: fresh \(no memories yet\)\. Tag project-specific memories with metadata\.project: fresh\./);
  const atHome = handle("SessionStart", { session_id: "p3", cwd: home }, ctx).hookSpecificOutput.additionalContext;
  assert.doesNotMatch(atHome, /Current project/);
  assert.equal(loadSession(ctx.d, "p3").project, null);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(ctx.d.state, "projects.json"), "utf8"))), ["fresh"]);
});

test("UserPromptSubmit marks the session project active each day", () => {
  const ctx = make();
  const cwd = gitRepo("wajom-client");
  handle("SessionStart", { session_id: "p4", cwd }, ctx);
  handle("UserPromptSubmit", { session_id: "p4", prompt: "hi", cwd }, at(ctx, new Date(T0.getTime() + 2 * DAY)));
  handle("UserPromptSubmit", { session_id: "old", prompt: "hi", cwd }, at(ctx, new Date(T0.getTime() + 3 * DAY)));
  const days = JSON.parse(fs.readFileSync(path.join(ctx.d.state, "projects.json"), "utf8"))["wajom-client"].activeDays;
  assert.equal(days.length, 3);
  assert.equal(loadSession(ctx.d, "old").project, "wajom-client");
});

test("a memory written in the main session rebuilds the index", () => {
  const ctx = make();
  memoryFile(ctx, "fresh-fact");
  fs.writeFileSync(path.join(ctx.d.memory, "MEMORY.md"), "- [Hand](fresh-fact.md) — hand\n");
  handle("PostToolUse", { session_id: "s1", tool_name: "Write", tool_input: { file_path: path.join(ctx.d.memory, "fresh-fact.md") } }, ctx);
  const index = fs.readFileSync(path.join(ctx.d.memory, "MEMORY.md"), "utf8");
  assert.match(index, /^<!-- Generated by PEKA/);
  assert.match(index, /- \[fresh-fact\]\(fresh-fact\.md\) — about fresh-fact/);
});

test("SubagentStop rebuilds the index before committing", () => {
  const ctx = make();
  memoryFile(ctx, "learned", "abqary-new");
  handle("SubagentStop", { session_id: "s1", agent_id: "r", agent_type: "peka:reviewer" }, ctx);
  assert.ok(fs.existsSync(path.join(ctx.d.memory, "projects", "abqary-new.md")));
  assert.equal(dirty(ctx.d.home), "");
});

test("the reviewer and curator prompts carry the project line", () => {
  const ctx = make();
  const cwd = gitRepo("sihipam");
  handle("SessionStart", { session_id: "s1", cwd }, ctx);
  saveSession(ctx.d, "s1", { ...loadSession(ctx.d, "s1"), turnsSinceMemory: 10 });
  const review = handle("Stop", stopInput({ cwd }), ctx).hookSpecificOutput.additionalContext;
  assert.match(review, /^Project: sihipam$/m);
  saveSession(ctx.d, "s2", { turnsSinceMemory: 10, toolsSinceSkill: 0, lastDigestLine: 0 });
  const other = handle("Stop", stopInput({ session_id: "s2" }), ctx).hookSpecificOutput.additionalContext;
  assert.match(other, /^Project: none$/m);
  handle("Stop", stopInput({ session_id: "s3" }), ctx);
  const curator = handle("Stop", stopInput({ session_id: "s3" }), at(ctx, new Date(T0.getTime() + 8 * DAY))).hookSpecificOutput.additionalContext;
  assert.match(curator, /peka:curator/);
  assert.match(curator, /^Project: none$/m);
});

test("learning_notice each reports what the agent saved", () => {
  const ctx = make({ env: { CLAUDE_PLUGIN_OPTION_LEARNING_NOTICE: "each" } });
  memoryFile(ctx, "prefers-pnpm");
  fs.mkdirSync(path.join(ctx.d.skills, "deploy"), { recursive: true });
  fs.writeFileSync(path.join(ctx.d.skills, "deploy", "SKILL.md"), "---\nname: deploy\ndescription: t\n---\n");
  const out = handle("SubagentStop", { session_id: "s1", agent_id: "r", agent_type: "peka:reviewer" }, ctx);
  assert.equal(out.systemMessage, "PEKA: memory prefers-pnpm added; skill deploy added.");
  assert.equal(handle("SubagentStop", { session_id: "s1", agent_id: "r", agent_type: "peka:reviewer" }, ctx), null);
});

test("learning_notice each stays silent without commits", () => {
  const ctx = make({ env: { CLAUDE_PLUGIN_OPTION_LEARNING_NOTICE: "each", CLAUDE_PLUGIN_OPTION_AUTO_COMMIT: "false" } });
  memoryFile(ctx, "x");
  assert.equal(handle("SubagentStop", { session_id: "s1", agent_id: "r", agent_type: "peka:reviewer" }, ctx), null);
  const noGit = make({ env: { CLAUDE_PLUGIN_OPTION_LEARNING_NOTICE: "each" } });
  fs.rmSync(path.join(noGit.d.home, ".git"), { recursive: true });
  memoryFile(noGit, "y");
  assert.equal(handle("SubagentStop", { session_id: "s1", agent_id: "r", agent_type: "peka:reviewer" }, noGit), null);
});

test("learning_notice weekly seeds silently, then summarizes a week of changes", () => {
  const ctx = make();
  assert.equal(handle("SessionStart", { session_id: "w" }, ctx).systemMessage, undefined);
  memoryFile(ctx, "a");
  handle("SubagentStop", { session_id: "w", agent_id: "r", agent_type: "peka:reviewer" }, ctx);
  assert.equal(handle("SessionStart", { session_id: "w" }, at(ctx, new Date(T0.getTime() + 6 * DAY))).systemMessage, undefined);
  const out = handle("SessionStart", { session_id: "w" }, at(ctx, new Date(T0.getTime() + 8 * DAY)));
  assert.equal(out.systemMessage, "PEKA this week: +1 memory. Details: /peka:status log");
  assert.ok(out.hookSpecificOutput.additionalContext);
  assert.equal(handle("SessionStart", { session_id: "w" }, at(ctx, new Date(T0.getTime() + 16 * DAY))).systemMessage, undefined);
});

test("learning_notice weekly re-seeds when its commit is gone", () => {
  const ctx = make();
  fs.writeFileSync(path.join(ctx.d.state, "notice.json"), JSON.stringify({ lastNoticeAt: T0.toISOString(), lastNoticeCommit: "f".repeat(40) }));
  memoryFile(ctx, "a");
  handle("SubagentStop", { session_id: "w", agent_id: "r", agent_type: "peka:reviewer" }, ctx);
  const later = new Date(T0.getTime() + 8 * DAY);
  assert.equal(handle("SessionStart", { session_id: "w" }, at(ctx, later)).systemMessage, undefined);
  assert.equal(JSON.parse(fs.readFileSync(path.join(ctx.d.state, "notice.json"), "utf8")).lastNoticeAt, later.toISOString());
});

test("learning_notice off never speaks", () => {
  const ctx = make({ env: { CLAUDE_PLUGIN_OPTION_LEARNING_NOTICE: "off" } });
  memoryFile(ctx, "a");
  assert.equal(handle("SubagentStop", { session_id: "w", agent_id: "r", agent_type: "peka:reviewer" }, ctx), null);
  assert.equal(handle("SessionStart", { session_id: "w" }, at(ctx, new Date(T0.getTime() + 30 * DAY))).systemMessage, undefined);
});
