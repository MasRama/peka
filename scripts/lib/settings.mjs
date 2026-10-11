import fs from "node:fs";
import { writeJsonAtomic } from "./state.mjs";

export class SettingsParseError extends Error {
  constructor(file, cause) {
    super(`Cannot parse ${file}: ${cause.message}. Fix it by hand; PEKA will not overwrite it.`);
    this.name = "SettingsParseError";
    this.file = file;
  }
}

function readSettings(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return { data: {}, exists: false };
    throw err;
  }
  let data;
  try {
    data = raw.trim() ? JSON.parse(raw) : {};
  } catch (err) {
    throw new SettingsParseError(file, err);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new SettingsParseError(file, new Error("top level is not an object"));
  }
  return { data, exists: true };
}

export function applySettings(file, { memoryDir, minCleanupDays = 365 }, { dryRun = false } = {}) {
  const { data, exists } = readSettings(file);
  const changes = [];
  if (data.autoMemoryDirectory !== memoryDir) {
    changes.push(`autoMemoryDirectory: ${JSON.stringify(data.autoMemoryDirectory ?? null)} → ${JSON.stringify(memoryDir)}`);
    data.autoMemoryDirectory = memoryDir;
  }
  if (!(typeof data.cleanupPeriodDays === "number" && data.cleanupPeriodDays >= minCleanupDays)) {
    changes.push(`cleanupPeriodDays: ${JSON.stringify(data.cleanupPeriodDays ?? null)} → ${minCleanupDays}`);
    data.cleanupPeriodDays = minCleanupDays;
  }
  if (!changes.length || dryRun) return { changes, backup: null };

  let backup = null;
  if (exists) {
    backup = `${file}.peka-backup-${new Date().toISOString().replace(/[-:.TZ]/g, "")}`;
    fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
  }
  // Write to the real file so a settings.json symlinked from a dotfiles repo stays a link.
  const target = exists ? fs.realpathSync(file) : file;
  const mode = exists ? fs.statSync(target).mode & 0o777 : 0o644;
  writeJsonAtomic(target, data, mode);
  return { changes, backup };
}
