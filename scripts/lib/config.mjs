const MODELS = new Set(["sonnet", "opus", "haiku", "inherit"]);
const NOTICES = new Set(["weekly", "each", "off"]);

function option(env, key) {
  const value = env[`CLAUDE_PLUGIN_OPTION_${key}`];
  return typeof value === "string" ? value.trim() : undefined;
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

export function loadConfig(env = process.env) {
  return {
    memoryInterval: interval(option(env, "MEMORY_INTERVAL"), 10),
    skillInterval: interval(option(env, "SKILL_INTERVAL"), 60),
    reviewerModel: model(option(env, "REVIEWER_MODEL"), "sonnet"),
    curatorModel: model(option(env, "CURATOR_MODEL"), "opus"),
    autoCommit: bool(option(env, "AUTO_COMMIT"), true),
    curatorIntervalDays: 7,
    staleAfterDays: 14,
    archiveAfterDays: 30,
    learningNotice: notice(option(env, "LEARNING_NOTICE")),
  };
}
