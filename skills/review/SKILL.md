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
node "${CLAUDE_PLUGIN_ROOT}/scripts/peka.mjs" review --session ${CLAUDE_SESSION_ID}
```

If it succeeds, follow the instruction it prints exactly: launch the named agent in the
background with the prompt it gives. Then tell the user in one line that the review is
running in the background. If it fails, show the error.
