---
name: review
description: Make PEKA learn from the current session right now instead of waiting for the next automatic checkpoint.
disable-model-invocation: true
allowed-tools:
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/peka.mjs" review *)
---

# Learn from this session now

Run:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/peka.mjs" review --session "${CLAUDE_SESSION_ID}"
```

If `${CLAUDE_PLUGIN_ROOT}` is not expanded in your environment (e.g. Devin CLI), replace `${CLAUDE_PLUGIN_ROOT}/scripts/peka.mjs` with `<Base directory>/../../scripts/peka.mjs` (or the PEKA CLI path from the session briefing), and omit `--session "${CLAUDE_SESSION_ID}"` if `${CLAUDE_SESSION_ID}` is not expanded.

If it succeeds, follow the instruction it prints exactly: launch the named agent with the
prompt it gives, wait for it, and end with the one line it asks for. If it fails, show
the error.
