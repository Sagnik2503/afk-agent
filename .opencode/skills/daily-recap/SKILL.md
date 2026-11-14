---
name: daily-recap
description: Give me a plain-language overview of what was committed, merged, and left open in the last day (or a window I name), and what to do today. Use at the start of a day or session.
metadata:
  opencode/autoinvoke: false
---

# Daily recap

This skill is READ-ONLY. Never edit files, commit, push, or merge.

## 1. Pick the time window

Default: since yesterday 00:00.

If today is Monday and no window is specified, use since Friday 00:00.

If I specify a window ("last 3 days", "since Friday"), use that.

## 2. Gather facts

Set DATE to the window start (YYYY-MM-DD).

Run:

**Git commits:**
```bash
git log --all --since="$DATE" --no-merges --stat --pretty=format:'%h %d %an %ad %s' --date=short
```

Identify which commits are already in main and which are still on feature branches. Check the relevant diffs for significant changes.

**Merged PRs:**
```bash
gh pr list --state merged --search "merged:>=$DATE" --json number,title,mergedAt,body
```

**Open PRs and checks:**
```bash
gh pr list --state open --json number,title,headRefName,statusCheckRollup
```

Clearly distinguish passing, failing, and pending checks.

**Tickets:**
```bash
gh issue list --state closed --search "closed:>=$DATE" --json number,title
gh issue list --state open --json number,title
```

If gh is unavailable or unauthenticated, say so and use Git information only. Never assume there were no PRs or tickets.

**Project context:**
- Read the newest file in `docs/handoff/`, if available.
- Read the end of `docs/learning-log.md`, if available.
- Check `git status --short --branch` for the current repository state.

## 3. Understand the changes

Don't rely only on commit messages.

For significant commits and merged PRs, inspect the actual diffs using `git show` or `gh pr diff`.

Explain what functionality was added, what changed, and what the user can now do with a concrete example.

## 4. Write the recap

Use this format:

**Merged into main**
- What was added and one concrete example.

**Committed but not merged**
- Branch, what's done, and what's missing.

**Open PRs**
- Title, check status, and blockers.

**Tickets**
- Closed during the selected window and still open (titles only).

**Where I stopped**
- Previous progress and immediate next step from the handoff/learning log.

**Repository state**
- Current branch and whether there are uncommitted changes.

**Suggested plan for today**
- Exactly 3 tasks in priority order, prioritizing unfinished previous work.

**Check my memory**
- Ask ONE question about an implementation detail from something merged during the selected window. Wait for my answer before correcting me.

## 5. Be honest

- Distinguish committed, merged, and shipped. Only say shipped if I confirmed deployment.
- Never assume a commit is merged.
- Never assume missing GitHub information means no activity.
- If information or project notes are unavailable, say so.
- If there was no activity, say so plainly.
- Keep the recap concise and in plain language.