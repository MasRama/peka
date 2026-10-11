// Just enough YAML frontmatter reading for memory and skill files: top-level `name` and
// `description`, plus `type` either at the top level or under `metadata:`.
function unquote(value) {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v;
}

export function readFrontmatter(text) {
  const m = typeof text === "string" ? text.match(/^---\r?\n([\s\S]*?)\r?\n---/) : null;
  if (!m) return {};
  const fields = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\s*)(name|description|type):\s*(.*)$/);
    if (kv && !(kv[2] in fields)) fields[kv[2]] = unquote(kv[3]);
  }
  return fields;
}
