import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  claudeHome,
  devinHome,
  devinSessionsDb,
  dirs,
  ensureDirs,
  expandHome,
  isDevinRuntime,
  pekaHome,
  pluginRoot,
} from "./paths.mjs";
import { loadConfig, loadFileConfig } from "./config.mjs";
import {
  isSetUp,
  loadCurator,
  loadNotice,
  loadSession,
  loadUsage,
  log,
  markActive,
  readJson,
  recordLastSession,
  saveCurator,
  saveNotice,
  saveSession,
  saveUsage,
  writeJsonAtomic,
} from "./state.mjs";
import { classify, isInside, resolveReal } from "./guard.mjs";
import {
  applyLifecycle,
  archiveSkill,
  budgetProblems,
  globalSkills,
  listSkills,
  recordUse,
  syncLinks,
  syncProjectLinks,
  writeCuratorReport,
} from "./skills.mjs";
import { buildDigest, writeDigest } from "./digest.mjs";
import { buildDevinDigest } from "./devin-sessions.mjs";
import { curatorInstruction, reviewerInstruction, sessionBrief } from "./prompts.mjs";
import { autoCommit, ensureRepo } from "./git.mjs";
import { buildIndex } from "./memory-index.mjs";
import { projectOf, repoOf } from "./project.mjs";
import { changesSince, commitExists, describe, headCommit, mergeItems, summarize } from "./changes.mjs";

const DAY = 86400000;
const HOUR = 3600000;
const PEKA_AGENT = /^peka:(reviewer|curator|learner)$/;
// Entry points with no one at the keyboard: `claude -p`, the GitHub action, `claude mcp serve`.
// A checkpoint there would replace the run's real output with a launch message.
const HEADLESS = new Set(["sdk-cli", "claude-code-github-action", "mcp"]);

export function contextFrom(env = process.env, now = new Date()) {
  const d = dirs(pekaHome(env));
  const root = pluginRoot(env);
  return {
    env,
    now,
    d,
    cfg: loadConfig(env, loadFileConfig(d)),
    runtime: isDevinRuntime(env) ? "devin" : "claude",
    claudeSkillsDir: path.join(claudeHome(env), "skills"),
    devinSkillsDir: path.join(devinHome(env), "skills"),
    devinDbPath: devinSessionsDb(env),
    cliPath: root ? path.join(root, "scripts", "peka.mjs") : null,
    userHome: env.HOME?.trim() || os.homedir(),
  };
}

function skillsDirFor(ctx) {
  return ctx.runtime === "devin" ? ctx.devinSkillsDir : ctx.claudeSkillsDir;
}

function inputCwd(input, ctx) {
  if (ctx.runtime === "devin") {
    return input?.cwd || ctx.env?.DEVIN_PROJECT_DIR || ctx.env?.CLAUDE_PROJECT_DIR || process.cwd();
  }
  return input?.cwd;
}

function isActiveDevinSubagent(ctx, input, s) {
  return (
    ctx.runtime === "devin" &&
    Boolean(s?.activeAgent) &&
    (!input?.prompt_id || !s.activeAgent.promptId || s.activeAgent.promptId === input.prompt_id)
  );
}

function stamp(now) {
  return now.toISOString().replace(/[-:.TZ]/g, "");
}

function since(now, iso) {
  return iso ? now.getTime() - Date.parse(iso) : Infinity;
}

function context(event, text) {
  return { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
}

// Global skills go into the runtime's skills dir; project skills go into the repository's own
// skills dir so other projects never list them.
function sync(ctx, repo = null) {
  let changed = false;
  const apply = (dir, r) => {
    if (r.conflicts.length) log(ctx.d, `skill name conflicts in ${dir}: ${r.conflicts.join(", ")}`);
    changed ||= r.created.length > 0 || r.removed.length > 0;
  };
  if (ctx.runtime === "devin") {
    apply(ctx.devinSkillsDir, syncLinks(ctx.d, ctx.devinSkillsDir, globalSkills(ctx.d)));
    if (repo) apply(path.join(repo.root, ".devin", "skills"), syncProjectLinks(ctx.d, repo, { dirName: ".devin" }));
    return changed;
  }
  apply(ctx.claudeSkillsDir, syncLinks(ctx.d, ctx.claudeSkillsDir, globalSkills(ctx.d)));
  if (repo) apply(path.join(repo.root, ".claude", "skills"), syncProjectLinks(ctx.d, repo));
  return changed;
}

function sessionRepo(ctx, input) {
  return repoOf(inputCwd(input, ctx), { home: ctx.userHome });
}

function commit(ctx, message) {
  if (ctx.cfg.autoCommit) autoCommit(ctx.d.home, message);
}

// The session's project, worked out once from its directory and kept in the session state.
function sessionProject(ctx, input, s) {
  if (s.project !== undefined) return s.project;
  s.project = projectOf(inputCwd(input, ctx), { home: ctx.userHome });
  return s.project;
}

// Once a week, one line on what PEKA saved since the last notice. The first call only seeds.
function weeklyNotice(ctx) {
  if (ctx.cfg.learningNotice !== "weekly") return null;
  const n = loadNotice(ctx.d);
  const head = headCommit(ctx.d.home);
  const reseed = () => saveNotice(ctx.d, { lastNoticeAt: ctx.now.toISOString(), lastNoticeCommit: head });
  if (!n.lastNoticeAt) return reseed(), null;
  if (since(ctx.now, n.lastNoticeAt) < 7 * DAY) return null;
  if (n.lastNoticeCommit && !commitExists(ctx.d.home, n.lastNoticeCommit)) return reseed(), null;
  const commits = n.lastNoticeCommit
    ? changesSince(ctx.d.home, n.lastNoticeCommit)
    : changesSince(ctx.d.home, null, { since: new Date(n.lastNoticeAt) });
  reseed();
  const text = summarize(mergeItems(commits));
  return text ? `PEKA this week: ${text}. Details: /peka:status log` : null;
}

function sessionStart(input, ctx) {
  ensureDirs(ctx.d);
  ensureRepo(ctx.d.home);
  // Plugin options only reach hooks; the CLI reads them from here.
  writeJsonAtomic(path.join(ctx.d.state, "config.json"), ctx.cfg);
  const cwd = inputCwd(input, ctx);
  const repo = sessionRepo(ctx, input);
  const project = repo?.project ?? null;
  if (typeof input.session_id === "string") {
    const s = loadSession(ctx.d, input.session_id);
    s.project = project;
    saveSession(ctx.d, input.session_id, s);
    recordLastSession(ctx.d, cwd, input.session_id);
  }
  markActive(ctx.d, project, ctx.now);
  const curator = loadCurator(ctx.d);
  if (since(ctx.now, curator.lastLifecycleAt) >= DAY) {
    const usage = loadUsage(ctx.d);
    const r = applyLifecycle(ctx.d, usage, ctx.now, ctx.cfg);
    saveUsage(ctx.d, usage);
    curator.lastLifecycleAt = ctx.now.toISOString();
    saveCurator(ctx.d, curator);
    if (r.archived.length) {
      log(ctx.d, `archived unused skills: ${r.archived.join(", ")}`);
      commit(ctx, `peka: archive unused skills (${r.archived.join(", ")})`);
    }
  }
  buildIndex(ctx.d);
  if (ctx.runtime === "devin") {
    const brief = sessionBrief(ctx.d, project, { runtime: "devin", includeMemory: true, cliPath: ctx.cliPath });
    sync(ctx, repo);
    const notice = weeklyNotice(ctx);
    return context("SessionStart", notice ? `${brief}\n\n${notice}` : brief);
  }
  const out = { hookEventName: "SessionStart", additionalContext: sessionBrief(ctx.d, project) };
  if (sync(ctx, repo)) out.reloadSkills = true;
  const notice = weeklyNotice(ctx);
  return notice ? { systemMessage: notice, hookSpecificOutput: out } : { hookSpecificOutput: out };
}

function postCompaction(input, ctx, event = "PostCompact") {
  if (ctx.runtime !== "devin") return null;
  const project =
    typeof input.session_id === "string"
      ? sessionProject(ctx, input, loadSession(ctx.d, input.session_id))
      : projectOf(inputCwd(input, ctx), { home: ctx.userHome });
  buildIndex(ctx.d);
  return context(event, sessionBrief(ctx.d, project, { runtime: "devin", includeMemory: true, cliPath: ctx.cliPath }));
}

function userPromptSubmit(input, ctx) {
  const s = loadSession(ctx.d, input.session_id);
  if (s.activeAgent && s.activeAgent.promptId !== (input.prompt_id ?? null)) {
    delete s.activeAgent;
  }
  s.turnsSinceMemory += 1;
  const project = sessionProject(ctx, input, s);
  saveSession(ctx.d, input.session_id, s);
  markActive(ctx.d, project, ctx.now);
  recordLastSession(ctx.d, inputCwd(input, ctx), input.session_id);
  if (ctx.runtime === "devin" && typeof input.prompt === "string") {
    const m = input.prompt.trim().match(/^\/([A-Za-z0-9._-]+)(?:\s|$)/);
    if (m) recordSkillUse(ctx, m[1]);
  }
  return null;
}

function preToolUse(input, ctx) {
  if (ctx.runtime === "devin") {
    if (input.tool_name === "run_subagent") {
      const profile = input.tool_input?.profile;
      const match = typeof profile === "string" && profile.match(PEKA_AGENT);
      if (match && !input.tool_input?.is_background && typeof input.session_id === "string") {
        const s = loadSession(ctx.d, input.session_id);
        s.activeAgent = { role: match[1], agentType: profile, promptId: input.prompt_id ?? null };
        saveSession(ctx.d, input.session_id, s);
      }
      return null;
    }
    const s = typeof input.session_id === "string" ? loadSession(ctx.d, input.session_id) : null;
    const agentType = input.agent_type || (isActiveDevinSubagent(ctx, input, s) ? s.activeAgent.agentType : undefined);
    const r = classify(input.tool_name, input.tool_input, ctx.d, ctx.devinSkillsDir, agentType);
    return r.decision === "deny" ? { decision: "block", reason: r.reason ?? "PEKA manages this file." } : null;
  }
  const r = classify(input.tool_name, input.tool_input, ctx.d, ctx.claudeSkillsDir, input.agent_type);
  if (!r.decision) return null;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: r.decision,
      permissionDecisionReason: r.reason ?? "PEKA manages this file.",
    },
  };
}

const SAFE_PEKA_CLI_SUBCOMMANDS = new Set([
  "status",
  "show",
  "log",
  "pin",
  "unpin",
  "search",
  "where",
  "legacy",
  "audit",
  "learn",
  "review",
  "curate",
]);

function isSafePekaCli(toolInput, cliPath) {
  const cmd = toolInput?.command;
  if (!cliPath || typeof cmd !== "string" || /[;&|`$<>()\n\r]/.test(cmd)) return false;
  const m = cmd.match(/^\s*node\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s+([a-z]+)(?:\s|$)/);
  if (!m) return false;
  const script = m[1] || m[2] || m[3];
  const sub = m[4];
  if (!SAFE_PEKA_CLI_SUBCOMMANDS.has(sub)) return false;
  try {
    return fs.realpathSync(path.resolve(script)) === fs.realpathSync(path.resolve(cliPath));
  } catch {
    return path.resolve(script) === path.resolve(cliPath);
  }
}

function permissionRequest(input, ctx) {
  if (ctx.runtime !== "devin") return null;
  if (input.tool_name === "exec") {
    return isSafePekaCli(input.tool_input, ctx.cliPath) ? { decision: "approve" } : null;
  }
  const s = typeof input.session_id === "string" ? loadSession(ctx.d, input.session_id) : null;
  const agentType = input.agent_type || (isActiveDevinSubagent(ctx, input, s) ? s.activeAgent.agentType : undefined);
  const r = classify(input.tool_name, input.tool_input, ctx.d, ctx.devinSkillsDir, agentType);
  if (r.decision === "allow") return { decision: "approve" };
  if (r.decision === "deny") return { decision: "block", reason: r.reason ?? "PEKA manages this file." };
  return null;
}

function skillNameFromRead(input, ctx) {
  const raw = input.tool_input?.file_path;
  if (typeof raw !== "string" || path.basename(raw) !== "SKILL.md") return null;
  const real = resolveReal(raw);
  const skills = resolveReal(ctx.d.skills);
  if (!isInside(real, skills)) return null;
  const parts = path.relative(skills, real).split(path.sep);
  return parts.length === 2 ? parts[0] : null;
}

function recordSkillUse(ctx, name) {
  if (typeof name !== "string" || !listSkills(ctx.d).includes(name)) return;
  const usage = loadUsage(ctx.d);
  recordUse(usage, name, ctx.now.toISOString());
  saveUsage(ctx.d, usage);
}

function userPromptExpansion(input, ctx) {
  recordSkillUse(ctx, input.command_name);
  return null;
}

// A SKILL.md written into a real directory under the runtime's skills dir bypassed PEKA's store.
function unmanagedSkillWrite(input, ctx) {
  const raw = input.tool_input?.file_path;
  if ((input.tool_name !== "Write" && input.tool_name !== "write") || typeof raw !== "string" || path.basename(raw) !== "SKILL.md") {
    return null;
  }
  const skillsDir = skillsDirFor(ctx);
  const file = path.resolve(expandHome(raw));
  const parts = path.relative(skillsDir, file).split(path.sep);
  if (parts.length !== 2 || parts[0].startsWith("..")) return null;
  const st = fs.lstatSync(path.join(skillsDir, parts[0]), { throwIfNoEntry: false });
  if (!st || st.isSymbolicLink() || !st.isDirectory()) return null;
  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: `PEKA: this skill was saved outside PEKA, in ${path.dirname(file)}, so it is not versioned, curated, or listed by /peka:status. If it is something learned in this session, tell the user they can move it into PEKA with /peka:audit adopt ${parts[0]}. If the user made it on purpose as their own skill, leave it.`,
    },
  };
}

function postToolUse(input, ctx) {
  if (ctx.runtime === "devin" && input.tool_name === "run_subagent") {
    const profile = input.tool_input?.profile;
    const match = typeof profile === "string" && profile.match(PEKA_AGENT);
    if (match) {
      if (typeof input.session_id === "string") {
        const s = loadSession(ctx.d, input.session_id);
        if (s.activeAgent) {
          delete s.activeAgent;
          saveSession(ctx.d, input.session_id, s);
        }
      }
      const { noticeText, warningText } = finishPekaAgent(match[1], input, ctx);
      const combined = [noticeText, warningText].filter(Boolean).join("\n");
      return combined ? context("PostToolUse", combined) : null;
    }
  }

  const s = loadSession(ctx.d, input.session_id);
  if (isActiveDevinSubagent(ctx, input, s)) {
    const { kind } = classify(input.tool_name, input.tool_input, ctx.d, ctx.devinSkillsDir, s.activeAgent.agentType);
    if (kind === "memory") buildIndex(ctx.d);
    if (kind === "skill") sync(ctx, sessionRepo(ctx, input));
    return null;
  }

  s.toolsSinceSkill += 1;
  const { kind } = classify(input.tool_name, input.tool_input, ctx.d, skillsDirFor(ctx));
  if (kind === "memory") {
    s.turnsSinceMemory = 0;
    buildIndex(ctx.d);
  }
  if (kind === "skill") {
    s.toolsSinceSkill = 0;
    sync(ctx, sessionRepo(ctx, input));
  }
  saveSession(ctx.d, input.session_id, s);

  let used = null;
  if (input.tool_name === "Skill" || input.tool_name === "skill") used = input.tool_input?.skill;
  else if (input.tool_name === "Read" || input.tool_name === "read") used = skillNameFromRead(input, ctx);
  recordSkillUse(ctx, used);
  return unmanagedSkillWrite(input, ctx);
}

function pekaAgentRunning(input) {
  const tasks = Array.isArray(input.background_tasks) ? input.background_tasks : [];
  return tasks.some((t) => t?.type === "subagent" && typeof t.agent_type === "string" && t.agent_type.startsWith("peka:"));
}

function reviewPrompt(input, ctx, s) {
  const { memoryInterval, skillInterval } = ctx.cfg;
  const memoryDue = memoryInterval > 0 && s.turnsSinceMemory >= memoryInterval;
  const skillDue = skillInterval > 0 && s.toolsSinceSkill >= skillInterval;
  if (!memoryDue && !skillDue) return null;

  const hasTranscript = typeof input.transcript_path === "string" && input.transcript_path.trim() !== "";
  const digest = hasTranscript
    ? buildDigest(expandHome(input.transcript_path), s.lastDigestLine, { lastAssistantMessage: input.last_assistant_message })
    : ctx.runtime === "devin"
      ? buildDevinDigest(ctx.devinDbPath, input.session_id, s.lastDigestLine, { lastAssistantMessage: input.last_assistant_message })
      : { text: "", toLine: s.lastDigestLine };
  if (!digest.text) return null;

  const cwd = inputCwd(input, ctx);
  const file = writeDigest(ctx.d, { sessionId: input.session_id, cwd, text: digest.text, now: ctx.now });

  if (memoryDue) s.turnsSinceMemory = 0;
  if (skillDue) s.toolsSinceSkill = 0;
  s.lastDigestLine = digest.toLine;
  saveSession(ctx.d, input.session_id, s);

  const focus = memoryDue && skillDue ? "memory and skills" : memoryDue ? "memory" : "skills";
  const project = s.project !== undefined ? s.project : projectOf(cwd, { home: ctx.userHome });
  const runtime = ctx.runtime === "devin" ? "devin" : "claude";
  const instruction = reviewerInstruction({ digest: file, focus, d: ctx.d, model: ctx.cfg.reviewerModel, project, runtime });
  return runtime === "devin" ? { decision: "block", reason: instruction } : context("Stop", instruction);
}

function curatorPrompt(ctx) {
  const c = loadCurator(ctx.d);
  if (!c.lastRunAt && !c.seededAt) {
    c.seededAt = ctx.now.toISOString();
    saveCurator(ctx.d, c);
    return null;
  }
  if (since(ctx.now, c.lastPromptAt) < 24 * HOUR) return null;
  const { overflow } = buildIndex(ctx.d);
  const due = since(ctx.now, c.lastRunAt ?? c.seededAt) >= ctx.cfg.curatorIntervalDays * DAY;
  // Over budget, the store costs context in every session; do not wait for the weekly run.
  const overBudget = budgetProblems(ctx.d).length > 0;
  if (!due && !overBudget) return null;

  const report = writeCuratorReport(ctx.d, loadUsage(ctx.d), ctx.now, { overflow, home: ctx.userHome });
  c.lastPromptAt = ctx.now.toISOString();
  saveCurator(ctx.d, c);
  const lead = overBudget ? "PEKA maintenance is due: the store is over budget." : undefined;
  const runtime = ctx.runtime === "devin" ? "devin" : "claude";
  const instruction = curatorInstruction({ report, d: ctx.d, model: ctx.cfg.curatorModel, lead, runtime });
  return runtime === "devin" ? { decision: "block", reason: instruction } : context("Stop", instruction);
}

function stop(input, ctx) {
  if (input.stop_hook_active || pekaAgentRunning(input)) return null;
  if (HEADLESS.has(ctx.env?.CLAUDE_CODE_ENTRYPOINT)) return null;
  const s = loadSession(ctx.d, input.session_id);
  if (ctx.runtime === "devin" && s.activeAgent) {
    delete s.activeAgent;
    saveSession(ctx.d, input.session_id, s);
  }
  return reviewPrompt(input, ctx, s) ?? curatorPrompt(ctx);
}

function plainName(name) {
  return typeof name === "string" && name !== "" && !/[\\/]/.test(name) && !name.includes("..");
}

function applyActions(ctx, role) {
  const file = path.join(ctx.d.state, `${role}-actions.json`);
  if (!fs.existsSync(file)) return;
  const actions = readJson(file, {});
  fs.rmSync(file, { force: true });

  const usage = loadUsage(ctx.d);
  const live = new Set(listSkills(ctx.d));
  const archived = [];
  const kept = [];
  for (const name of Array.isArray(actions.archiveSkills) ? actions.archiveSkills : []) {
    if (!plainName(name) || !live.has(name)) continue;
    if (usage.skills[name]?.pinned) {
      kept.push(name);
      continue;
    }
    archiveSkill(ctx.d, name, ctx.now, usage);
    archived.push(name);
  }
  saveUsage(ctx.d, usage);

  // "Deleted" memories are moved aside, never removed.
  const memoryArchive = path.join(ctx.d.home, "archive", "memory");
  const retired = [];
  for (const name of Array.isArray(actions.deleteMemories) ? actions.deleteMemories : []) {
    if (!plainName(name) || !name.endsWith(".md") || name === "MEMORY.md") continue;
    const target = path.join(ctx.d.memory, name);
    if (!fs.lstatSync(target, { throwIfNoEntry: false })?.isFile()) continue;
    fs.mkdirSync(memoryArchive, { recursive: true });
    let dest = path.join(memoryArchive, name);
    if (fs.existsSync(dest)) dest = path.join(memoryArchive, `${name.slice(0, -3)}-${stamp(ctx.now)}.md`);
    fs.renameSync(target, dest);
    retired.push(name);
  }
  log(
    ctx.d,
    `${role} actions: archived skills [${archived.join(", ")}], kept pinned [${kept.join(", ")}], archived memories [${retired.join(", ")}]`,
  );
}

function pruneDigests(ctx) {
  let names = [];
  try {
    names = fs.readdirSync(ctx.d.digests);
  } catch {
    return;
  }
  for (const name of names) {
    const file = path.join(ctx.d.digests, name);
    const st = fs.lstatSync(file, { throwIfNoEntry: false });
    if (st?.isFile() && ctx.now.getTime() - st.mtimeMs > 7 * DAY) fs.rmSync(file);
  }
}

function finishPekaAgent(role, input, ctx) {
  if (role !== "reviewer") applyActions(ctx, role);
  if (role === "curator") {
    const c = loadCurator(ctx.d);
    c.lastRunAt = ctx.now.toISOString();
    saveCurator(ctx.d, c);
  }
  sync(ctx, sessionRepo(ctx, input));
  pruneDigests(ctx);
  buildIndex(ctx.d);
  const before = headCommit(ctx.d.home);
  commit(ctx, `peka: ${role} update`);
  const noticeText = eachNoticeText(ctx, before);
  const left = role === "curator" ? budgetProblems(ctx.d) : [];
  const warningText = left.length
    ? `PEKA: still over budget: ${left.join("; ")}. The curator runs again tomorrow.`
    : null;
  return { noticeText, warningText };
}

function subagentStop(input, ctx) {
  const match = typeof input.agent_type === "string" && input.agent_type.match(PEKA_AGENT);
  if (!match) return null;
  const { noticeText, warningText } = finishPekaAgent(match[1], input, ctx);
  if (!noticeText && !warningText) return null;
  return { systemMessage: [noticeText, warningText].filter(Boolean).join("\n") };
}

// learning_notice "each": name what the commit just made changed.
function eachNoticeText(ctx, before) {
  if (ctx.cfg.learningNotice !== "each" || !before) return null;
  const commits = changesSince(ctx.d.home, before);
  const items = mergeItems(commits);
  return items.length ? `PEKA: ${describe(items)}.` : null;
}

export function handle(event, input, ctx) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  if (/^(1|true|yes)$/i.test(ctx.env?.PEKA_DISABLE ?? "")) return null;
  if (!isSetUp(ctx.d)) {
    if (event !== "SessionStart") return null;
    const msg = "PEKA is installed but not set up yet. Run /peka:setup to turn on global memory and learning.";
    if (ctx.runtime === "devin") {
      return context("SessionStart", msg + (ctx.cliPath ? `\nPEKA CLI: node "${ctx.cliPath}"` : ""));
    }
    return { systemMessage: msg };
  }
  const mainAgent = !input.agent_id;
  switch (event) {
    case "SessionStart":
      return sessionStart(input, ctx);
    case "PostCompact":
    case "PostCompaction":
      return postCompaction(input, ctx, event);
    case "UserPromptSubmit":
      return mainAgent ? userPromptSubmit(input, ctx) : null;
    case "UserPromptExpansion":
      return mainAgent ? userPromptExpansion(input, ctx) : null;
    case "PreToolUse":
      return preToolUse(input, ctx);
    case "PermissionRequest":
      return permissionRequest(input, ctx);
    case "PostToolUse":
      return mainAgent ? postToolUse(input, ctx) : null;
    case "Stop":
      return mainAgent ? stop(input, ctx) : null;
    case "SubagentStop":
      return subagentStop(input, ctx);
    default:
      return null;
  }
}
