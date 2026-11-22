import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { isDevinRuntime, devinHome, devinSessionsDb, dirs, ensureDirs } from "../scripts/lib/paths.mjs";
import { loadConfig, loadFileConfig } from "../scripts/lib/config.mjs";
import { classify } from "../scripts/lib/guard.mjs";
import { handle, contextFrom } from "../scripts/lib/handlers.mjs";
import { loadSession, saveSession, loadUsage, loadCurator, lastSessionFor } from "../scripts/lib/state.mjs";
import {
  buildDevinDigest,
  entriesForDevinMessage,
  findLatestDevinSession,
  hasDevinSession,
  searchDevinTranscripts,
} from "../scripts/lib/devin-sessions.mjs";
import { searchTranscripts } from "../scripts/lib/search.mjs";
import { listSkills } from "../scripts/lib/skills.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "scripts", "peka.mjs");
const T0 = new Date("2026-06-01T12:00:00Z");

function openWritableDb(dbPath) {
  const orig = process.emitWarning;
  process.emitWarning = (w, ...args) => {
    const msg = typeof w === "string" ? w : w?.message ?? "";
    if (msg.includes("SQLite is an experimental feature")) return;
    return orig.call(process, w, ...args);
  };
  try {
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        working_directory TEXT NOT NULL,
        backend_type TEXT NOT NULL DEFAULT 'local',
        model TEXT NOT NULL DEFAULT 'swe',
        agent_mode TEXT NOT NULL DEFAULT 'code',
        created_at INTEGER NOT NULL,
        last_activity_at INTEGER NOT NULL,
        main_chain_id INTEGER
      );
      CREATE TABLE IF NOT EXISTS message_nodes (
        row_id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        node_id INTEGER NOT NULL,
        parent_node_id INTEGER,
        chat_message TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    return db;
  } finally {
    process.emitWarning = orig;
  }
}

function seedDevinDb(dbPath, sessions) {
  const db = openWritableDb(dbPath);
  const insSess = db.prepare(
    "INSERT INTO sessions (id, working_directory, created_at, last_activity_at, main_chain_id) VALUES (?, ?, ?, ?, ?)",
  );
  const insNode = db.prepare(
    "INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  for (const s of sessions) {
    insSess.run(s.id, s.cwd, s.ts, s.ts, s.head ?? null);
    for (const n of s.nodes) {
      insNode.run(s.id, n.id, n.parent ?? null, JSON.stringify(n.msg), s.ts);
    }
  }
  db.close();
}

function makeDevinCtx({ setUp = true, env = {}, now = T0, cwd } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "peka-devin-"));
  const workDir = cwd ?? path.join(tmp, "work");
  fs.mkdirSync(workDir, { recursive: true });
  const baseEnv = {
    PEKA_HOME: path.join(tmp, "peka"),
    CLAUDE_CONFIG_DIR: path.join(tmp, "claude"),
    DEVIN_CONFIG_DIR: path.join(tmp, "devin"),
    DEVIN_SESSIONS_DIR: path.join(tmp, "devin-sessions"),
    DEVIN_PLUGIN_ROOT: root,
    DEVIN_PROJECT_DIR: workDir,
    ...env,
  };
  const ctx = contextFrom(baseEnv, now);
  if (setUp) {
    fs.mkdirSync(ctx.d.state, { recursive: true });
    fs.writeFileSync(path.join(ctx.d.state, "setup.json"), JSON.stringify({ runtime: "devin" }));
    handle("SessionStart", { session_id: "boot-devin", source: "startup" }, ctx);
  }
  return { tmp, workDir, env: baseEnv, ctx };
}

test("isDevinRuntime, devinHome, devinSessionsDb, and file config work cleanly", () => {
  assert.equal(isDevinRuntime({}), false);
  assert.equal(isDevinRuntime({ DEVIN_PLUGIN_ROOT: "/p" }), true);
  assert.equal(isDevinRuntime({ DEVIN_PROJECT_DIR: "/w" }), true);
  assert.equal(isDevinRuntime({ AI_AGENT: "devin_3000_agent" }), true);
  assert.equal(devinHome({ DEVIN_CONFIG_DIR: "/tmp/dcfg" }), "/tmp/dcfg");
  assert.equal(devinSessionsDb({ DEVIN_SESSIONS_DIR: "/tmp/dsess" }), "/tmp/dsess/sessions.db");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "peka-cfg-"));
  const d = dirs(path.join(tmp, "peka"));
  ensureDirs(d);
  fs.writeFileSync(
    path.join(d.home, "config.json"),
    JSON.stringify({ memory_interval: 4, skill_interval: 25, learning_notice: "each", auto_commit: false }),
  );
  const fromFile = loadConfig({}, loadFileConfig(d));
  assert.equal(fromFile.memoryInterval, 4);
  assert.equal(fromFile.skillInterval, 25);
  assert.equal(fromFile.learningNotice, "each");
  assert.equal(fromFile.autoCommit, false);
  const envWins = loadConfig({ PEKA_MEMORY_INTERVAL: "7" }, loadFileConfig(d));
  assert.equal(envWins.memoryInterval, 7);
});

test("devin-sessions walks main_chain_id, strips T3/Devin wrappers, and skips abandoned branches", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "peka-db-"));
  const dbPath = path.join(tmp, "sessions.db");
  seedDevinDb(dbPath, [
    {
      id: "swift-otter",
      cwd: "/work/shop",
      ts: Date.parse("2026-06-01T10:00:00Z"),
      head: 5,
      nodes: [
        { id: 1, parent: null, msg: { role: "system", content: "sys prompt" } },
        {
          id: 2,
          parent: 1,
          msg: {
            role: "user",
            content:
              "<t3_code_instructions>internal</t3_code_instructions><user_request>Stop using npm, always use pnpm here.</user_request><runtime_info>meta</runtime_info>",
            metadata: { is_user_input: true, telemetry: { source: "user" } },
          },
        },
        {
          id: 3,
          parent: 2,
          msg: {
            role: "assistant",
            content: "Switching to pnpm now.",
            tool_calls: [{ name: "exec", arguments: { command: "pnpm test" } }],
          },
        },
        {
          id: 4,
          parent: 3,
          msg: { role: "tool", content: "Error: lockfile mismatch\nExit code: 1" },
        },
        {
          id: 99,
          parent: 2,
          msg: { role: "user", content: "ABANDONED BRANCH TEXT", metadata: { is_user_input: true } },
        },
        {
          id: 5,
          parent: 4,
          msg: { role: "assistant", content: "Fixed lockfile and tests pass." },
        },
      ],
    },
  ]);

  assert.equal(hasDevinSession(dbPath, "swift-otter"), true);
  assert.equal(hasDevinSession(dbPath, "missing"), false);
  assert.equal(findLatestDevinSession(dbPath, "/work/shop")?.id, "swift-otter");

  const full = buildDevinDigest(dbPath, "swift-otter", 0);
  assert.equal(full.toLine, 5);
  assert.match(full.text, /USER: Stop using npm, always use pnpm here\./);
  assert.match(full.text, /ASSISTANT: Switching to pnpm now\./);
  assert.match(full.text, /TOOL exec: \{"command":"pnpm test"\}/);
  assert.match(full.text, /\[tool error\] Error: lockfile mismatch/);
  assert.match(full.text, /ASSISTANT: Fixed lockfile and tests pass\./);
  assert.ok(!full.text.includes("ABANDONED BRANCH TEXT"));
  assert.ok(!full.text.includes("t3_code_instructions"));
  assert.ok(!full.text.includes("runtime_info"));

  const inc = buildDevinDigest(dbPath, "swift-otter", 3);
  assert.equal(inc.toLine, 5);
  assert.ok(!inc.text.includes("Stop using npm"));
  assert.match(inc.text, /Fixed lockfile/);

  const hits = searchDevinTranscripts(dbPath, ["pnpm", "stop"]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].session, "swift-otter");
  assert.equal(hits[0].project, "shop");
  assert.equal(entriesForDevinMessage({ role: "user", content: "hidden", metadata: { is_user_input: false } }).length, 0);
});

test("searchTranscripts merges Claude and Devin sessions newest first", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "peka-merge-search-"));
  const claudeDir = path.join(tmp, "claude");
  const projDir = path.join(claudeDir, "projects", "-work-old");
  fs.mkdirSync(projDir, { recursive: true });
  const claudeFile = path.join(projDir, "c1.jsonl");
  fs.writeFileSync(claudeFile, JSON.stringify({ type: "user", message: { content: "caddy reverse proxy config" } }) + "\n");
  const tOld = new Date("2026-01-10T00:00:00Z");
  fs.utimesSync(claudeFile, tOld, tOld);

  const dbPath = path.join(tmp, "sessions.db");
  seedDevinDb(dbPath, [
    {
      id: "d1",
      cwd: "/work/newapp",
      ts: Date.parse("2026-06-15T00:00:00Z"),
      head: 1,
      nodes: [{ id: 1, parent: null, msg: { role: "user", content: "caddy reverse proxy deploy" } }],
    },
  ]);

  const hits = searchTranscripts(claudeDir, ["caddy", "proxy"], { devinDbPath: dbPath });
  assert.deepEqual(
    hits.map((h) => h.session),
    ["d1", "c1"],
  );
});

test("guard classifies Devin lowercase tools identically to Claude tools", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "peka-dguard-"));
  const d = dirs(path.join(tmp, "peka"));
  ensureDirs(d);
  const devinSkills = path.join(tmp, "devin", "skills");
  fs.mkdirSync(devinSkills, { recursive: true });

  assert.equal(classify("write", { file_path: path.join(d.memory, "a.md"), content: "ok" }, d, devinSkills).decision, "allow");
  assert.equal(classify("read", { file_path: path.join(d.memory, "MEMORY.md") }, d, devinSkills).decision, "allow");
  assert.equal(classify("find_file_by_name", { path: d.skills, pattern: "*" }, d, devinSkills).decision, "allow");

  const skillFile = path.join(d.skills, "deploy", "SKILL.md");
  const plainSkill = "---\nname: deploy\ndescription: d\n---\nSteps\n";
  assert.equal(classify("write", { file_path: skillFile, content: plainSkill }, d, devinSkills, "peka:reviewer").decision, "allow");
  assert.equal(classify("write", { file_path: skillFile, content: plainSkill }, d, devinSkills, undefined).decision, null);
  assert.equal(
    classify("write", { file_path: path.join(d.memory, "big.md"), content: "x".repeat(3000) }, d, devinSkills, "peka:reviewer").decision,
    "deny",
  );
});

test("Devin SessionStart injects MEMORY.md, syncs ~/.config/devin/skills & .devin/skills, and PostCompact re-injects", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "peka-devin-repo-"));
  const repoDir = path.join(tmp, "shop");
  fs.mkdirSync(repoDir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repoDir });

  const { ctx } = makeDevinCtx({ cwd: repoDir });
  fs.writeFileSync(
    path.join(ctx.d.memory, "prefers-pnpm.md"),
    "---\nname: prefers-pnpm\ndescription: Always use pnpm\nmetadata:\n  type: feedback\n---\nUse pnpm.\n",
  );
  fs.mkdirSync(path.join(ctx.d.skills, "global-skill"), { recursive: true });
  fs.writeFileSync(path.join(ctx.d.skills, "global-skill", "SKILL.md"), "---\nname: global-skill\ndescription: g\n---\n");
  fs.mkdirSync(path.join(ctx.d.skills, "shop-deploy"), { recursive: true });
  fs.writeFileSync(
    path.join(ctx.d.skills, "shop-deploy", "SKILL.md"),
    "---\nname: shop-deploy\ndescription: d\nmetadata:\n  project: shop\n---\n",
  );

  const out = handle("SessionStart", { session_id: "devin-s1", source: "startup" }, ctx);
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  assert.equal(out.hookSpecificOutput.reloadSkills, undefined);
  assert.match(out.hookSpecificOutput.additionalContext, /## Global memory index \(MEMORY\.md\)/);
  assert.match(out.hookSpecificOutput.additionalContext, /Always use pnpm/);
  assert.match(out.hookSpecificOutput.additionalContext, /peka\.mjs/);

  assert.ok(fs.lstatSync(path.join(ctx.devinSkillsDir, "global-skill")).isSymbolicLink());
  assert.equal(fs.existsSync(path.join(ctx.devinSkillsDir, "shop-deploy")), false);
  assert.ok(fs.lstatSync(path.join(repoDir, ".devin", "skills", "shop-deploy")).isSymbolicLink());
  assert.equal(execFileSync("git", ["status", "--porcelain", "-uall"], { cwd: repoDir }).toString().trim(), "");
  assert.equal(lastSessionFor(ctx.d, repoDir), "devin-s1");

  const compact = handle("PostCompact", { session_id: "devin-s1" }, ctx);
  assert.equal(compact.hookSpecificOutput.hookEventName, "PostCompact");
  assert.match(compact.hookSpecificOutput.additionalContext, /Always use pnpm/);
});

test("Devin PreToolUse, PermissionRequest, and PostToolUse bracket run_subagent cleanly", () => {
  const { ctx } = makeDevinCtx({ env: { PEKA_LEARNING_NOTICE: "each" } });
  const skillFile = path.join(ctx.d.skills, "new-skill", "SKILL.md");
  const skillContent = "---\nname: new-skill\ndescription: Reusable deploy\n---\n1. run\n";

  // Main agent writing a skill is NOT auto-approved by PermissionRequest.
  assert.equal(
    handle(
      "PermissionRequest",
      { session_id: "s1", prompt_id: "p1", tool_name: "write", tool_input: { file_path: skillFile, content: skillContent } },
      ctx,
    ),
    null,
  );

  // Foreground peka:reviewer starts via run_subagent.
  assert.equal(
    handle(
      "PreToolUse",
      { session_id: "s1", prompt_id: "p1", tool_name: "run_subagent", tool_input: { profile: "peka:reviewer", is_background: false } },
      ctx,
    ),
    null,
  );

  // Inside foreground peka:reviewer: PermissionRequest approves plain skill write!
  assert.deepEqual(
    handle(
      "PermissionRequest",
      { session_id: "s1", prompt_id: "p1", tool_name: "write", tool_input: { file_path: skillFile, content: skillContent } },
      ctx,
    ),
    { decision: "approve" },
  );

  // Inside foreground peka:reviewer: PreToolUse blocks oversized write with decision: "block"!
  const blocked = handle(
    "PreToolUse",
    { session_id: "s1", prompt_id: "p1", tool_name: "write", tool_input: { file_path: skillFile, content: "x".repeat(7000) } },
    ctx,
  );
  assert.equal(blocked.decision, "block");
  assert.match(blocked.reason, /6000 characters/);

  // Simulate reviewer writing the skill and completing its internal tool call.
  fs.mkdirSync(path.dirname(skillFile), { recursive: true });
  fs.writeFileSync(skillFile, skillContent);
  saveSession(ctx.d, "s1", { ...loadSession(ctx.d, "s1"), toolsSinceSkill: 5 });
  handle("PostToolUse", { session_id: "s1", prompt_id: "p1", tool_name: "write", tool_input: { file_path: skillFile } }, ctx);
  assert.equal(loadSession(ctx.d, "s1").toolsSinceSkill, 5, "subagent internal tools do not bump main counter");

  // Foreground peka:reviewer finishes -> PostToolUse(run_subagent) runs finishPekaAgent!
  const done = handle(
    "PostToolUse",
    {
      session_id: "s1",
      prompt_id: "p1",
      tool_name: "run_subagent",
      tool_input: { profile: "peka:reviewer", is_background: false },
      tool_response: { success: true, output: "Saved 1 skill." },
    },
    ctx,
  );
  assert.equal(loadSession(ctx.d, "s1").activeAgent, undefined);
  assert.ok(fs.lstatSync(path.join(ctx.devinSkillsDir, "new-skill")).isSymbolicLink());
  assert.equal(execFileSync("git", ["status", "--porcelain", "-uall"], { cwd: ctx.d.home }).toString().trim(), "");
  assert.match(done.hookSpecificOutput.additionalContext, /PEKA: skill new-skill added\./);

  // After subagent finishes, main agent writing a skill is no longer auto-approved.
  assert.equal(
    handle(
      "PermissionRequest",
      { session_id: "s1", prompt_id: "p1", tool_name: "write", tool_input: { file_path: skillFile, content: skillContent } },
      ctx,
    ),
    null,
  );

  // PermissionRequest auto-approves safe peka.mjs CLI invocations, but rejects chained commands or setup --apply.
  assert.deepEqual(
    handle(
      "PermissionRequest",
      { session_id: "s1", prompt_id: "p1", tool_name: "exec", tool_input: { command: `node "${cli}" learn --mode decide` } },
      ctx,
    ),
    { decision: "approve" },
  );
  assert.equal(
    handle(
      "PermissionRequest",
      { session_id: "s1", prompt_id: "p1", tool_name: "exec", tool_input: { command: `node "${cli}" setup --apply` } },
      ctx,
    ),
    null,
  );
  assert.equal(
    handle(
      "PermissionRequest",
      { session_id: "s1", prompt_id: "p1", tool_name: "exec", tool_input: { command: `node "${cli}" status && rm -rf /` } },
      ctx,
    ),
    null,
  );
});

test("Devin Stop uses sessions.db digest and returns decision: block with run_subagent instruction", () => {
  const { ctx, workDir } = makeDevinCtx();
  seedDevinDb(ctx.devinDbPath, [
    {
      id: "devin-s2",
      cwd: workDir,
      ts: T0.getTime(),
      head: 2,
      nodes: [
        { id: 1, parent: null, msg: { role: "user", content: "Always run pnpm lint before commit." } },
        { id: 2, parent: 1, msg: { role: "assistant", content: "Got it, will run pnpm lint." } },
      ],
    },
  ]);
  saveSession(ctx.d, "devin-s2", { turnsSinceMemory: 10, toolsSinceSkill: 0, lastDigestLine: 0 });

  const out = handle("Stop", { session_id: "devin-s2", stop_hook_active: false, last_assistant_message: "Got it, will run pnpm lint." }, ctx);
  assert.equal(out.decision, "block");
  assert.match(out.reason, /run_subagent/);
  assert.match(out.reason, /profile: "peka:reviewer"/);
  assert.match(out.reason, /is_background: false/);
  const digestFile = out.reason.match(/Digest: (\S+)/)[1];
  assert.match(fs.readFileSync(digestFile, "utf8"), /Always run pnpm lint before commit/);

  // Second stop with stop_hook_active: true must NOT loop.
  assert.equal(handle("Stop", { session_id: "devin-s2", stop_hook_active: true }, ctx), null);
});

test("Devin tracks skill usage via /name in UserPromptSubmit and lowercase skill/read in PostToolUse", () => {
  const { ctx } = makeDevinCtx();
  fs.mkdirSync(path.join(ctx.d.skills, "deploy"), { recursive: true });
  fs.writeFileSync(path.join(ctx.d.skills, "deploy", "SKILL.md"), "---\nname: deploy\ndescription: d\n---\n");
  handle("SessionStart", { session_id: "s3", source: "startup" }, ctx);

  handle("UserPromptSubmit", { session_id: "s3", prompt_id: "p1", prompt: "/deploy prod" }, ctx);
  handle("PostToolUse", { session_id: "s3", prompt_id: "p1", tool_name: "skill", tool_input: { skill: "deploy" } }, ctx);
  handle("PostToolUse", { session_id: "s3", prompt_id: "p1", tool_name: "read", tool_input: { file_path: path.join(ctx.devinSkillsDir, "deploy", "SKILL.md") } }, ctx);
  assert.equal(loadUsage(ctx.d).skills.deploy.uses, 3);
});

test("Devin curator actions run via PostToolUse(run_subagent) and record lastRunAt", () => {
  const { ctx } = makeDevinCtx();
  fs.mkdirSync(path.join(ctx.d.skills, "old"), { recursive: true });
  fs.writeFileSync(path.join(ctx.d.skills, "old", "SKILL.md"), "---\nname: old\ndescription: d\n---\n");
  fs.writeFileSync(path.join(ctx.d.state, "curator-actions.json"), JSON.stringify({ archiveSkills: ["old"], deleteMemories: [] }));

  handle(
    "PostToolUse",
    { session_id: "s4", prompt_id: "p1", tool_name: "run_subagent", tool_input: { profile: "peka:curator", is_background: false } },
    ctx,
  );
  assert.deepEqual(listSkills(ctx.d), []);
  assert.equal(loadCurator(ctx.d).lastRunAt, T0.toISOString());
});

test("peka CLI works end-to-end in Devin runtime (setup, learn/review without CLAUDE_SESSION_ID, adopt, search)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "peka-devin-cli-"));
  const workDir = path.join(tmp, "myrepo");
  fs.mkdirSync(workDir, { recursive: true });
  const env = {
    ...process.env,
    PEKA_HOME: path.join(tmp, "peka"),
    CLAUDE_CONFIG_DIR: path.join(tmp, "claude"),
    DEVIN_CONFIG_DIR: path.join(tmp, "devin"),
    DEVIN_SESSIONS_DIR: path.join(tmp, "devin-sessions"),
    DEVIN_PLUGIN_ROOT: root,
    DEVIN_PROJECT_DIR: workDir,
  };
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { env, cwd: workDir, encoding: "utf8" });

  // setup --check and --apply never touch ~/.claude/settings.json
  const check = run("setup", "--check");
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /Runtime: devin/);

  const apply = run("setup", "--apply");
  assert.equal(apply.status, 0, apply.stderr);
  assert.equal(fs.existsSync(path.join(env.CLAUDE_CONFIG_DIR, "settings.json")), false);
  assert.ok(fs.existsSync(path.join(env.PEKA_HOME, "config.json")));
  assert.ok(fs.existsSync(path.join(env.PEKA_HOME, "state", "setup.json")));

  // Seed a Devin session in sessions.db and invoke review/learn with unexpanded ${CLAUDE_SESSION_ID}
  const dbPath = path.join(env.DEVIN_SESSIONS_DIR, "sessions.db");
  seedDevinDb(dbPath, [
    {
      id: "bright-lynx",
      cwd: workDir,
      ts: T0.getTime(),
      head: 2,
      nodes: [
        { id: 1, parent: null, msg: { role: "user", content: "Remember our staging deploy uses caddy." } },
        { id: 2, parent: 1, msg: { role: "assistant", content: "Noted caddy for staging." } },
      ],
    },
  ]);

  const rev = run("review", "--session", "${CLAUDE_SESSION_ID}");
  assert.equal(rev.status, 0, rev.stderr);
  assert.match(rev.stdout, /run_subagent/);
  assert.match(rev.stdout, /profile: "peka:reviewer"/);
  const revDigest = rev.stdout.match(/Digest: (\S+)/)[1];
  assert.match(fs.readFileSync(revDigest, "utf8"), /staging deploy uses caddy/);

  const lrn = run("learn", "--session", "${CLAUDE_SESSION_ID}", "--mode", "decide");
  assert.equal(lrn.status, 0, lrn.stderr);
  assert.match(lrn.stdout, /profile: "peka:learner"/);

  const srch = run("search", "caddy", "staging");
  assert.equal(srch.status, 0, srch.stderr);
  assert.match(srch.stdout, /bright-lynx/);

  // Adopt a skill from ~/.config/devin/skills
  const own = path.join(env.DEVIN_CONFIG_DIR, "skills", "custom-ops");
  fs.mkdirSync(own, { recursive: true });
  fs.writeFileSync(path.join(own, "SKILL.md"), "---\nname: custom-ops\ndescription: ops\n---\n1. check\n");
  const adopted = run("adopt", "custom-ops");
  assert.equal(adopted.status, 0, adopted.stderr);
  assert.ok(fs.lstatSync(own).isSymbolicLink());
});
