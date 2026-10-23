import fs from "node:fs";
import path from "node:path";
import { expandHome } from "./paths.mjs";

const WRITE_TOOLS = new Set(["Write", "Edit"]);
const READ_TOOLS = new Set(["Read", "Glob", "Grep"]);

// Resolve symlinks on the longest existing prefix, then append the parts that do not exist yet.
export function resolveReal(p) {
  const abs = path.resolve(expandHome(p));
  const missing = [];
  let current = abs;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return abs;
    missing.unshift(path.basename(current));
    current = parent;
  }
  return path.join(fs.realpathSync(current), ...missing);
}

export function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// A write that reaches PEKA's store through a link (in ~/.claude/skills or a project's
// .claude/skills): the real path, or null.
function throughPekaLink(abs, d) {
  const store = resolveReal(d.skills);
  if (isInside(abs, d.skills) || isInside(abs, store)) return null;
  const real = resolveReal(abs);
  return isInside(real, store) ? real : null;
}

const PEKA_AGENTS = new Set(["peka:reviewer", "peka:curator", "peka:learner"]);
const ACTION_FILES = new Map([
  ["peka:curator", "curator-actions.json"],
  ["peka:learner", "learner-actions.json"],
]);
// Frontmatter keys a learned skill may carry. Anything else (hooks, allowed-tools, shell, model,
// context, agent, quoted or flow-style keys) can change what the skill does when it runs.
const PLAIN_KEYS = new Set(["name", "description", "when_to_use", "argument-hint", "metadata", "license", "version"]);

// True when a skill file can run commands, pre-approve tools, or change how it runs. Such a
// skill is executable configuration, so it goes through Claude Code's normal prompt.
export function isExecutableSkill(text) {
  if (text.includes("!`") || /^\s*(`{3,}|~{3,})\s*!/m.test(text)) return true;
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return false;
  const end = lines.indexOf("---", 1);
  if (end === -1) return true;
  for (const line of lines.slice(1, end)) {
    if (!line.trim() || /^\s/.test(line) || line.startsWith("#")) continue;
    const key = line.match(/^([A-Za-z0-9_-]+)\s*:/)?.[1];
    if (!key || !PLAIN_KEYS.has(key)) return true;
  }
  return false;
}

// The skill file as it will be after this Write or Edit, or null if that cannot be known.
function resultingText(toolName, toolInput, file) {
  if (toolName === "Write") return typeof toolInput?.content === "string" ? toolInput.content : null;
  const { old_string: from, new_string: to, replace_all: all } = toolInput ?? {};
  if (typeof from !== "string" || typeof to !== "string" || !from) return null;
  let current;
  try {
    current = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  if (!current.includes(from)) return null;
  return all ? current.split(from).join(to) : current.replace(from, () => to);
}

export function classify(toolName, toolInput, d, claudeSkillsDir, agentType) {
  const raw = toolInput?.file_path ?? toolInput?.path;
  if (typeof raw !== "string" || !raw) return { decision: null };
  const isWrite = WRITE_TOOLS.has(toolName);
  if (!isWrite && !READ_TOOLS.has(toolName)) return { decision: null };

  if (isWrite) {
    const realTarget = throughPekaLink(path.resolve(expandHome(raw)), d);
    if (realTarget) {
      return {
        decision: "deny",
        reason: `This skill is managed by PEKA. Edit the real file instead: ${realTarget}`,
      };
    }
  }

  const real = resolveReal(raw);
  const memory = resolveReal(d.memory);
  const skills = resolveReal(d.skills);

  if (!isWrite) {
    return isInside(real, resolveReal(d.home)) ? { decision: "allow", kind: "read" } : { decision: null };
  }
  if (real.endsWith(".md") && isInside(real, memory)) return { decision: "allow", kind: "memory" };
  if (real.endsWith(".md") && isInside(real, skills)) {
    const text = PEKA_AGENTS.has(agentType) ? resultingText(toolName, toolInput, real) : null;
    return { decision: text !== null && !isExecutableSkill(text) ? "allow" : null, kind: "skill" };
  }
  const state = resolveReal(d.state);
  if (path.dirname(real) === state && /^(curator|learner)-actions\.json$/.test(path.basename(real))) {
    return { decision: ACTION_FILES.get(agentType) === path.basename(real) ? "allow" : null, kind: "state" };
  }
  return { decision: null };
}
