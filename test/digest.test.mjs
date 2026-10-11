import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildDigest } from "../scripts/lib/digest.mjs";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "transcript.jsonl");

test("digest keeps conversation, tools and errors, drops noise", () => {
  const { text, toLine } = buildDigest(fixture, 0);
  assert.equal(toLine, 8);
  assert.match(text, /USER: Please fix the login bug/);
  assert.match(text, /ASSISTANT: Looking at auth\.ts now\./);
  assert.match(text, /TOOL Bash: \{"command":"npm test"\}/);
  assert.match(text, /\[tool error\] Error: cannot find module x/);
  assert.match(text, /USER: stop using npm, use pnpm/);
  for (const noise of ["secret reminder", "private musing", "ATTACHMENT BODY", "SIDECHAIN TEXT", "not json"]) {
    assert.ok(!text.includes(noise), `digest should not contain ${noise}`);
  }
});

test("digest starts after fromLine", () => {
  const { text } = buildDigest(fixture, 5);
  assert.match(text, /stop using npm/);
  assert.ok(!text.includes("login bug"));
});

test("digest restarts when fromLine is past the end", () => {
  const { text } = buildDigest(fixture, 999);
  assert.match(text, /login bug/);
});

test("digest keeps the most recent part when over budget", () => {
  const { text } = buildDigest(fixture, 0, { maxChars: 80 });
  assert.ok(text.startsWith("[… earlier part of the session omitted …]"));
  assert.ok(text.endsWith("ASSISTANT: Switched to pnpm."));
  assert.ok(!text.includes("login bug"));
});

test("digest appends the final assistant message once", () => {
  assert.ok(buildDigest(fixture, 0, { lastAssistantMessage: "All done." }).text.endsWith("ASSISTANT: All done."));
  const same = buildDigest(fixture, 0, { lastAssistantMessage: "Switched to pnpm." }).text;
  assert.equal(same.split("Switched to pnpm.").length, 2);
});

test("digest ignores a partially written last line", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "peka-digest-"));
  const file = path.join(dir, "t.jsonl");
  fs.writeFileSync(file, `${fs.readFileSync(fixture, "utf8")}{"type":"user","mess`);
  assert.equal(buildDigest(file, 0).toLine, 8);
});

test("digest of a missing file is empty", () => {
  assert.deepEqual(buildDigest("/nonexistent/t.jsonl", 3), { text: "", toLine: 3 });
});

test("digest leaves out injected records that are not the user speaking", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "peka-digest-"));
  const file = path.join(dir, "t.jsonl");
  const rows = [
    { type: "user", message: { content: "real request" } },
    { type: "user", isMeta: true, message: { content: [{ type: "text", text: "Base directory for this skill: SKILL BODY" }] } },
    { type: "user", isCompactSummary: true, message: { content: "This session is being continued SUMMARY" } },
    { type: "user", promptSource: "system", message: { content: "SYSTEM PROMPT" } },
    { type: "user", message: { content: "<task-notification><task-id>x</task-id>NOTIFY</task-notification>" } },
    { type: "user", message: { content: "<local-command-caveat>CAVEAT</local-command-caveat><local-command-stdout>STDOUT</local-command-stdout>" } },
  ];
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const { text } = buildDigest(file, 0);
  assert.equal(text, "USER: real request");
});
