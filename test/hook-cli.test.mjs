import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const hook = path.join(root, "scripts", "hook.mjs");

function run(event, stdin, setUp = true) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "peka-cli-"));
  const env = { ...process.env, PEKA_HOME: path.join(tmp, "peka"), CLAUDE_CONFIG_DIR: path.join(tmp, "claude") };
  if (setUp) {
    fs.mkdirSync(path.join(env.PEKA_HOME, "state"), { recursive: true });
    fs.writeFileSync(path.join(env.PEKA_HOME, "state", "setup.json"), "{}");
  }
  return { ...spawnSync(process.execPath, [hook, event], { input: stdin, env, encoding: "utf8" }), home: env.PEKA_HOME };
}

test("garbage stdin exits 0 with no output", () => {
  for (const event of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SubagentStop", "Bogus"]) {
    for (const stdin of ["", "not json", "{\"tool_input\":", "[]"]) {
      const r = run(event, stdin);
      assert.equal(r.status, 0, `${event} ${stdin}`);
      assert.equal(r.stdout, "", `${event} ${stdin}`);
      assert.equal(r.stderr, "", `${event} ${stdin}`);
    }
  }
});

test("a valid event prints JSON", () => {
  const r = run("SessionStart", JSON.stringify({ session_id: "a" }), false);
  assert.equal(r.status, 0);
  assert.match(JSON.parse(r.stdout).systemMessage, /\/peka:setup/);
});

test("an internal error is logged, not raised", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "peka-cli-"));
  const home = path.join(tmp, "peka");
  fs.mkdirSync(path.join(home, "state"), { recursive: true });
  fs.writeFileSync(path.join(home, "state", "setup.json"), "{}");
  fs.writeFileSync(path.join(home, "memory"), "a file where a directory should be");
  const env = { ...process.env, PEKA_HOME: home, CLAUDE_CONFIG_DIR: path.join(tmp, "claude") };
  const r = spawnSync(process.execPath, [hook, "SessionStart"], { input: "{\"session_id\":\"a\"}", env, encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.match(fs.readFileSync(path.join(home, "state", "peka.log"), "utf8"), /SessionStart/);
});
