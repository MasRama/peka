---
name: audit
description: Check PEKA's store for knowledge in the wrong place (procedures saved as memories, facts saved as skills, skills saved outside PEKA) and index problems, then fix what the user approves. Use for /peka:audit and /peka:audit adopt <skill>.
disable-model-invocation: true
argument-hint: "[adopt <skill>]"
allowed-tools:
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/peka.mjs" audit)
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/peka.mjs" show *)
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/peka.mjs" learn *)
---

# Audit PEKA

Arguments: `$ARGUMENTS`

## `adopt <skill>`

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/peka.mjs" adopt <skill>` and report the result.
Adopting moves a skill folder from `~/.claude/skills` into PEKA and links it back, so it
keeps working while gaining history and `/peka:status`. Adopted skills are pinned, so the
curator never archives them; `/peka:status unpin <skill>` hands them over fully. Folders
with a `.git`, `node_modules`, or `.env` are refused; pass that reason on.

## Otherwise: full audit

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/peka.mjs" audit`. If it says there is
   nothing to fix, tell the user and stop.
2. The script finds candidates by shape; you judge them. For each candidate in the
   "procedures" and "plain facts" sections, open it with
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/peka.mjs" show <name>` and decide whether it is
   really in the wrong place.
3. Show the user one short list of proposed fixes, for example:
   - `deploy-howto`: memory → skill (it is a 5-step procedure)
   - `api-port`: skill → memory (it is a single fact)
   - `deploy-staging` in `~/.claude/skills`: adopt into PEKA (looks learned, not
     hand-made)
   - add `loose` to `MEMORY.md`
   Leave out skills in `~/.claude/skills` that look like the user's own hand-made ones
   unless they ask; adopting is their call.
4. Ask which fixes to apply. Then:
   - **Conversions and index fixes**: run
     `node "${CLAUDE_PLUGIN_ROOT}/scripts/peka.mjs" learn --session "${CLAUDE_SESSION_ID}" --mode decide`
     and launch `peka:learner` as it says, with a `Request:` that lists each approved
     fix precisely (for example "convert memory deploy-howto into a skill and retire the
     memory; add loose.md to MEMORY.md").
   - **Adoptions**: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/peka.mjs" adopt <skill>` for
     each one approved.
   - Skills flagged as able to run commands: show them to the user; change nothing
     unless asked.
5. Finish with one line per change made.
