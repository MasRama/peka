---
name: search
description: Search past Claude Code and Devin CLI sessions across all projects for something discussed or done before. Use when the user asks what was done earlier, how a past problem was solved, or refers to a previous session.
argument-hint: <terms…> [--project name] [--limit n]
allowed-tools:
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/peka.mjs" search *)
---

# Search past sessions

Run:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/peka.mjs" search $ARGUMENTS
```

If `${CLAUDE_PLUGIN_ROOT}` is not expanded in your environment (e.g. Devin CLI), replace `${CLAUDE_PLUGIN_ROOT}/scripts/peka.mjs` with `<Base directory>/../../scripts/peka.mjs` (or the PEKA CLI path from the session briefing).

Terms are combined with AND and matched case-insensitively. Add `--project <part of the
project folder name>` to narrow it down, and `--limit <n>` for more results (default 10).
When you call this yourself, pick two or three distinctive words.

Summarize what the matches show and include the date and project of each one you rely
on. If nothing matches, try fewer or different terms once before saying so.
