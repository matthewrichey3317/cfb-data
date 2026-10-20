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
- `pnpm --filter @workspace/api-server run export:compact` — rebuild all compact parts from local raw CSVs; no API calls
- `pnpm --filter @workspace/api-server run export:compact 2026` — rebuild just 2026 compact parts
- `pnpm --filter @workspace/api-server run test:compact` — compact aggregation/splitting regression checks

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
- `export/games_compact_<season>_part<n>.csv` — compact game-level inputs under 90,000 bytes each; `export/index.json` — part metadata

## Architecture decisions

- The user explicitly requires plain CSV files in the top-level `data` folder for another analysis tool, not database records or object-storage-only exports.
- Weather is an independent resumable job over saved games (2015–2026); it adds venues and one weather CSV per season to the same raw manifest and public repository. Publish each completed weather season immediately before continuing, never defer all publishing to the end of the backfill. Startup must persist an `interrupted` state and detection timestamp for a previous process's running job; the UI provides explicit Resume weather. Resume retains counters and reuses archive caches. Refresh 2026 also refreshes only its weather. Weather errors must never roll back games, lines, drives, or compact exports; successful non-weather refresh results are still pushed. Archive-hour caches are local/ignored; forecast data is always re-requested and later promoted to archive. Free Open-Meteo use is non-commercial and quota-limited.
- Collect whole seasons only: never add per-week/per-game API calls. A fresh historical run needs 72 calls, excluding retries; a 2026 refresh needs 6.
- CFBD `/lines` lacks classification filtering; match lines to game IDs from the FBS games CSV. FBS includes games involving either FBS team, including FCS opponents.
- The user explicitly requested public GitHub publication of raw CSVs, the raw manifest, compact parts, and the export index alongside app code. These analysis files are intentionally no longer Git-ignored. Runtime job state, partial downloads, environment files, dependencies, and build output remain ignored. Data folders remain excluded from app deployment images.

## Product

Collect seasons 2015 through 2026 inclusive, regular plus postseason. Full pull skips existing CSVs; Refresh 2026 overwrites only the three 2026 CSVs. Each output has a header row and all returned fields; nested fields are JSON cells, with extra flattened drive clock fields. Betting output is one row per game/provider, with original nested lines also retained.

Use the status page buttons, or send `POST /api/collector/pull` and `POST /api/collector/refresh`. Query `GET /api/collector/status`. To explicitly refresh a historical season, move its three CSVs out of `data` and run the full pull; other existing years are skipped.

After a successful raw pull, build compact exports for its seasons. Refresh 2026 replaces only 2026 raw CSVs and compact parts, updating the shared export index while preserving other seasons, then commits and pushes to the public `matthewrichey3317/cfb-data` repository. Publishing uses `GH_TOKEN` from Secrets, verifies account identity, checks for leaked secrets in candidates and Git history, isolates staging to the 2026 files and both manifests, and verifies the remote commit. Publishing errors fail the job explicitly without deleting local data. `node artifacts/api-server/publish-data.mjs` retries publishing saved files without API calls. Export-only CLI commands never call CFBD.

Compact columns use UTC kickoff times, 1/0 flags, blank missing data, one-decimal rounded numbers (without unnecessary trailing .0), closing/opening total medians and home-perspective closing spread median. `total_providers` counts distinct providers with a nonblank closing total. Offense statistics are summed per drive using `isHomeOffense`. Touchdown counts include offensive TD results with at least six points of offense-score gain, not defensive return TDs; field goals are successful FG results. Offensive drive points are the exact sum of end-minus-start offense score. Rows are sorted by numeric week within each season; keep whole weeks per part when possible, splitting oversized weeks when necessary. CSV quotes are used only if required for valid CSV.

## User preferences

Keep the UI simple. This is a backend data job. The pinned current-season refresh is 2026, not the system's automatically advancing year.

The analysis reader accepts text files only below about 100 KB; compact exports must stay strictly under 90,000 bytes including headers. Use the top-level `export` folder for these analysis inputs.

## Gotchas

- CSV files are saved atomically only after both season types succeed. Failed historical half-pulls are retained as hidden part files for resuming without duplicate calls. A new 2026 refresh discards old 2026 parts to get fresh data.
- Empty future seasons/postseasons are valid API results. 2020 is pandemic-shortened; do not fabricate rows to meet typical counts.
- This is a workspace-local collection tool. It has no user authentication. Do not publish the controls publicly without adding access protection and durable deployment storage first; deployment disks are not an analysis-data backup.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
