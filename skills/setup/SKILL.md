---
name: setup
description: Set up PEKA global memory and background learning. Use when the user runs /peka:setup or asks to turn PEKA on.
disable-model-invocation: true
allowed-tools:
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/peka.mjs" setup --check)
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/peka.mjs" legacy)
---

# Set up PEKA

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/peka.mjs" setup --check` and read the output.
2. Explain to the user, briefly and in their language:
   - PEKA keeps one global memory and a library of learned skills in `~/.peka`, shared by
     every project, with local git history as a safety net.
   - Every few turns a reviewer agent saves what is worth remembering (the session pauses
     briefly while it works and ends with one line on what it saved), and
     about once a week a curator agent tidies it. Both run as normal Claude Code
     subagents and count toward usage like any other subagent.
   - The exact settings changes listed in the check output. A backup of `settings.json`
     is written before anything changes.
3. Ask the user whether to apply. If they decline, stop here.
4. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/peka.mjs" setup --apply` and report the result.
   If it fails because `settings.json` is not valid JSON, show the error and ask the user
   to fix the file; do not edit it yourself.
5. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/peka.mjs" legacy`. If it lists old
   per-project memories, show the list and ask whether to import them into the global
   memory. Only if the user agrees:
   - Read each listed file.
   - Write it into the PEKA memory directory shown by setup, using the same frontmatter
     format (`name`, `description`, `metadata.type`). Merge duplicates, and name the
     project inside project-specific memories, because the memory is now shared.
   - Add one line per imported memory to `MEMORY.md` in that directory.
   - Leave the original files where they are.
6. Tell the user to start a new session so the global memory loads.
