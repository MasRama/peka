import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const OMITTED = "[… earlier part of the session omitted …]";
const RADIUS = 150;
const INJECTED_BLOCKS =
  /<(t3_code_instructions|runtime_info|pull_request_linking|system_info|available_skills|system_guidance|system-reminder|task-notification|local-command-caveat|local-command-stdout)\b[^>]*>[\s\S]*?<\/\1>|<rules\b[^>]*>[\s\S]*?<\/rules>/g;

let cachedSqlite = undefined;

function loadNodeSqlite() {
  if (cachedSqlite !== undefined) return cachedSqlite;
  const orig = process.emitWarning;
  process.emitWarning = (warning, ...args) => {
    const msg = typeof warning === "string" ? warning : warning?.message ?? "";
    if (msg.includes("SQLite is an experimental feature")) return;
    return orig.call(process, warning, ...args);
  };
  try {
    const req = createRequire(import.meta.url);
    cachedSqlite = req("node:sqlite").DatabaseSync ?? null;
  } catch {
    cachedSqlite = null;
  } finally {
    process.emitWarning = orig;
  }
  return cachedSqlite;
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

function queryRows(dbPath, sql, params = []) {
  if (!dbPath || !fs.existsSync(dbPath)) return [];
  const DatabaseSync = loadNodeSqlite();
  if (DatabaseSync) {
    let db = null;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      return db.prepare(sql).all(...params);
    } catch {
      return [];
    } finally {
      try {
        db?.close();
      } catch {
        // Ignore close errors.
      }
    }
  }
  let idx = 0;
  const inlined = sql.replace(/\?/g, () => sqlLiteral(params[idx++]));
  try {
    const out = execFileSync("sqlite3", ["-readonly", "-json", dbPath, inlined], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
    return out ? JSON.parse(out) : [];
  } catch {
    return [];
  }
}

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

function cleanUserText(raw) {
  if (typeof raw !== "string") return "";
  let text = raw.replace(INJECTED_BLOCKS, "");
  const wrapped = text.match(/<user_request>([\s\S]*?)<\/user_request>/);
  if (wrapped) text = wrapped[1];
  return text.trim();
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

function snippet(text, at) {
  const start = Math.max(0, at - RADIUS);
  const end = Math.min(text.length, at + RADIUS);
  const body = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${body}${end < text.length ? "…" : ""}`;
}

export function entriesForDevinMessage(msg) {
  if (!msg || typeof msg !== "object") return [];
  const out = [];
  const role = msg.role;
  const raw = contentText(msg.content);

  if (role === "user") {
    const meta = msg.metadata;
    if (meta && meta.is_user_input === false) return out;
    if (meta?.telemetry?.source && meta.telemetry.source !== "user") return out;
    const text = cleanUserText(raw);
    if (text) out.push(`USER: ${text}`);
    return out;
  }

  if (role === "assistant") {
    const text = raw.replace(INJECTED_BLOCKS, "").trim();
    if (text) out.push(`ASSISTANT: ${clip(text, 2000)}`);
    if (Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (!tc?.name) continue;
        const args = typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments ?? {});
        out.push(`TOOL ${tc.name}: ${clip(args, 300)}`);
      }
    }
    return out;
  }

  if (role === "tool") {
    const text = raw.trim();
    const isError =
      msg.is_error === true ||
      msg.metadata?.is_error === true ||
      /Exit code:\s*[1-9]\d*/.test(text) ||
      /^(Error:|Tool rejected:)/i.test(text);
    if (isError && text) out.push(`[tool error] ${clip(text, 300)}`);
  }
  return out;
}

export function hasDevinSession(dbPath, sessionId) {
  if (!sessionId) return false;
  const rows = queryRows(dbPath, "SELECT 1 AS ok FROM sessions WHERE id = ? LIMIT 1", [sessionId]);
  return rows.length > 0;
}

export function findLatestDevinSession(dbPath, cwd) {
  const dir = typeof cwd === "string" && cwd ? path.resolve(cwd) : null;
  if (dir) {
    const exact = queryRows(
      dbPath,
      "SELECT id, working_directory FROM sessions WHERE working_directory = ? ORDER BY last_activity_at DESC LIMIT 1",
      [dir],
    );
    if (exact.length) return { id: exact[0].id, workingDirectory: exact[0].working_directory };
  }
  const latest = queryRows(
    dbPath,
    "SELECT id, working_directory FROM sessions ORDER BY last_activity_at DESC LIMIT 1",
  );
  return latest.length ? { id: latest[0].id, workingDirectory: latest[0].working_directory } : null;
}

function mainChainNodes(dbPath, sessionId) {
  const sess = queryRows(dbPath, "SELECT main_chain_id FROM sessions WHERE id = ? LIMIT 1", [sessionId]);
  if (!sess.length) return [];
  const head = sess[0].main_chain_id;
  if (head !== null && head !== undefined) {
    const chain = queryRows(
      dbPath,
      `WITH RECURSIVE chain(node_id, parent_node_id, chat_message, depth) AS (
         SELECT node_id, parent_node_id, chat_message, 0
         FROM message_nodes
         WHERE session_id = ? AND node_id = ?
         UNION ALL
         SELECT m.node_id, m.parent_node_id, m.chat_message, c.depth + 1
         FROM message_nodes m
         JOIN chain c ON m.session_id = ? AND m.node_id = c.parent_node_id
         WHERE c.depth < 10000
       )
       SELECT node_id, chat_message FROM chain ORDER BY depth DESC`,
      [sessionId, head, sessionId],
    );
    if (chain.length) return chain;
  }
  return queryRows(
    dbPath,
    "SELECT node_id, chat_message FROM message_nodes WHERE session_id = ? ORDER BY node_id ASC",
    [sessionId],
  );
}

export function buildDevinDigest(dbPath, sessionId, fromNodeId = 0, { maxChars = 60000, lastAssistantMessage } = {}) {
  const nodes = mainChainNodes(dbPath, sessionId);
  if (!nodes.length) {
    const last = typeof lastAssistantMessage === "string" ? lastAssistantMessage.replace(INJECTED_BLOCKS, "").trim() : "";
    return { text: last ? `ASSISTANT: ${clip(last, 2000)}` : "", toLine: fromNodeId };
  }
  const maxNode = Math.max(...nodes.map((n) => Number(n.node_id) || 0));
  const startAfter = fromNodeId > maxNode ? -1 : fromNodeId;
  const entries = [];
  for (const row of nodes) {
    const nid = Number(row.node_id) || 0;
    if (startAfter >= 0 && nid <= startAfter) continue;
    let msg;
    try {
      msg = JSON.parse(row.chat_message);
    } catch {
      continue;
    }
    entries.push(...entriesForDevinMessage(msg));
  }
  const last = typeof lastAssistantMessage === "string" ? lastAssistantMessage.replace(INJECTED_BLOCKS, "").trim() : "";
  if (last) {
    const entry = `ASSISTANT: ${clip(last, 2000)}`;
    if (entries.at(-1) !== entry) entries.push(entry);
  }
  return { text: keepTail(entries, maxChars), toLine: maxNode };
}

function isoFromTimestamp(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return new Date(0).toISOString();
  // Handle seconds, milliseconds, or microseconds.
  const ms = n > 1e14 ? Math.floor(n / 1000) : n < 1e11 ? n * 1000 : n;
  return new Date(ms).toISOString();
}

export function searchDevinTranscripts(dbPath, terms, { project, limit = 10 } = {}) {
  const needles = terms.map((t) => String(t).toLowerCase()).filter(Boolean);
  if (!needles.length || limit < 1 || !dbPath || !fs.existsSync(dbPath)) return [];
  const likeClauses = needles.map(() => "lower(m.chat_message) LIKE ? ESCAPE '\\'").join(" AND ");
  const likeParams = needles.map((n) => `%${n.replace(/[\\%_]/g, "\\$&")}%`);
  const sessions = queryRows(
    dbPath,
    `SELECT s.id, s.working_directory, s.last_activity_at
     FROM sessions s
     WHERE EXISTS (
       SELECT 1 FROM message_nodes m
       WHERE m.session_id = s.id AND ${likeClauses}
     )
     ORDER BY s.last_activity_at DESC
     LIMIT 200`,
    likeParams,
  );
  const filter = project?.toLowerCase();
  const hits = [];
  for (const s of sessions) {
    const dir = String(s.working_directory ?? "");
    const projLabel = path.basename(dir) || dir || "devin";
    if (filter && !dir.toLowerCase().includes(filter) && !projLabel.toLowerCase().includes(filter)) continue;
    const nodes = mainChainNodes(dbPath, s.id);
    const found = [];
    for (const row of nodes) {
      let msg;
      try {
        msg = JSON.parse(row.chat_message);
      } catch {
        continue;
      }
      for (const entry of entriesForDevinMessage(msg)) {
        const lower = entry.toLowerCase();
        if (needles.every((n) => lower.includes(n))) {
          found.push({
            project: projLabel,
            session: s.id,
            when: isoFromTimestamp(s.last_activity_at),
            snippet: snippet(entry, lower.indexOf(needles[0])),
          });
        }
      }
    }
    for (const hit of found.reverse()) {
      hits.push(hit);
      if (hits.length >= limit) return hits;
    }
  }
  return hits;
}
