---
name: status
description: List everything PEKA has learned (each memory and skill with its description), open one in full, show what changed recently, or pin and unpin a skill. Use for /peka:status, /peka:status show <name>, /peka:status log [days], /peka:status pin <skill>, or /peka:status unpin <skill>.
disable-model-invocation: true
argument-hint: "[show <name> | log [days] | pin <skill> | unpin <skill>]"
allowed-tools:
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/peka.mjs" status)
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/peka.mjs" show *)
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/peka.mjs" log)
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/peka.mjs" log *)
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/peka.mjs" pin *)
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/peka.mjs" unpin *)
---

# PEKA status

Arguments: `$ARGUMENTS`

- If the arguments start with `show` followed by a name, run
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/peka.mjs" show <name>` and present the file's
  content as it is.
- If the arguments start with `log`, run
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/peka.mjs" log` (add the number of days if one was
  given) and show the list as it is. If the user wants to undo a change, show them the
  `git revert` command it prints; do not run it yourself unless they ask.
- If the arguments start with `pin` or `unpin` followed by a skill name, run
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/peka.mjs" pin <skill>` (or `unpin <skill>`) and
  report the result. A pinned skill is never marked stale or archived.
- Otherwise run `node "${CLAUDE_PLUGIN_ROOT}/scripts/peka.mjs" status` and show the
  user the full lists of memories and skills it prints, with their descriptions and
  project groups; do not reduce them to counts. Point out name conflicts, if any, and explain that PEKA leaves
  the user's own skill with that name alone.
