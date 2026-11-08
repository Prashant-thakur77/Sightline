# Build conventions

## Commits and git
- Conventional commits (`feat(gate): add duplicate guard`). Each commit covers a whole piece of work.
- No attribution of any kind: no `Co-Authored-By` trailers, no "Generated with" lines, no AI or tool names, no credits or "inspired by" lines in commit messages, code comments, README, docs, PR text or submission text.
- Never push to a public remote, never change repository visibility, never force-push `main`.
- Never commit secrets. gitleaks runs before commits and in CI. Only `.env.example` is committed; `.env.local` holds real values.
- Planning and private files are git-ignored and must stay that way.

## Safety rails
- PayPal sandbox only. Every process calls `assertSandbox()` at boot and refuses to start unless `PAYPAL_ENV=sandbox` and `PAYPAL_API_BASE=https://api-m.sandbox.paypal.com`. Never use live credentials.
- No real purchases, form submissions or account creation on real websites. Browser reads are read-only, respect robots.txt and rate limits, and identify the tool honestly.
- Model output never moves money: amounts, payees and confirmations come from snapshots, the readback and the payment gate, never from model text.
- Missing key or human-only step: record it, mark the task blocked, keep working elsewhere. Never fake a sponsor integration or invent credentials.
- One heavy process at a time on the dev laptop; stop Docker services not in use.

## Code
- TypeScript strict, ESM, pnpm workspaces + Turborepo. Internal packages are source-only (`exports: ./src/index.ts`).
- Money is integer cents (`@sightline/core` `Money`). Never use floats for money.
- `PRODUCT_NAME` comes from `@sightline/core`; never hard-code the product name in UI copy.
- Tests first where practical (Vitest). `pnpm check` must be green before a commit.
- Every UI change must work with a screen reader and keyboard, announce through the announcer (never write to live regions directly), manage focus, work in low-vision mode, and have 0 axe violations.
- Copy: short sentences, say what happens next and how to undo it, never blame the user, confidence in words (sure / fairly sure / not sure) not percentages, no visual-only references.
- Local ports: web 3100, Postgres 5442, vision 8011.
