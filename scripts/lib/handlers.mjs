import fs from "node:fs";
import path from "node:path";
import { claudeHome, dirs, ensureDirs, expandHome, pekaHome } from "./paths.mjs";
import { loadConfig } from "./config.mjs";
import {
  isSetUp,
  loadCurator,
  loadSession,
  loadUsage,
  log,
  readJson,
  saveCurator,
  saveSession,
  saveUsage,
  writeJsonAtomic,
} from "./state.mjs";
import { classify, isInside, resolveReal } from "./guard.mjs";
import { applyLifecycle, archiveSkill, listSkills, recordUse, syncLinks, writeCuratorReport } from "./skills.mjs";
import { buildDigest, writeDigest } from "./digest.mjs";
import { curatorInstruction, reviewerInstruction } from "./prompts.mjs";
import { autoCommit, ensureRepo } from "./git.mjs";

const DAY = 86400000;
const HOUR = 3600000;
const PEKA_AGENT = /^peka:(reviewer|curator)$/;

export function contextFrom(env = process.env, now = new Date()) {
  return {
    env,
    now,
    d: dirs(pekaHome(env)),
    cfg: loadConfig(env),
    claudeSkillsDir: path.join(claudeHome(env), "skills"),
  };
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

function sync(ctx) {
  const r = syncLinks(ctx.d, ctx.claudeSkillsDir);
  if (r.conflicts.length) log(ctx.d, `skill name conflicts in ${ctx.claudeSkillsDir}: ${r.conflicts.join(", ")}`);
  return r.created.length > 0 || r.removed.length > 0;
}

function commit(ctx, message) {
  if (ctx.cfg.autoCommit) autoCommit(ctx.d.home, message);
}

function sessionStart(ctx) {
  ensureDirs(ctx.d);
  ensureRepo(ctx.d.home);
  // Plugin options only reach hooks; the CLI reads them from here.
  writeJsonAtomic(path.join(ctx.d.state, "config.json"), ctx.cfg);
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
  return sync(ctx) ? { hookSpecificOutput: { hookEventName: "SessionStart", reloadSkills: true } } : null;
}

function userPromptSubmit(input, ctx) {
  const s = loadSession(ctx.d, input.session_id);
  s.turnsSinceMemory += 1;
  saveSession(ctx.d, input.session_id, s);
  return null;
}

function preToolUse(input, ctx) {
  const r = classify(input.tool_name, input.tool_input, ctx.d, ctx.claudeSkillsDir);
  if (!r.decision) return null;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: r.decision,
      permissionDecisionReason: r.reason ?? "PEKA manages this file.",
    },
  };
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

function postToolUse(input, ctx) {
  const s = loadSession(ctx.d, input.session_id);
  s.toolsSinceSkill += 1;
  const { kind } = classify(input.tool_name, input.tool_input, ctx.d, ctx.claudeSkillsDir);
  if (kind === "memory") s.turnsSinceMemory = 0;
  if (kind === "skill") {
    s.toolsSinceSkill = 0;
    sync(ctx);
  }
  saveSession(ctx.d, input.session_id, s);

  let used = null;
  if (input.tool_name === "Skill") used = input.tool_input?.skill;
  else if (input.tool_name === "Read") used = skillNameFromRead(input, ctx);
  if (typeof used === "string" && listSkills(ctx.d).includes(used)) {
    const usage = loadUsage(ctx.d);
    recordUse(usage, used, ctx.now.toISOString());
    saveUsage(ctx.d, usage);
  }
  return null;
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

  const transcript = typeof input.transcript_path === "string" ? expandHome(input.transcript_path) : "";
  const digest = buildDigest(transcript, s.lastDigestLine, { lastAssistantMessage: input.last_assistant_message });
  if (!digest.text) return null;

  const file = writeDigest(ctx.d, { sessionId: input.session_id, cwd: input.cwd, text: digest.text, now: ctx.now });

  if (memoryDue) s.turnsSinceMemory = 0;
  if (skillDue) s.toolsSinceSkill = 0;
  s.lastDigestLine = digest.toLine;
  saveSession(ctx.d, input.session_id, s);

  const focus = memoryDue && skillDue ? "memory and skills" : memoryDue ? "memory" : "skills";
  return context("Stop", reviewerInstruction({ digest: file, focus, d: ctx.d, model: ctx.cfg.reviewerModel }));
}

function curatorPrompt(ctx) {
  const c = loadCurator(ctx.d);
  if (!c.lastRunAt && !c.seededAt) {
    c.seededAt = ctx.now.toISOString();
    saveCurator(ctx.d, c);
    return null;
  }
  if (since(ctx.now, c.lastRunAt ?? c.seededAt) < ctx.cfg.curatorIntervalDays * DAY) return null;
  if (since(ctx.now, c.lastPromptAt) < 24 * HOUR) return null;

  const report = writeCuratorReport(ctx.d, loadUsage(ctx.d), ctx.now);
  c.lastPromptAt = ctx.now.toISOString();
  saveCurator(ctx.d, c);
  return context("Stop", curatorInstruction({ report, d: ctx.d, model: ctx.cfg.curatorModel }));
}

function stop(input, ctx) {
  if (input.stop_hook_active || pekaAgentRunning(input)) return null;
  const s = loadSession(ctx.d, input.session_id);
  return reviewPrompt(input, ctx, s) ?? curatorPrompt(ctx);
}

function plainName(name) {
  return typeof name === "string" && name !== "" && !/[\\/]/.test(name) && !name.includes("..");
}

function applyCuratorActions(ctx) {
  const file = path.join(ctx.d.state, "curator-actions.json");
  if (!fs.existsSync(file)) return;
  const actions = readJson(file, {});
  fs.rmSync(file, { force: true });

  const usage = loadUsage(ctx.d);
  const live = new Set(listSkills(ctx.d));
  const archived = [];
  for (const name of Array.isArray(actions.archiveSkills) ? actions.archiveSkills : []) {
    if (!plainName(name) || !live.has(name) || usage.skills[name]?.pinned) continue;
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
  log(ctx.d, `curator actions: archived skills [${archived.join(", ")}], archived memories [${retired.join(", ")}]`);
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

function subagentStop(input, ctx) {
  const match = typeof input.agent_type === "string" && input.agent_type.match(PEKA_AGENT);
  if (!match) return null;
  const role = match[1];
  if (role === "curator") {
    applyCuratorActions(ctx);
    const c = loadCurator(ctx.d);
    c.lastRunAt = ctx.now.toISOString();
    saveCurator(ctx.d, c);
  }
  sync(ctx);
  pruneDigests(ctx);
  commit(ctx, `peka: ${role} update`);
  return null;
}

export function handle(event, input, ctx) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  if (!isSetUp(ctx.d)) {
    return event === "SessionStart"
      ? { systemMessage: "PEKA is installed but not set up yet. Run /peka:setup to turn on global memory and learning." }
      : null;
  }
  const mainAgent = !input.agent_id;
  switch (event) {
    case "SessionStart":
      return sessionStart(ctx);
    case "UserPromptSubmit":
      return mainAgent ? userPromptSubmit(input, ctx) : null;
    case "PreToolUse":
      return preToolUse(input, ctx);
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
