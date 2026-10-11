# PEKA

> Your coding agent learns from experience.

PEKA is a Claude Code plugin that gives Claude one memory shared by all your projects and
lets it learn on its own. Every few turns a background agent looks at what just happened
and saves what is worth keeping: your preferences, corrections you made, project facts,
and step-by-step procedures it can reuse later. Once a week another agent tidies
everything up.

You keep working; nothing asks for approval. Everything stays on your machine, in plain
Markdown, with git history.

- **Global memory.** One store in `~/.peka`, loaded into every session in every project.
- **Learns by itself.** Memories and reusable skills are written by a background
  reviewer while you work.
- **Keeps itself tidy.** A weekly curator merges duplicates, fixes the index, and
  archives skills you stopped using. Nothing is ever hard-deleted.
- **Native.** Uses only Claude Code's own hooks, subagents, skills, and auto memory. No
  extra API keys, no external services, no network calls, no npm dependencies.

## Install

Requires Claude Code with plugin support, Node.js 18 or later, and git (optional, for
history).

```
/plugin marketplace add MasRama/peka
/plugin install peka@peka
```

Then, in any session:

```
/peka:setup
```

Setup shows exactly what it will change and asks before changing anything. It sets two
keys in `~/.claude/settings.json`, after writing a backup next to it:

| Key | Value | Why |
|---|---|---|
| `autoMemoryDirectory` | `~/.peka/memory` | makes Claude Code's built-in memory global instead of per project |
| `cleanupPeriodDays` | at least `365` | keeps session history around so `/peka:search` can find it |

If you already have per-project memories, setup lists them and offers to merge them into
the global memory. The originals are left in place.

Start a new session afterwards.

## How it works

```
~/.peka/
├── memory/               global memory (MEMORY.md index + one file per memory)
├── skills/<name>/        skills PEKA learned, linked into ~/.claude/skills/<name>
├── archive/              retired skills and memories
├── state/                counters, usage, digests, logs (not in git)
└── .git                  local history, committed after every review
```

1. **Counting.** Hooks count your turns since Claude last saved a memory and tool calls
   since it last saved a skill.
2. **Checkpoint.** When a counter reaches its interval (10 turns / 20 tool calls by
   default), PEKA writes a compact digest of the recent conversation and asks Claude to
   launch the `peka:reviewer` agent in the background.
3. **Review.** The reviewer reads the digest and your existing memory, then saves or
   updates memories and skills. It has no shell access: it can only read files and edit
   files inside `~/.peka`.
4. **Commit.** When the reviewer finishes, PEKA links new skills into
   `~/.claude/skills` and commits `~/.peka` to its local git repository.
5. **Curate.** About once a week the `peka:curator` agent merges overlapping skills and
   memories and tightens the index. Skills unused for 14 days are marked stale and
   archived after 30, unless you pin them.

PEKA writes skills to `~/.peka` and only links them into `~/.claude/skills`, so the
background agents do not trigger permission prompts. That shortcut is limited on
purpose:

- Only PEKA's own reviewer and curator get it. When Claude in your main session writes a
  PEKA skill, you are asked as usual.
- A skill containing `hooks`, `allowed-tools`, `shell`, or `` !` `` command lines is never
  saved without your approval, because those make a skill run commands or pre-approve
  tools.

If you already have a skill with the same name, PEKA leaves yours alone and reports the
conflict in `/peka:status`.

### Commands

| Command | What it does |
|---|---|
| `/peka:setup` | first-time setup and import of old memories |
| `/peka:status` | what PEKA knows, skill usage, settings |
| `/peka:status pin <skill>` | never mark this skill stale or archive it (`unpin` to undo) |
| `/peka:search <terms>` | search your past sessions in all projects |
| `/peka:review` | learn from the current session now |
| `/peka:curate` | tidy memory and skills now |

## Privacy

- Everything lives under `~/.peka` and `~/.claude` on your machine. PEKA makes no network
  calls and the git repository has no remote.
- Session digests handed to the reviewer are stored in `~/.peka/state/digests` and
  removed after 7 days.
- The reviewer is told never to store secrets, but it reads what you said in the
  session. Look through `~/.peka/memory` now and then, and do not add a remote to
  `~/.peka` unless you are comfortable with its contents leaving your machine.

## Terms of use

PEKA is built only from features Claude Code provides for this purpose: plugins, hooks,
subagents, skills, and auto memory. It does not read or reuse your login or API
credentials, does not call any Anthropic API itself, does not start `claude -p` or the
Agent SDK, and does not share your account with another app. Reviews run inside your own
Claude Code session, under the same terms as everything else you do there.

## Cost

The reviewer and curator are ordinary Claude Code subagents running in your session, so
they count toward your usage the same way any subagent does. With the defaults, a
reviewer (Sonnet) runs at most once every 10 turns and the curator (Opus) about once a
week. To spend less, raise the intervals, pick `haiku` for the reviewer, or set an
interval to `0` to turn that kind of review off.

## Configuration

Set when you enable the plugin, and editable later in `/config`:

| Option | Default | Meaning |
|---|---|---|
| `memory_interval` | `10` | your turns without a saved memory before a review (`0` = off) |
| `skill_interval` | `20` | tool calls without a saved skill before a review (`0` = off) |
| `reviewer_model` | `sonnet` | `sonnet`, `opus`, `haiku`, or `inherit` |
| `curator_model` | `opus` | `sonnet`, `opus`, `haiku`, or `inherit` |
| `auto_commit` | `true` | commit `~/.peka` after each review |

Environment variables:

- `PEKA_HOME`: keep the store somewhere other than `~/.peka`, then run `/peka:setup`
  again.
- `PEKA_DISABLE=1`: turn PEKA off completely for that process.

PEKA never starts a review or curator run in a session with no one at the keyboard
(`claude -p`, the GitHub action, `claude mcp serve`), so scripts get their normal output.
If you drive Claude Code from your own Agent SDK script, set `PEKA_DISABLE=1` for it.

## Uninstall

```
/plugin uninstall peka@peka
```

Then, if you want Claude Code's memory back to per project:

1. Remove `autoMemoryDirectory` from `~/.claude/settings.json` (or restore the
   `settings.json.peka-backup-*` file setup created).
2. Remove the skill links PEKA created:
   `find ~/.claude/skills -maxdepth 1 -type l -lname "$HOME/.peka/*" -delete`
3. Delete `~/.peka` if you no longer want what it learned.

## Development

```
npm test
claude plugin validate .
```

## License

MIT
