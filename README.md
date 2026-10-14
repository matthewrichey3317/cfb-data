# College football data

Historical FBS games, betting lines, and drives from the
[CollegeFootballData API](https://collegefootballdata.com), covering 2015–2026,
regular season and postseason.

## Downloading the data

- `data/`: one raw CSV per season and endpoint. `data/manifest.json` lists
  filenames, row counts, sizes, and pull timestamps.
- `export/`: compact game-level CSVs split into parts strictly below 90,000
  bytes. `export/index.json` lists every part, its season, week range, row count,
  and byte size.

For direct downloads, use
`https://raw.githubusercontent.com/matthewrichey3317/cfb-data/main/`
followed by the filename, for example `export/index.json`.

## Collector

The React status page supports a historical pull (skipping existing raw files)
and a current-season refresh. Refresh downloads only 2026, rebuilds only 2026
compact parts, and commits/pushes those files plus both manifests. A publishing
failure is shown as a failed job; successfully downloaded local files remain
intact. There is no automatic schedule: use the refresh button each week.

Keep `CFBD_API_KEY` and `GH_TOKEN` in Replit Secrets. The GitHub token must belong
to `matthewrichey3317` and have permission to update this public repository.
Expired or revoked tokens prevent publishing. No credentials belong in this
repository.

Rebuild compact exports without API calls:

```sh
pnpm --filter @workspace/api-server run export:compact
pnpm --filter @workspace/api-server run export:compact 2026
```

Publish already-saved 2026 files without spending API calls (also useful after
a publishing failure):

```sh
node artifacts/api-server/publish-data.mjs
```

Run the publication security check only:

```sh
node artifacts/api-server/publish-data.mjs --check
```

The collector uses whole-season requests, short pauses, and bounded retries to
conserve API quota. Current-season data can be incomplete, and the 2020 season
was shortened.
