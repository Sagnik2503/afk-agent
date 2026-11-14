## Definition of done

Before you finish any task, run `npm run check` and make sure it passes.
It runs typecheck, lint, format check, and tests, in that order.

- If a check fails, read the error, fix the code, and run it again.
- Never edit tests, `eslint.config.mjs`, `tsconfig.json`, or `package.json`
  just to make a check pass.
- Do not use `eslint-disable`, `@ts-ignore`, `.skip`, or `as any` to hide errors.
- Run `npx prettier --write` on the files you changed to fix formatting.

## Grilling Rules

- during grilling sessions, make sure the questions are easy to understand.
- follow the questions with simple examples as to how it will work.
