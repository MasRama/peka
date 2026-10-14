import { execFileSync } from "node:child_process";

// What PEKA's store gained, changed, or retired, read from its git history so the user sees
// what was actually written rather than what an agent said it wrote.

const STRENGTH = { updated: 0, added: 1, archived: 2 };
const SEP = "\x1e";

function git(home, args) {
  return execFileSync("git", args, { cwd: home, stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).toString();
}

export function headCommit(home) {
  try {
    return git(home, ["rev-parse", "--verify", "-q", "HEAD"]).trim() || null;
  } catch {
    return null;
  }
}

export function commitExists(home, sha) {
  if (typeof sha !== "string" || !/^[0-9a-f]{4,64}$/i.test(sha)) return false;
  try {
    git(home, ["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

// memory/<name>.md and skills/<name>/… are items; the index, sub-indexes, and archive are not.
function itemOf(file) {
  const memory = file.match(/^memory\/([^/]+)\.md$/);
  if (memory) return memory[1] === "MEMORY" ? null : { kind: "memory", name: memory[1] };
  const skill = file.match(/^skills\/([^/]+)\//);
  return skill ? { kind: "skill", name: skill[1] } : null;
}

function byKindAndName(a, b) {
  return a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name);
}

function itemsOf(lines) {
  const items = new Map();
  const note = (file, status) => {
    const item = itemOf(file);
    if (!item) return;
    const key = `${item.kind}:${item.name}`;
    const prev = items.get(key);
    if (!prev || STRENGTH[status] > STRENGTH[prev.status]) items.set(key, { ...item, status });
  };
  for (const line of lines) {
    const [code, a, b] = line.split("\t");
    if (!code || !a) continue;
    if (code.startsWith("R")) {
      note(a, "archived");
      note(b, "added");
    } else if (code === "A" || code.startsWith("C")) note(b ?? a, "added");
    else if (code === "D") note(a, "archived");
    else note(a, "updated");
  }
  return [...items.values()].sort(byKindAndName);
}

// Commits after `fromSha` (or all, when null), newest first, each with its items.
export function changesSince(home, fromSha, { since } = {}) {
  const args = ["log", "-M", "--name-status", `--format=${SEP}%H%x09%cI%x09%s`];
  if (since) args.push(`--since=${since.toISOString()}`);
  args.push(fromSha ? `${fromSha}..HEAD` : "HEAD", "--");
  let raw;
  try {
    if (!headCommit(home)) return [];
    raw = git(home, args);
  } catch {
    return [];
  }
  return raw
    .split(SEP)
    .filter((chunk) => chunk.trim())
    .map((chunk) => {
      const [header, ...rest] = chunk.split("\n");
      const [sha, date, ...subject] = header.split("\t");
      return { sha, date, subject: subject.join("\t"), items: itemsOf(rest.filter(Boolean)) };
    });
}

// One entry per item over several commits (newest first): the latest status wins, except
// that something added and then updated in the same window is still new.
export function mergeItems(commits) {
  const items = new Map();
  for (const c of [...commits].reverse()) {
    for (const item of c.items) {
      const key = `${item.kind}:${item.name}`;
      const prev = items.get(key);
      const status = prev?.status === "added" && item.status === "updated" ? "added" : item.status;
      items.set(key, { ...item, status });
    }
  }
  return [...items.values()].sort(byKindAndName);
}

function noun(kind, n) {
  return n === 1 ? kind : kind === "memory" ? "memories" : "skills";
}

export function summarize(items) {
  const parts = [];
  for (const kind of ["memory", "skill"]) {
    for (const status of ["added", "updated", "archived"]) {
      const n = items.filter((i) => i.kind === kind && i.status === status).length;
      if (!n) continue;
      parts.push(status === "added" ? `+${n} ${noun(kind, n)}` : `${n} ${noun(kind, n)} ${status}`);
    }
  }
  return parts.join(", ");
}

export function describe(items) {
  return items.map((i) => `${i.kind} ${i.name} ${i.status}`).join("; ");
}
