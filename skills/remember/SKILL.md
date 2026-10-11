---
name: remember
description: Keep something for future sessions in PEKA. PEKA decides whether it becomes a memory (facts, preferences, corrections) or a skill (procedures). Use when the user runs /peka:remember, asks you to remember or note something, corrects you, or teaches you how to do something.
argument-hint: <what to remember>
allowed-tools:
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/peka.mjs" learn *)
---

# Remember this

What to keep: `$ARGUMENTS`

If that is empty, use what the user just asked you to keep. If it is still unclear, ask
one short question first.

1. Run:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/peka.mjs" learn --session "${CLAUDE_SESSION_ID}" --mode decide
   ```

   If it says PEKA is not set up, tell the user to run `/peka:setup` and stop.
2. Follow the instruction it prints: launch `peka:learner` with that prompt, putting the
   user's request in the `Request:` line in their own words, plus any details from this
   conversation the request depends on.
3. When it finishes, tell the user in one line what was saved and whether it became a
   memory, a skill, or both.

Do not write the memory or skill yourself; the learner keeps the store consistent.
