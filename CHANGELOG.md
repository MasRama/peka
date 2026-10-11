# Changelog

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
