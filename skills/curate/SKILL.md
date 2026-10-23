---
name: curate
description: Run PEKA's curator now to merge overlapping skills, tidy the memory index, and retire unused entries.
disable-model-invocation: true
allowed-tools:
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/peka.mjs" curate)
---

# Tidy PEKA now

Run:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/peka.mjs" curate
```

If it succeeds, follow the instruction it prints exactly: launch the named agent with the
prompt it gives, wait for it, and end with the one line it asks for, adding that retired
items go to `~/.peka/archive`, never deleted. If it fails, show the error.
