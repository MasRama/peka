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
  assert.equal(handle("SessionStart", { session_id: "a" }, ctx), null);
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

test("Stop at the memory interval asks for a background review", () => {
  const ctx = make();
  saveSession(ctx.d, "s1", { turnsSinceMemory: 10, toolsSinceSkill: 3, lastDigestLine: 0 });
  const out = handle("Stop", stopInput(), ctx);
  const text = out.hookSpecificOutput.additionalContext;
  assert.equal(out.hookSpecificOutput.hookEventName, "Stop");
  for (const needle of ["peka:reviewer", "run_in_background", "sonnet", ctx.d.memory, ctx.d.skills, "Focus: memory"]) {
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
  for (const needle of ["peka:curator", "opus", path.join(ctx.d.state, "curator-report.md"), "run_in_background"]) {
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

test("launch instructions keep the main agent quiet and handle inherit", () => {
  const ctx = make({ env: { CLAUDE_PLUGIN_OPTION_REVIEWER_MODEL: "inherit" } });
  saveSession(ctx.d, "s1", { turnsSinceMemory: 10, toolsSinceSkill: 0, lastDigestLine: 0 });
  const text = handle("Stop", stopInput(), ctx).hookSpecificOutput.additionalContext;
  assert.match(text, /same model you are running on/);
  assert.doesNotMatch(text, /Do not set a model/);
  assert.match(text, /When the agent finishes, do not comment on it/);
});
