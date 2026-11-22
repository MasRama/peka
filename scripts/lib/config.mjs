import fs from "node:fs";
import path from "node:path";

const MODELS = new Set(["sonnet", "opus", "haiku", "inherit"]);
const NOTICES = new Set(["weekly", "each", "off"]);

function option(env, key, fileConfig, snakeKey, camelKey) {
  for (const name of [`CLAUDE_PLUGIN_OPTION_${key}`, `PEKA_${key}`]) {
    const value = env?.[name];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  const fromFile = fileConfig?.[snakeKey] ?? fileConfig?.[camelKey];
  if (fromFile === undefined || fromFile === null) return undefined;
  return String(fromFile).trim();
}

function interval(raw, fallback) {
  if (raw === undefined || !/^\d+$/.test(raw)) return fallback;
  return Number(raw);
}

function model(raw, fallback) {
  return raw && MODELS.has(raw.toLowerCase()) ? raw.toLowerCase() : fallback;
}

function notice(raw) {
  const v = raw?.toLowerCase();
  return v && NOTICES.has(v) ? v : "weekly";
}

function bool(raw, fallback) {
  if (raw === undefined) return fallback;
  const v = raw.toLowerCase();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return fallback;
}

export function loadFileConfig(d) {
  if (!d?.home) return {};
  try {
    const data = JSON.parse(fs.readFileSync(path.join(d.home, "config.json"), "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

export function loadConfig(env = process.env, fileConfig = {}) {
  return {
    memoryInterval: interval(option(env, "MEMORY_INTERVAL", fileConfig, "memory_interval", "memoryInterval"), 10),
    skillInterval: interval(option(env, "SKILL_INTERVAL", fileConfig, "skill_interval", "skillInterval"), 60),
    reviewerModel: model(option(env, "REVIEWER_MODEL", fileConfig, "reviewer_model", "reviewerModel"), "sonnet"),
    curatorModel: model(option(env, "CURATOR_MODEL", fileConfig, "curator_model", "curatorModel"), "opus"),
    autoCommit: bool(option(env, "AUTO_COMMIT", fileConfig, "auto_commit", "autoCommit"), true),
    curatorIntervalDays: 7,
    staleAfterDays: 14,
    archiveAfterDays: 30,
    // A skill nobody has used yet was probably not worth saving; retire it sooner.
    unusedStaleAfterDays: 7,
    unusedArchiveAfterDays: 10,
    learningNotice: notice(option(env, "LEARNING_NOTICE", fileConfig, "learning_notice", "learningNotice")),
  };
}
