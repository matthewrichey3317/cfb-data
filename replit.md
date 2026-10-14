# CFBD Data Collector

A backend collection tool for analysts: download historical FBS games, betting lines, and drives into project CSV files. The web UI is only a status page, not a consumer application.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm --filter @workspace/cfbd-collector run dev` — status page (managed workflow provides port)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required Secret: `CFBD_API_KEY` — read only by the backend. Never put its value in code, files, logs, or frontend variables.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/api-server/src/lib/collector.ts` — collection job, rate-limit retry, atomic file replacement
- `artifacts/api-server/src/lib/collector-csv.ts` — CSV serialization/parser
- `artifacts/api-server/src/routes/collector.ts` — status and job actions
- `artifacts/cfbd-collector/src/pages/home.tsx` — status page
- `lib/api-spec/openapi.yaml` — HTTP contract; regenerate clients after changes
- `data/*.csv` — analysis inputs; `data/manifest.json` — file metadata; `data/job.json` — last job status

## Architecture decisions

- The user explicitly requires plain CSV files in the top-level `data` folder for another analysis tool, not database records or object-storage-only exports.
- Collect whole seasons only: never add per-week/per-game API calls. A fresh historical run needs 72 calls, excluding retries; a 2026 refresh needs 6.
- CFBD `/lines` lacks classification filtering; match lines to game IDs from the FBS games CSV. FBS includes games involving either FBS team, including FCS opponents.
- Files are excluded from Git and published images to avoid committing large generated data. Keep the workspace data directory; publishing is not a way to transfer collected files.

## Product

Collect seasons 2015 through 2026 inclusive, regular plus postseason. Full pull skips existing CSVs; Refresh 2026 overwrites only the three 2026 CSVs. Each output has a header row and all returned fields; nested fields are JSON cells, with extra flattened drive clock fields. Betting output is one row per game/provider, with original nested lines also retained.

Use the status page buttons, or send `POST /api/collector/pull` and `POST /api/collector/refresh`. Query `GET /api/collector/status`. To explicitly refresh a historical season, move its three CSVs out of `data` and run the full pull; other existing years are skipped.

## User preferences

Keep the UI simple. This is a backend data job. The pinned current-season refresh is 2026, not the system's automatically advancing year.

## Gotchas

- CSV files are saved atomically only after both season types succeed. Failed historical half-pulls are retained as hidden part files for resuming without duplicate calls. A new 2026 refresh discards old 2026 parts to get fresh data.
- Empty future seasons/postseasons are valid API results. 2020 is pandemic-shortened; do not fabricate rows to meet typical counts.
- This is a workspace-local collection tool. It has no user authentication. Do not publish the controls publicly without adding access protection and durable deployment storage first; deployment disks are not an analysis-data backup.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
