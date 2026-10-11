import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function frontmatter(file) {
  const text = fs.readFileSync(file, "utf8");
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(m, `${file} has no frontmatter`);
  const fields = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z-]+):\s*(.*)$/);
    if (kv) fields[kv[1]] = kv[2].trim();
  }
  return { fields, body: text.slice(m[0].length) };
}

const agents = ["reviewer", "curator"];
const skills = ["setup", "search", "status", "review", "curate", "remember"];

test("agents declare name, description, model, background and no Bash", () => {
  const models = { reviewer: "sonnet", curator: "opus" };
  for (const name of agents) {
    const { fields, body } = frontmatter(path.join(root, "agents", `${name}.md`));
    assert.equal(fields.name, name);
    assert.ok(fields.description.length > 20);
    assert.equal(fields.model, models[name]);
    assert.equal(fields.background, "true");
    assert.equal(fields.tools, "Read, Write, Edit, Glob, Grep");
    assert.ok(body.trim().length > 200);
  }
});

test("skills declare name and description", () => {
  for (const name of skills) {
    const { fields, body } = frontmatter(path.join(root, "skills", name, "SKILL.md"));
    assert.equal(fields.name, name);
    assert.ok(fields.description.length > 20, name);
    assert.ok(body.includes("${CLAUDE_PLUGIN_ROOT}/scripts/peka.mjs"), `${name} calls the CLI`);
  }
});

test("hooks.json registers every event through the entrypoint", () => {
  const { hooks } = JSON.parse(fs.readFileSync(path.join(root, "hooks", "hooks.json"), "utf8"));
  const expected = {
    SessionStart: undefined,
    UserPromptSubmit: undefined,
    UserPromptExpansion: undefined,
    PreToolUse: "Write|Edit|Read|Glob|Grep",
    PostToolUse: "*",
    Stop: undefined,
    SubagentStop: "^peka:(reviewer|curator)$",
  };
  assert.deepEqual(Object.keys(hooks).sort(), Object.keys(expected).sort());
  for (const [event, matcher] of Object.entries(expected)) {
    const [entry] = hooks[event];
    assert.equal(entry.matcher, matcher, event);
    assert.equal(entry.hooks[0].command, `node "\${CLAUDE_PLUGIN_ROOT}/scripts/hook.mjs" ${event}`);
    assert.equal(entry.hooks[0].timeout, 10);
  }
});

test("versions agree and docs exist", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const plugin = JSON.parse(fs.readFileSync(path.join(root, ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(pkg.version, "0.1.1");
  assert.equal(plugin.version, pkg.version);
  assert.match(fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8"), /## 0\.1\.1/);
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  for (const section of ["Install", "How it works", "Privacy", "Cost", "Configuration", "Uninstall"]) {
    assert.match(readme, new RegExp(`^## ${section}`, "m"), section);
  }
});

test("no file mentions the project PEKA was inspired by", () => {
  const banned = new RegExp(["her", "mes"].join(""), "i");
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      if ([".git", "node_modules", ".superpowers"].includes(e.name)) return [];
      const p = path.join(dir, e.name);
      return e.isDirectory() ? walk(p) : [p];
    });
  for (const file of walk(root)) {
    assert.doesNotMatch(fs.readFileSync(file, "utf8"), banned, path.relative(root, file));
  }
});

test("agent prompts treat session text as data and forbid executable skill content", () => {
  for (const name of agents) {
    const body = fs.readFileSync(path.join(root, "agents", `${name}.md`), "utf8");
    assert.match(body, /`hooks`,\s+`allowed-tools`,\s+`shell`/, name);
    assert.match(body, /data,\s+not\s+instructions/, name);
  }
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  assert.match(readme, /PEKA_DISABLE=1/);
});
