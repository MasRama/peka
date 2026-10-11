import fs from "node:fs";
import path from "node:path";
import { entriesFor } from "./digest.mjs";

const RADIUS = 150;

function sessionFiles(claudeHomeDir, project) {
  const projects = path.join(claudeHomeDir, "projects");
  let dirs = [];
  try {
    dirs = fs.readdirSync(projects, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return [];
  }
  const filter = project?.toLowerCase();
  const files = [];
  for (const dir of dirs) {
    if (filter && !dir.name.toLowerCase().includes(filter)) continue;
    for (const name of fs.readdirSync(path.join(projects, dir.name))) {
      if (!name.endsWith(".jsonl")) continue;
      const file = path.join(projects, dir.name, name);
      const stat = fs.statSync(file, { throwIfNoEntry: false });
      if (stat?.isFile()) files.push({ file, project: dir.name, session: name.slice(0, -6), mtime: stat.mtimeMs });
    }
  }
  return files.sort((a, b) => b.mtime - a.mtime);
}

function snippet(text, at) {
  const start = Math.max(0, at - RADIUS);
  const end = Math.min(text.length, at + RADIUS);
  const body = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${body}${end < text.length ? "…" : ""}`;
}

export function searchTranscripts(claudeHomeDir, terms, { project, limit = 10 } = {}) {
  const needles = terms.map((t) => String(t).toLowerCase()).filter(Boolean);
  if (!needles.length || limit < 1) return [];
  const hits = [];
  for (const s of sessionFiles(claudeHomeDir, project)) {
    let lines;
    try {
      lines = fs.readFileSync(s.file, "utf8").split("\n");
    } catch {
      continue;
    }
    const found = [];
    for (const line of lines) {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      for (const entry of entriesFor(record)) {
        const lower = entry.toLowerCase();
        if (needles.every((n) => lower.includes(n))) {
          found.push({ ...s, when: new Date(s.mtime).toISOString(), snippet: snippet(entry, lower.indexOf(needles[0])) });
        }
      }
    }
    for (const hit of found.reverse()) {
      delete hit.mtime;
      hits.push(hit);
      if (hits.length >= limit) return hits;
    }
  }
  return hits;
}
