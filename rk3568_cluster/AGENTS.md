# Repository Guidelines

## Project Structure & Module Organization
- `server/`: standalone Next.js app (all UI + backend logic).
  - `server/src/app`: pages and API routes.
  - `server/src/lib`: core business logic (GitCode API, auth/session, SQLite access, pipeline parsing/sync, RK3568 scheduling).
  - `server/src/types`: shared TypeScript domain types.
  - `server/data/`: runtime local storage (`auth.sqlite`, `pipeline-runs.json`, `rk3568-tests.json`).
- `client/`: RK3568 device agent (TypeScript, Node.js runtime, websocket registration/report/execution).
- `docker-compose.yml`: root-level compose entry that builds/runs `server`.
- `.github/workflows/ci.yml`: CI checks `rk3568_cluster/server` and image build verification.

## Build, Test, and Development Commands
- Server install: `pnpm -C server install`
- Server dev: `pnpm -C server dev`
- Server lint: `pnpm -C server lint`
- Server build: `pnpm -C server build`
- Server start: `pnpm -C server start`
- Client install: `pnpm -C client install`
- Client build: `pnpm -C client run build`
- Client start: `pnpm -C client start`
- Compose up (server): `docker compose up -d --build`

## Coding Style & Naming Conventions
- Language: TypeScript (`strict` enabled in `tsconfig.json`).
- Indentation: 2 spaces; keep imports grouped and sorted logically.
- Components/types: `PascalCase`; variables/functions/hooks: `camelCase`.
- API route files follow Next.js convention: `.../route.ts` (under `server/src/app/api`).
- In server code, prefer alias imports (`@/lib/...`, `@/types/...`) over deep relative paths.
- Keep UI logic in `server/src/app`/`server/src/components`, business logic in `server/src/lib`.

## Testing Guidelines
- No dedicated unit test framework is configured yet.
- Required validation for every change:
  1. `pnpm -C server lint`
  2. `pnpm -C server build`
  3. `pnpm -C client run build`
  4. Manual smoke test for affected flows (auth, PR list/filter, trigger/sync, RK3568 dialog/task logs, client registration/report).
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
- Never commit real tokens/secrets; use `server/.env.local` and `client/.env` templates.
- Treat `server/data/` as environment-specific runtime state; do not hardcode machine-specific paths outside config.
