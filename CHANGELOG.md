# Changelog

## 0.1.3

- New `peka:learner` agent: `/peka:remember` now hands what you teach to it, and it
  decides whether that becomes a memory, a skill, or both, updating instead of
  duplicating.
- `/peka:skill <what>` saves a procedure as a reusable skill in PEKA's store.
- `/peka:audit` finds procedures saved as memories, facts saved as skills, skills saved
  outside PEKA, and index problems, and fixes what you approve.
- `/peka:audit adopt <skill>` moves a skill from `~/.claude/skills` into PEKA and links
  it back. Adopted skills are pinned; folders with `.git`, `node_modules`, or `.env` are
  refused; a failed adoption leaves the skill where it was.
- Claude is warned on the spot when it writes a skill straight into `~/.claude/skills`.
- `/peka:status` counts skills outside PEKA.
- Saving by hand resets the matching automatic-review counter.
- Stricter check before PEKA's agents save a skill without asking: only plain frontmatter
  keys, no `` !` `` or ```` ```! ```` command blocks, and edits are judged by the
  resulting file.
- The learner and curator each get their own actions file.

## 0.1.2

- `/peka:status` lists every memory (with its type and description) and every skill
  (with its description and usage), not just counts.
- `/peka:status show <name>` opens a memory or skill in full.

## 0.1.1

- `/peka:remember <what>` saves to global memory immediately, updating an existing
  memory instead of duplicating it.
- Every session (and every compaction) starts with a short brief telling Claude to check
  the memory index before a task, save corrections right away, and use learned skills.
- `peka where` prints the store locations.

## 0.1.0

First release.

- Global memory: `/peka:setup` points Claude Code's auto memory at `~/.peka/memory`.
- Background reviewer (`peka:reviewer`, Sonnet by default) saves memories and skills
  every 10 turns / 20 tool calls.
- Weekly curator (`peka:curator`, Opus by default) merges, tidies, and archives.
- Skill lifecycle: stale after 14 days unused, archived after 30, pinning to exempt.
- Learned skills are linked into `~/.claude/skills` without permission prompts, for
  PEKA's own agents only and never for skills that run commands or grant tools.
- No checkpoints in headless runs (`claude -p`, GitHub action, `claude mcp serve`);
  `PEKA_DISABLE=1` turns PEKA off entirely.
- Local git history of `~/.peka` after every review.
- `/peka:status`, `/peka:search`, `/peka:review`, `/peka:curate`.
