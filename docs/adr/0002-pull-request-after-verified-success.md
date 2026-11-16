# Pull Request After Verified Success

## Status

Accepted

## Context

A run already pushes the Task branch and comments on the Issue. The next review
step is a Pull request, but a Pull request is a claim that the work is ready:
unlike a branch push, it targets a Base branch, may already exist for a re-run,
and can fail independently (auth, protection rules, missing Base branch).
Treating it like the push would either hide partial work or fail a run whose
branch is already reviewable. The repository's default branch varies (`main`,
`master`, `develop`), so hard-coding `main` would break some repositories.

## Decision

Open a Pull request only after a verified success: the agent completed, tests
passed, there is no execution error, at least one commit exists, and the branch
was pushed. It is on by default; `--no-pr` opts out, and `--no-push` implies no
Pull request.

- **Base:** the repository's default branch (`origin/HEAD`), falling back to
  `main`, then `master`.
- **Content:** the title is the Issue title; the body links the Issue, adds
  `Closes #N`, and summarizes the Run report (attempts, tests, changed-file
  count, and commits).
- **Re-runs:** reuse the existing open Pull request for the Task branch and post
  a short run comment on it; do not edit its body.
- **Failure:** reported in the Issue comment and the report, but non-fatal. The
  Worktree is kept, the run still counts as a success, and the exit code is
  unchanged.
- **Ordering:** create the Pull request before posting the Issue comment, so the
  comment can link it or name the reason it was skipped.
- **Run comment on re-run:** the new run is recorded on the Pull request as a
  short comment rather than by rewriting its body.

## Consequences

- A failed run never produces a Pull request; its branch remains for manual
  review.
- Re-running an Issue is idempotent: one open Pull request per Task branch.
- A reused Pull request body can be stale after a re-run; the run comments and
  the Issue comment are the current records.
- `Closes #N` closes the Issue on merge, so a reviewer must edit the body when
  the work is only partial.
- Agent-authored implementation summaries remain out of scope; the body is built
  from the Run report.
