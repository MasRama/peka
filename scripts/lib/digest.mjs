import fs from "node:fs";
import path from "node:path";
import { safeId } from "./state.mjs";

const OMITTED = "[… earlier part of the session omitted …]";
// Text Claude Code injects into user turns; none of it is the user speaking.
const INJECTED = /<(system-reminder|task-notification|local-command-caveat|local-command-stdout)>[\s\S]*?<\/\1>/g;

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function clean(text) {
  return typeof text === "string" ? text.replace(INJECTED, "").trim() : "";
}

function blockText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

export function entriesFor(record) {
  if (!record || typeof record !== "object" || record.isSidechain) return [];
  const content = record.message?.content;
  const out = [];

  if (record.type === "user") {
    if (record.isMeta || record.isCompactSummary || record.promptSource === "system") return out;
    if (typeof content === "string") {
      const text = clean(content);
      if (text) out.push(`USER: ${text}`);
      return out;
    }
    if (!Array.isArray(content)) return out;
    for (const block of content) {
      if (block?.type === "text") {
        const text = clean(block.text);
        if (text) out.push(`USER: ${text}`);
      } else if (block?.type === "tool_result" && block.is_error) {
        const text = clean(blockText(block.content));
        if (text) out.push(`[tool error] ${clip(text, 300)}`);
      }
    }
    return out;
  }

  if (record.type === "assistant" && Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === "text") {
        const text = clean(block.text);
        if (text) out.push(`ASSISTANT: ${clip(text, 2000)}`);
      } else if (block?.type === "tool_use") {
        out.push(`TOOL ${block.name}: ${clip(JSON.stringify(block.input ?? {}), 300)}`);
      }
    }
  }
  return out;
}

function keepTail(entries, maxChars) {
  const full = entries.join("\n");
  if (full.length <= maxChars) return full;
  const budget = maxChars - OMITTED.length - 1;
  const kept = [];
  let size = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const cost = entries[i].length + (kept.length ? 1 : 0);
    if (size + cost > budget) {
      if (!kept.length) kept.push(entries[i].slice(-Math.max(budget, 0)));
      break;
    }
    kept.unshift(entries[i]);
    size += cost;
  }
  return [OMITTED, ...kept].join("\n");
}

export function buildDigest(transcriptPath, fromLine, { maxChars = 60000, lastAssistantMessage } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(transcriptPath, "utf8");
  } catch {
    return { text: "", toLine: fromLine };
  }
  // The last element is either "" or a line still being written; never read it.
  const lines = raw.split("\n").slice(0, -1);
  const start = fromLine > lines.length ? 0 : Math.max(0, fromLine);

  const entries = [];
  for (const line of lines.slice(start)) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    entries.push(...entriesFor(record));
  }

  const last = clean(lastAssistantMessage);
  if (last) {
    const entry = `ASSISTANT: ${clip(last, 2000)}`;
    if (entries.at(-1) !== entry) entries.push(entry);
  }
  return { text: keepTail(entries, maxChars), toLine: lines.length };
}

export function writeDigest(d, { sessionId, cwd, text, now }) {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, "");
  const file = path.join(d.digests, `${safeId(sessionId)}-${stamp}.md`);
  const header = ["# Session digest", "", `Session: ${sessionId ?? "unknown"}`, `Project: ${cwd ?? "unknown"}`, "", ""].join("\n");
  fs.mkdirSync(d.digests, { recursive: true });
  fs.writeFileSync(file, `${header}${text}\n`);
  return file;
}
