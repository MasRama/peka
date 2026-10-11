import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dirs, ensureDirs } from "../scripts/lib/paths.mjs";
import {
  readJson,
  writeJsonAtomic,
  safeId,
  loadSession,
  saveSession,
  loadUsage,
  saveUsage,
  loadCurator,
  saveCurator,
  isSetUp,
  log,
} from "../scripts/lib/state.mjs";

function tmpHome() {
  const d = dirs(fs.mkdtempSync(path.join(os.tmpdir(), "peka-state-")));
  ensureDirs(d);
  return d;
}

test("writeJsonAtomic round-trips and leaves no temp file", () => {
  const d = tmpHome();
  const file = path.join(d.state, "nested", "x.json");
  writeJsonAtomic(file, { a: 1 });
  assert.deepEqual(readJson(file, null), { a: 1 });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["x.json"]);
});

test("readJson returns fallback for missing or corrupt files", () => {
  const d = tmpHome();
  const file = path.join(d.state, "bad.json");
  assert.deepEqual(readJson(file, { z: 0 }), { z: 0 });
  fs.writeFileSync(file, "{not json");
  assert.deepEqual(readJson(file, { z: 0 }), { z: 0 });
});

test("safeId strips path characters", () => {
  const id = safeId("../../etc/passwd");
  assert.doesNotMatch(id, /[./\\]/);
  assert.equal(safeId(""), "unknown");
  assert.equal(safeId(undefined), "unknown");
  assert.equal(safeId("abc-123_X"), "abc-123_X");
  assert.equal(safeId("a".repeat(300)).length, 128);
});

test("session state defaults and round-trips", () => {
  const d = tmpHome();
  assert.deepEqual(loadSession(d, "s1"), { turnsSinceMemory: 0, toolsSinceSkill: 0, lastDigestLine: 0 });
  saveSession(d, "s1", { turnsSinceMemory: 3, toolsSinceSkill: 7, lastDigestLine: 40 });
  assert.deepEqual(loadSession(d, "s1"), { turnsSinceMemory: 3, toolsSinceSkill: 7, lastDigestLine: 40 });
});

test("usage and curator state defaults and round-trip", () => {
  const d = tmpHome();
  assert.deepEqual(loadUsage(d), { skills: {} });
  saveUsage(d, { skills: { a: { uses: 1 } } });
  assert.deepEqual(loadUsage(d), { skills: { a: { uses: 1 } } });
  assert.deepEqual(loadCurator(d), { lastRunAt: null, lastPromptAt: null, lastLifecycleAt: null });
  saveCurator(d, { lastRunAt: "2026-01-01T00:00:00.000Z", lastPromptAt: null, lastLifecycleAt: null });
  assert.equal(loadCurator(d).lastRunAt, "2026-01-01T00:00:00.000Z");
});

test("isSetUp reflects setup.json", () => {
  const d = tmpHome();
  assert.equal(isSetUp(d), false);
  writeJsonAtomic(path.join(d.state, "setup.json"), { version: "0.1.0" });
  assert.equal(isSetUp(d), true);
});

test("log appends lines and never throws", () => {
  const d = tmpHome();
  log(d, "first");
  log(d, "second");
  const lines = fs.readFileSync(d.log, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[1], /^\d{4}-\d{2}-\d{2}T.* second$/);
  assert.doesNotThrow(() => log({ log: path.join(d.log, "child", "x.log") }, "x"));
});
