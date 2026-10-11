---
name: status
description: Show what PEKA has learned and its settings, or pin and unpin a learned skill. Use for /peka:status, /peka:status pin <skill>, or /peka:status unpin <skill>.
disable-model-invocation: true
argument-hint: "[pin <skill> | unpin <skill>]"
allowed-tools:
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/peka.mjs" status)
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/peka.mjs" pin *)
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/peka.mjs" unpin *)
---

# PEKA status

Arguments: `$ARGUMENTS`

- If the arguments start with `pin` or `unpin` followed by a skill name, run
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/peka.mjs" pin <skill>` (or `unpin <skill>`) and
  report the result. A pinned skill is never marked stale or archived.
- Otherwise run `node "${CLAUDE_PLUGIN_ROOT}/scripts/peka.mjs" status` and present the
  output as a short summary. Point out name conflicts, if any, and explain that PEKA
  leaves the user's own skill with that name alone.
