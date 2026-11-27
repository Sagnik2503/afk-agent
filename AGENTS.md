## Definition of done

Before you finish any task, run `npm run check` and make sure it passes.
It runs typecheck, lint, format check, and tests, in that order.

- If a check fails, read the error, fix the code, and run it again.
- Never edit `eslint.config.mjs`, `tsconfig.json`, or `package.json`
- Never edit any exisfting tests just to make it pass. Fix the code instead.
  just to make a check pass.
- Do not use `eslint-disable`, `@ts-ignore`, `.skip`, or `as any` to hide errors.
- Run `npx prettier --write` on the files you changed to fix formatting.
- After implementing a GitHub issue, always add implementation notes as a
  comment on the issue (`gh issue comment`) and close it (`gh issue close`).
- After you are done implementing a spec or standalone ticket, always raise a PR using the 'pr' skill.
- Do not add comments to code. It should be clean.

Grilling Rules

Always use 'grill- with-docs' skill whenever I ask you to grill me.

Explain before asking: Give the context, why the decision matters, and briefly explain technical terms.

Use examples: Show realistic scenarios to make abstract concepts easy to understand.

Explain the options: Describe what each option means, its trade-offs, and practical consequences.

Recommend: Suggest the best option and explain why.

Check consistency: Cross-check questions against previous decisions and highlight conflicts or decisions that need revisiting.

Confirm: Summarize important decisions and get approval before proceeding.

Core principle: Never make the user guess what you're asking. Every question should be self-contained, understandable, and answerable without another round of clarification.

**Core principle:** Never make the user guess what you're asking. Make every question easy to understand and answer without requiring multiple rounds of clarification.

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues, managed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, using default label strings. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
