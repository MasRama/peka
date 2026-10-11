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

function throughPekaLink(abs, d, claudeSkillsDir) {
  if (!isInside(abs, claudeSkillsDir) || abs === claudeSkillsDir) return null;
  const [name, ...rest] = path.relative(claudeSkillsDir, abs).split(path.sep);
  const link = path.join(claudeSkillsDir, name);
  try {
    if (!fs.lstatSync(link).isSymbolicLink()) return null;
    const target = fs.realpathSync(link);
    return isInside(target, resolveReal(d.skills)) ? path.join(target, ...rest) : null;
  } catch {
    return null;
  }
}

const PEKA_AGENTS = new Set(["peka:reviewer", "peka:curator"]);
// Skill frontmatter or body that can run commands or pre-approve tools. A skill carrying any
// of these is executable configuration, so it goes through Claude Code's normal prompt.
const EXECUTABLE = /^\s*(hooks|allowed-tools|shell)\s*:|^\s*!`/m;

function writtenText(toolInput) {
  return [toolInput?.content, toolInput?.new_string].filter((t) => typeof t === "string").join("\n");
}

export function classify(toolName, toolInput, d, claudeSkillsDir, agentType) {
  const raw = toolInput?.file_path ?? toolInput?.path;
  if (typeof raw !== "string" || !raw) return { decision: null };
  const isWrite = WRITE_TOOLS.has(toolName);
  if (!isWrite && !READ_TOOLS.has(toolName)) return { decision: null };

  if (isWrite) {
    const realTarget = throughPekaLink(path.resolve(expandHome(raw)), d, claudeSkillsDir);
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
    const safe = PEKA_AGENTS.has(agentType) && !EXECUTABLE.test(writtenText(toolInput));
    return { decision: safe ? "allow" : null, kind: "skill" };
  }
  if (real === path.join(resolveReal(d.state), "curator-actions.json")) {
    return { decision: agentType === "peka:curator" ? "allow" : null, kind: "state" };
  }
  return { decision: null };
}
