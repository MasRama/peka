---
name: remember
description: Save something to PEKA's global memory right now. Use when the user runs /peka:remember, or asks you to remember, note, or keep something in mind for future sessions.
argument-hint: <what to remember>
allowed-tools:
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/peka.mjs" where)
---

# Remember this

What to remember: `$ARGUMENTS`

If that is empty, use what the user just asked you to remember. If it is still unclear,
ask one short question.

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/peka.mjs" where` to get the memory directory.
   If it says PEKA is not set up, tell the user to run `/peka:setup` and stop.
2. Read `MEMORY.md` in that directory and any memory file whose title looks related.
3. If an existing memory covers the same thing, update that file. Otherwise create
   `<memory dir>/<short-kebab-name>.md`:

   ```markdown
   ---
   name: <short-kebab-name>
   description: <one line saying when this is relevant>
   metadata:
     type: user | feedback | project | reference
   ---

   <the fact, in the user's own terms>
   ```

   - `user`: about the person. `feedback`: how they want you to work; add **Why:** and
     **How to apply:** lines. `project`: goals, decisions, constraints of a named
     project. `reference`: where something lives outside the code.
   - Name the project for project-specific facts; the memory is shared by all projects.
   - Write absolute dates, never "tomorrow" or "next week".
   - Never store passwords, tokens, or keys. If asked to, say so and store only where
     the secret lives (for example "in 1Password, item X").
4. Add or update one line in `MEMORY.md`: `- [Title](file.md) — short hook`.
5. Confirm in one line what you saved, and whether it was new or an update.
