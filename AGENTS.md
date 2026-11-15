## Definition of done

Before you finish any task, run `npm run check` and make sure it passes.
It runs typecheck, lint, format check, and tests, in that order.

- If a check fails, read the error, fix the code, and run it again.
- Never edit tests, `eslint.config.mjs`, `tsconfig.json`, or `package.json`
  just to make a check pass.
- Do not use `eslint-disable`, `@ts-ignore`, `.skip`, or `as any` to hide errors.
- Run `npx prettier --write` on the files you changed to fix formatting.
- After implementing a GitHub issue, always add implementation notes as a
  comment on the issue (`gh issue comment`) and close it (`gh issue close`).

## Grilling Rules

- **Explain before asking:** Provide context for every question, including why it matters. Briefly explain technical terms when necessary.
- **Break it down:** Ask clear, specific questions. Split complex or abstract questions into smaller, manageable parts.
- **Give examples:** Include simple, practical examples to demonstrate what each question or decision means in practice.
- **Explain the choices:** Present available options, their trade-offs, and recommend an approach when appropriate.
- **Verify decisions:** Explicitly summarize and confirm important decisions before proceeding. Never assume approval.
- **Minimize back-and-forth:** Anticipate follow-up questions, address ambiguities upfront, and maintain a summary of agreed decisions.

**Core principle:** Never make the user guess what you're asking. Make every question easy to understand and answer without requiring multiple rounds of clarification.

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues, managed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, using default label strings. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
