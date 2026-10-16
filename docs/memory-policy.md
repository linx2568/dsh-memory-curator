# Memory policy

What this plugin records, what it refuses to record, and why. The design was not invented here:
it comes from comparing the systems that solved the same problem and then measuring this one in
use. Both halves are recorded below, because the reasoning matters more than the rules.

## 1. Division of labour

Memory is machine-local (`$DSH_HOME/memory-curator/store.json`) and invisible to the rest of the
team. That single fact decides almost every boundary below: anything a teammate needs must live
in the repository, and memory covers only what has no other home.

| Artifact | Owner | Holds | Memory's relationship to it |
|---|---|---|---|
| `README.md` | the project, for people | what it is, how to install and use it | never duplicated |
| `AGENTS.md` / `CLAUDE.md` | the project, for agents | conventions, commands, always/never rules | never duplicated; an entry that belongs here should be promoted into it |
| `STATE.md`, `TODO.md`, an issue tracker | the project | current work, next steps | never duplicated |
| code, `git log`, `docs/` | the repository | architecture, paths, build and test commands, history | never recorded; a future session reads them directly |
| this memory | the machine | environment and tooling traps, user preferences and corrections, facts about this machine that the repository cannot know | the residual |

## 2. Admission

Every distillation call runs these tests against each candidate; **any one of them means record
nothing**:

1. **Repository-derivable** — would a future session get it from the repository? Architecture,
   file paths, build and test commands, dependency lists, directory layout, git history: yes,
   and it is read there, not here.
2. **Project-level instruction** — a convention or never/always rule belongs in `AGENTS.md` /
   `CLAUDE.md`, where every teammate and every tool sees it.
3. **Task state** — progress, next steps, a worked-off plan belongs in `STATE.md`, a todo list or
   the issue tracker.
4. **Action report** — "published the repository", "rewrote the history", "added a section". The
   artifact is its own record.

To make the first two decidable rather than a matter of taste, each call carries repository
context: the bounded text of `AGENTS.md` / `CLAUDE.md`, plus the *names* of `README.md`,
`STATE.md`, `TODO.md`, `CONTRIBUTING.md`, `ARCHITECTURE.md`, `CHANGELOG.md` and `docs/`
(`lib/repo-docs.js`, cached by mtime+size so a quiet repository costs a few `stat` calls).

Admission is deliberately biased toward silence: an empty list is a correct answer, an entry
must be self-contained, and a candidate that the same turn did not actually establish — a
suggestion the user never accepted, something merely re-read from memory — is not recorded.

### Why not "record more, curate later"

Because the prompt index is a fixed budget. Measured over the first ~7 hours of use, the
2400-byte catalog saturated at 39 lines and had to hide 15 of 52 visible entries, and a purely
newest-first order let fresh task narration evict the platform knowledge that had actually been
read — a live prohibition among it. Junk is not free even when it is folded later.

## 3. What the neighbours do

Collected from primary sources while designing this; the useful pattern is in the last column.

| System | Who writes | Notable rule |
|---|---|---|
| [Claude Code auto memory](https://code.claude.com/docs/en/memory) | the model, in session | "skips anything it can derive from the codebase … also skips anything your CLAUDE.md files already say" — the two tests this plugin adopted |
| [Claude API memory tool](https://github.com/anthropics/claude-cookbooks) | the model, via tool calls | stores patterns, never secrets/PII; names *memory poisoning* as a first-class risk |
| GitHub Copilot Memory | the model, automatically | stores repo facts **with citations**, re-validates them against the branch, deletes unused ones after 28 days |
| mem0 / Dream | the app calls `add()` | `ADD`/`UPDATE`/`DELETE`/`NONE` then background Supersede/Merge |
| Letta (MemGPT) | the agent, or `/remember` | background "sleep-time" agents reorganise memory; every edit is a git commit |
| Zep + Graphiti | automatic on ingest | never deletes: a contradiction sets `invalid_at` on the edge |
| Gemini CLI Auto Memory | a background miner | never applies anything by itself: it emits `.patch` proposals for the user to approve |
| MCP memory servers | the model, via tools | the official server has **no** conflict handling at all; only explicit deletes |
| [claude-mem](https://github.com/thedotmack/claude-mem) | lifecycle hooks | captures tool *observations*, not knowledge |

Two lessons were taken directly: **an explicit exclusion list beats a scoring function** (Claude
Code), and **a memory that is never read is a cost, not an asset** (Copilot's expiry). One was
rejected: hook-driven capture of everything, which stores activity rather than knowledge.

There is also a sobering result worth keeping in view — a two-agent ablation study
([arXiv 2607.27250](https://arxiv.org/abs/2607.27250)) found **no measurable correctness effect**
from injecting context files, because agents fail on implementation skill rather than on missing
repository knowledge. It matches this store's own data: what earned its place was environment
and tooling traps, not architecture summaries.

## 4. Lifecycle

Nothing is deleted; entries change status and stop being recalled:

| Status | Set by | Meaning |
|---|---|---|
| `active` | — | recalled |
| `superseded` | insert / curate / model adjudication | a newer statement on the same subject won; `supersededBy` points at it |
| `merged` | curate | a duplicate folded in |
| `forgotten` | `memory_forget`, panel | retired on purpose |
| `decayed` | `decay()` | unread past `decayAfterDays` and older than `decayGraceDays` |

Decay skips decisional kinds and `reference` entries: a prohibition nobody has tripped yet is
still binding, and references are consulted rarely by nature. "Read" is `lastRecalledAt` when
present, else the entry's age. `decayAfterDays: 0` disables it entirely.

## 5. Measurement

`npm run audit:recall` reconstructs what actually happened from DSH's own session logs — tool
traffic, how many entries were opened in full, how often the index had to hide entries, which
entries are hidden now. `memory_detail` counts each read (`recallCount`, `lastRecalledAt`), and
the panel shows it. The ordering and the decay window are both consequences of that data; the
numbers that drove them are in the [README](../README.md#measuring-recall).

Design rules this file exists to protect:

- **No overlapping carrier.** If the repository, `AGENTS.md`, `STATE.md` or the code answers it,
  memory does not.
- **Promote, don't hoard.** A project-level rule found in memory belongs in `AGENTS.md` /
  `CLAUDE.md`; write it there, then `memory_forget` the entry.
- **Silence is a valid answer.** An empty capture is correct; a wrong memory is worse than a
  missing one.
- **Usage is the signal.** Order and decay follow readership, not enthusiasm.
- **Never delete, always explain.** Every retirement keeps the text and the reason
  (`supersededBy`, status), so a surprising absence can always be traced.
