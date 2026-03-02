# Repository Guidelines

## Project Structure & Module Organization
- `src/app`: Next.js App Router pages and API routes.
  - `src/app/api/*`: backend endpoints for auth, PR sync/trigger, pipeline runs, RK3568 tasks, and realtime WS bootstrap.
  - `src/app/auth`: login/register UI.
- `src/components/ui`: shadcn-style reusable UI components.
- `src/lib`: core business logic (GitCode API, auth/session, SQLite access, pipeline parsing/sync, RK3568 execution).
- `src/types`: shared TypeScript domain types.
- `data/`: runtime local storage (`auth.sqlite`, `pipeline-runs.json`, `rk3568-tests.json`).
- `.github/workflows/ci.yml`: CI runs lint + build on push/PR.

## Build, Test, and Development Commands
- `pnpm install` — install dependencies (required before local run/CI parity).
- `pnpm dev` — start local dev server at `http://localhost:3000`.
- `pnpm lint` — run ESLint checks (must pass before PR).
- `pnpm build` — production build + TypeScript check (must pass before PR).
- `pnpm start` — run production server after build.

## Coding Style & Naming Conventions
- Language: TypeScript (`strict` enabled in `tsconfig.json`).
- Indentation: 2 spaces; keep imports grouped and sorted logically.
- Components/types: `PascalCase`; variables/functions/hooks: `camelCase`.
- API route files follow Next.js convention: `.../route.ts`.
- Prefer path alias imports (`@/lib/...`, `@/types/...`) over deep relative paths.
- Keep UI logic in `src/app`/`src/components`, business logic in `src/lib`.

## Testing Guidelines
- No dedicated unit test framework is configured yet.
- Required validation for every change:
  1. `pnpm lint`
  2. `pnpm build`
  3. Manual smoke test for affected flows (auth, PR list/filter, trigger/sync, RK3568 dialog/task logs).
- If introducing tests, place them near code (`*.test.ts[x]`) and document run command in `package.json`.

## Commit & Pull Request Guidelines
- Follow concise Conventional Commit style, e.g. `feat: add rk3568 rerun cache`.
- Keep commits focused; avoid mixing refactors with feature fixes.
- PRs should include:
  - change summary and motivation,
  - impacted routes/files,
  - verification steps/commands run,
  - screenshots or log snippets for UI/realtime/RK3568 changes.

## Security & Configuration Tips
- Never commit real tokens/secrets; use `.env.local` (see `.env.example`).
- Treat `data/` as environment-specific runtime state; do not hardcode absolute machine-specific paths outside config.
