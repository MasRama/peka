import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { pekaHome, claudeHome, dirs, expandHome } from "../scripts/lib/paths.mjs";
import { loadConfig } from "../scripts/lib/config.mjs";

test("pekaHome honors PEKA_HOME and ~", () => {
  assert.equal(pekaHome({}), path.join(os.homedir(), ".peka"));
  assert.equal(pekaHome({ PEKA_HOME: "/tmp/x" }), "/tmp/x");
  assert.equal(pekaHome({ PEKA_HOME: "~/custom" }), path.join(os.homedir(), "custom"));
});

test("claudeHome honors CLAUDE_CONFIG_DIR", () => {
  assert.equal(claudeHome({}), path.join(os.homedir(), ".claude"));
  assert.equal(claudeHome({ CLAUDE_CONFIG_DIR: "/tmp/c" }), "/tmp/c");
});

test("expandHome only expands a leading ~", () => {
  assert.equal(expandHome("~"), os.homedir());
  assert.equal(expandHome("/a/~/b"), "/a/~/b");
});

test("dirs layout", () => {
  const d = dirs("/h");
  assert.deepEqual(d, {
    home: "/h",
    memory: "/h/memory",
    skills: "/h/skills",
    archive: "/h/archive/skills",
    state: "/h/state",
    sessions: "/h/state/sessions",
    digests: "/h/state/digests",
    log: "/h/state/peka.log",
  });
});

test("loadConfig defaults", () => {
  assert.deepEqual(loadConfig({}), {
    memoryInterval: 10,
    skillInterval: 20,
    reviewerModel: "sonnet",
    curatorModel: "opus",
    autoCommit: true,
    curatorIntervalDays: 7,
    staleAfterDays: 14,
    archiveAfterDays: 30,
    learningNotice: "weekly",
  });
});

test("loadConfig reads learning_notice and falls back to weekly", () => {
  assert.equal(loadConfig({ CLAUDE_PLUGIN_OPTION_LEARNING_NOTICE: "each" }).learningNotice, "each");
  assert.equal(loadConfig({ CLAUDE_PLUGIN_OPTION_LEARNING_NOTICE: "OFF" }).learningNotice, "off");
  assert.equal(loadConfig({ CLAUDE_PLUGIN_OPTION_LEARNING_NOTICE: "daily" }).learningNotice, "weekly");
});

test("loadConfig parses options", () => {
  const cfg = loadConfig({
    CLAUDE_PLUGIN_OPTION_MEMORY_INTERVAL: "5",
    CLAUDE_PLUGIN_OPTION_SKILL_INTERVAL: "0",
    CLAUDE_PLUGIN_OPTION_REVIEWER_MODEL: "haiku",
    CLAUDE_PLUGIN_OPTION_CURATOR_MODEL: "inherit",
    CLAUDE_PLUGIN_OPTION_AUTO_COMMIT: "false",
  });
  assert.equal(cfg.memoryInterval, 5);
  assert.equal(cfg.skillInterval, 0);
  assert.equal(cfg.reviewerModel, "haiku");
  assert.equal(cfg.curatorModel, "inherit");
  assert.equal(cfg.autoCommit, false);
});

test("loadConfig rejects invalid values", () => {
  const cfg = loadConfig({
    CLAUDE_PLUGIN_OPTION_MEMORY_INTERVAL: "-3",
    CLAUDE_PLUGIN_OPTION_SKILL_INTERVAL: "abc",
    CLAUDE_PLUGIN_OPTION_REVIEWER_MODEL: "gpt",
    CLAUDE_PLUGIN_OPTION_AUTO_COMMIT: "maybe",
  });
  assert.equal(cfg.memoryInterval, 10);
  assert.equal(cfg.skillInterval, 20);
  assert.equal(cfg.reviewerModel, "sonnet");
  assert.equal(cfg.autoCommit, true);
});
