---
name: commit
description: Write a commit message for the pending changes in this repository, in the project's established style. Use when the user asks for a commit message, asks to commit, or types /commit. Optionally creates the commit.
---

# Commit message

Produce a commit message for the current changes that reads like the rest of this repository's history.

## Gather first

Run these before writing anything:

```bash
git status --short
git diff --staged --stat && git diff --stat
git log -8 --format='%s%n%b%n---'
```

- If anything is staged, describe **only the staged changes**. Otherwise describe the whole working tree.
- Read the actual diff of the non-trivial files, not just the stat. A message derived from filenames alone describes the files, not the change - that is the failure mode to avoid.
- If `docs/changelog.md` changed, its entry is the clearest statement of user-visible intent. Use it, but do not copy its wording verbatim.

## Style

The `git log` output above is the authority. As of this writing the house style is:

**Subject line**
- Imperative mood, capitalized, no trailing period: `Fix rsync progress flag and log handling`
- No `feat:` / `fix:` / conventional-commit prefix, no scope brackets, no emoji
- Aim for under ~65 characters
- Name the change, not the files touched

**Body**
- One prose paragraph, roughly 2 to 5 sentences. No bullet lists.
- Say what changed and why it mattered. Behavior before and after beats a list of edits.
- Backticks for identifiers, flags, and paths: `` `--info=progress2` ``, `` `src/lib/utils.ts` ``
- Mention added test coverage and the changelog entry when they are part of the change - the history consistently does
- Blank line between subject and body

**Typography** (project rule, see the root `CLAUDE.md`)
- No em dashes. Use a hyphen.
- No semicolons. End sentences with a period.
- English.

## Scope check

If the diff contains two or more genuinely unrelated changes, say so and propose a split: one subject line per commit plus which paths belong to each. Do not silently bundle them under a vague subject like "Various fixes". A single coherent change that touches many files is still one commit.

## Output

Present the subject and body as copyable text. Then ask whether to create the commit - do not commit unprompted.

If the user says yes:
- Stage only what belongs to the change if nothing is staged yet. Never `git add -A` over unrelated edits without saying so.
- Commit on a branch, not on `main`. If `git branch --show-current` reports the default branch, say so and ask first.
- Do not push unless asked.
