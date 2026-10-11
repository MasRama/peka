---
name: skill
description: Save a procedure as a reusable PEKA skill, available in every project. Use when the user runs /peka:skill or asks to turn something they taught or just did (a deploy, a release, a fix) into a skill.
argument-hint: <what to turn into a skill>
allowed-tools:
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/peka.mjs" learn *)
---

# Save as a skill

What to turn into a skill: `$ARGUMENTS`

If that is empty, use the procedure the user just taught or the task you just finished
together. If it is still unclear, ask one short question first.

1. Run:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/peka.mjs" learn --session "${CLAUDE_SESSION_ID}" --mode skill
   ```

   If it says PEKA is not set up, tell the user to run `/peka:setup` and stop.
2. Follow the instruction it prints: launch `peka:learner` with that prompt. In the
   `Request:` line, put the user's words plus the concrete steps from this conversation:
   commands that worked, the order, what went wrong, and how you confirmed success.
3. When it finishes, tell the user in one line which skill was created or updated.

Do not write the skill yourself, and never into `~/.claude/skills`; the learner puts it
in PEKA's store, where it is versioned, curated, and available everywhere.
