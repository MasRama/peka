# PEKA — Design (v0.1.0)

> Your coding agent learns from experience.

PEKA is a Claude Code plugin that makes Claude remember who you are and get better at
the work you do together, across every project, without you asking it to.

## Goals

1. **Global memory.** One memory store for all projects, loaded into every session.
2. **Automatic learning.** Every few turns, a background reviewer reads what just happened
   and saves durable memories and reusable skills. No approval step.
3. **Self-maintenance.** A weekly curator merges overlapping skills, tidies memory, and
   archives skills that stopped being useful. Nothing is ever hard-deleted.
4. **Native and compliant.** Only Claude Code features: hooks, plugin subagents, skills,
   auto memory. No `claude -p`, no Agent SDK, no external API, no network.
5. **Safe to share.** Zero npm dependencies, never touches user files outside its own
   home except two settings keys the user approves in `/peka:setup`.

Non-goals for v0.1: vector search, cloud sync, multi-machine sync, Windows symlink
fallbacks beyond Node's `junction` type, editing skills PEKA did not create.

## Storage layout

```
~/.peka/                      (override: PEKA_HOME)
├── memory/                   autoMemoryDirectory: MEMORY.md index + one file per memory
├── skills/<name>/SKILL.md    learned skills (source of truth)
├── archive/skills/<name>/    retired skills
├── state/                    git-ignored runtime state
│   ├── setup.json            written by /peka:setup
│   ├── sessions/<id>.json    per-session counters
│   ├── usage.json            per-skill usage + lifecycle
│   ├── curator.json          curator schedule
│   ├── digests/*.md          transcript digests handed to the reviewer
│   ├── curator-report.md     input for the curator
│   ├── curator-actions.json  curator's requested archive/delete actions
│   └── peka.log              hook error log
└── .git                      local history, auto-commit after each review
```

`~/.claude/skills/<name>` is a symlink to `~/.peka/skills/<name>`, created and removed by
hook scripts. Claude Code loads personal skills through symlinks; hook scripts are not
subject to Claude's permission checks, and `~/.peka` is not a protected path, so the
reviewer never triggers a permission prompt.

## Settings changed by `/peka:setup` (with consent, backup first)

- `autoMemoryDirectory: "~/.peka/memory"` — makes native auto memory global.
- `cleanupPeriodDays` raised to at least `365` — keeps transcripts for session search.

## Configuration (plugin `userConfig`, editable in `/config`)

| Key | Default | Meaning |
|---|---|---|
| `memory_interval` | `10` | user turns without a memory write before a review (0 = off) |
| `skill_interval` | `20` | main-agent tool calls without a skill write before a review (0 = off) |
| `reviewer_model` | `sonnet` | one of `sonnet`, `opus`, `haiku`, `inherit` |
| `curator_model` | `opus` | one of `sonnet`, `opus`, `haiku`, `inherit` |
| `auto_commit` | `true` | commit `~/.peka` after each reviewer/curator run |

Fixed in v0.1: curator every 7 days; skills stale after 14 days unused, archived after 30.

## Hook flow

All hooks run `node "${CLAUDE_PLUGIN_ROOT}/scripts/hook.mjs" <Event>`. A hook never fails
the session: any error is appended to `state/peka.log` and the hook exits 0 silently.
Before `/peka:setup` has run, every hook is a no-op except a one-line SessionStart notice.

| Event | Behavior |
|---|---|
| SessionStart | Ensure dirs; daily lifecycle pass (stale/archive by age, pinned exempt); sync skill symlinks; return `reloadSkills: true` when links changed. |
| UserPromptSubmit | Main agent only: `turnsSinceMemory += 1`. |
| PreToolUse (`Write\|Edit\|Read\|Glob\|Grep`) | Allow without prompt: `.md` reads/writes under `memory/` and `skills/`, reads under `state/`, writes to `state/curator-actions.json`. Deny writes through a `~/.claude/skills/<name>` symlink that points into PEKA, with the real path in the reason. Everything else: no opinion. |
| PostToolUse (`*`) | Main agent only: `toolsSinceSkill += 1`; memory write resets `turnsSinceMemory`; skill write resets `toolsSinceSkill` and syncs links; `Skill` tool call or `Read` of a PEKA `SKILL.md` records usage. |
| Stop | Skip when `stop_hook_active`, inside a subagent, or a `peka:` subagent is already in `background_tasks`. If a counter reached its interval: write a digest of the transcript since the last review, reset the due counters, and return `additionalContext` telling Claude to launch `peka:reviewer` in the background. Else, if the curator is due (and not prompted in the last 24 h): write `curator-report.md` and tell Claude to launch `peka:curator`. First curator check only seeds the schedule. |
| SubagentStop (`^peka:(reviewer\|curator)$`) | Apply `curator-actions.json` (curator only), sync symlinks, mark curator run, prune digests older than 7 days, auto-commit. |

## Reviewer (`agents/reviewer.md`)

`model: sonnet`, `background: true`, tools `Read, Write, Edit, Glob, Grep` (no Bash, so it
cannot run builds, tests, or installs). Input: digest path, focus (memory / skills / both),
memory dir, skills dir. It writes memories in the native auto-memory format and class-level
skills, prefers updating over creating, and ends with a one-line summary. Prompt text is
original to PEKA.

## Curator (`agents/curator.md`)

`model: opus`, `background: true`, same tools. Input: `curator-report.md` (skills with
uses, last use, state, pinned; memory file count; index line count). It merges overlapping
skills, tightens the memory index, and requests deletions/archives via
`curator-actions.json`, which the SubagentStop hook validates and applies.

## Plugin skills

- `/peka:setup` (user-invoked): check → explain → apply settings → offer to import old
  per-project memories (list first, merge only after the user agrees).
- `/peka:search`: search past session transcripts (`~/.claude/projects/**/*.jsonl`).
- `/peka:status`: counters, memory/skill counts, last curator run, pin/unpin skills.
- `/peka:review`: learn from the current session now.
- `/peka:curate`: run the curator now.

All logic lives in `scripts/peka.mjs` (CLI) and `scripts/lib/*`; skills only orchestrate.

## Edge cases

- **Stop loop:** guarded by `stop_hook_active` and by resetting counters when the
  checkpoint fires; Claude Code also caps consecutive continuations at 8.
- **Parallel sessions:** counters are per session file; shared JSON uses atomic
  write-then-rename; last writer wins on `usage.json` (acceptable).
- **Huge transcripts:** digest reads only lines after the last reviewed line and keeps the
  most recent 60 000 characters.
- **Name collision:** if `~/.claude/skills/<name>` already exists and is not PEKA's link,
  PEKA leaves it alone and reports a conflict in `/peka:status`.
- **Path escape:** guard resolves `~`, `..`, and symlinks of the nearest existing ancestor
  before deciding; anything resolving outside the PEKA dirs gets no allow.
- **Corrupt settings.json:** setup aborts without writing.
- **No git:** auto-commit silently disabled.

## Release

v0.1.0, MIT, Node ≥ 18, macOS/Linux tested (Windows uses `junction` links, untested).
