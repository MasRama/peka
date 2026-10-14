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
- **Remembers on purpose.** Say `/peka:remember …` or `/peka:skill …` and it is filed
  immediately, as a memory or a skill, whichever fits.
- **Learns by itself.** Memories and reusable skills are written by a background
  reviewer while you work.
- **Knows which project you are in.** Memories and skills can belong to a project. A
  session sees your global memories plus the current project's in full; other projects
  show up as one line each, so the context stays lean as the store grows.
- **Keeps itself tidy.** A weekly curator merges duplicates and archives skills you
  stopped using. Nothing is ever hard-deleted.
- **Shows what it learned.** A short weekly note (or one after every save, if you
  prefer) and `/peka:status log` list what PEKA added, changed, or archived.
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
├── memory/               one file per memory; MEMORY.md and projects/ are generated indexes
├── skills/<name>/        skills PEKA learned, linked into ~/.claude/skills/<name>
├── archive/              retired skills and memories
├── state/                counters, usage, digests, logs (not in git)
└── .git                  local history, committed after every review
```

1. **Briefing.** Each session starts with a short note telling Claude its memory is
   global, to check the index before a task, and to hand anything you teach it to
   `/peka:remember` right away. The note also names the current project (the folder of
   its git repository, so worktrees count as the same project) and lists that project's
   memories. That command passes it to the `peka:learner` agent,
   which decides whether it is a memory (a fact or preference) or a skill (a
   procedure) and files it without duplicates.
2. **Counting.** Hooks count your turns since Claude last saved a memory and tool calls
   since it last saved a skill.
3. **Checkpoint.** When a counter reaches its interval (10 turns / 20 tool calls by
   default), PEKA writes a compact digest of the recent conversation and asks Claude to
   launch the `peka:reviewer` agent in the background.
4. **Review.** The reviewer reads the digest and your existing memory, then saves or
   updates memories and skills. It has no shell access: it can only read files and edit
   files inside `~/.peka`.
5. **Commit.** When the reviewer finishes, PEKA links new skills into
   `~/.claude/skills` and commits `~/.peka` to its local git repository.
6. **Curate.** About once a week the `peka:curator` agent merges overlapping skills and
   memories, tags project-specific ones, and checks memories that mention local paths
   that no longer exist. Skills unused for 14 days are marked stale and archived after
   30, unless you pin them. For a skill tagged with a project, only days you actually
   worked on that project count, so a deploy procedure is not lost while its project
   sits idle.

### Projects and the index

A memory or skill belongs to a project through its frontmatter:

```yaml
metadata:
  type: feedback
  project: wajom-portal, wajom-client   # leave out for global
```

PEKA builds `memory/MEMORY.md` from the memory files: global memories first, then one
line per project pointing to `memory/projects/<project>.md`. It rebuilds the index when
a session starts, when Claude writes a memory, and after each PEKA agent, so the index
never drifts from the files; hand edits to it are overwritten. Untagged memories stay
global, so nothing changes until things are tagged. `/peka:audit` and the curator
suggest tags for items that mention a project PEKA has seen.

PEKA writes skills to `~/.peka` and only links them into `~/.claude/skills`, so the
background agents do not trigger permission prompts. That shortcut is limited on
purpose:

- Only PEKA's own agents (reviewer, curator, learner) get it. When Claude in your main
  session writes a PEKA skill itself, you are asked as usual.
- A skill is saved without asking only if its frontmatter sticks to `name`,
  `description`, `when_to_use`, `argument-hint`, `metadata`, `license`, and `version`, and
  it has no `` !` `` or ```` ```! ```` command blocks. Anything else (`hooks`,
  `allowed-tools`, `shell`, `model`, `context`, ...) can make a skill run commands or
  pre-approve tools, so you are asked. Edits are judged by the file they produce.

If you already have a skill with the same name, PEKA leaves yours alone and reports the
conflict in `/peka:status`.

If Claude writes a skill straight into `~/.claude/skills` instead, PEKA notices and
suggests `/peka:audit adopt <name>`, which moves it into PEKA and leaves a link so it
keeps working. Adopted skills are pinned, so the curator never archives them. Folders
holding a `.git`, `node_modules`, or `.env` are not adopted, since PEKA's store is a git
repo.

### Commands

| Command | What it does |
|---|---|
| `/peka:setup` | first-time setup and import of old memories |
| `/peka:status` | every memory and skill PEKA has, with descriptions and usage |
| `/peka:status show <name>` | open one memory or skill in full |
| `/peka:status log [days]` | what PEKA added, changed, or archived recently, and how to undo it |
| `/peka:status pin <skill>` | never mark this skill stale or archive it (`unpin` to undo) |
| `/peka:remember <what>` | keep something now; PEKA decides memory or skill |
| `/peka:skill <what>` | save a procedure as a reusable skill |
| `/peka:audit` | find knowledge in the wrong place and fix it |
| `/peka:audit adopt <skill>` | move a skill from `~/.claude/skills` into PEKA |
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
| `learning_notice` | `weekly` | `weekly`: one line a week on what PEKA saved; `each`: one line after every save; `off` |

Learning notices and `/peka:status log` read the git history of `~/.peka`, so they need
git and `auto_commit` on.

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
