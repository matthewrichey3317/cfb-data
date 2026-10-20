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

The React status page supports a historical pull (skipping existing raw files),
**Pull weather (all seasons)**, and a current-season refresh. Refresh downloads
only 2026, rebuilds only 2026 compact parts, updates `weather_2026.csv`, and
commits/pushes those files plus both manifests and the venue list. A publishing
failure is shown as a failed job; successfully downloaded local files remain
intact. There is no automatic schedule: use the refresh button each week.

On server startup, a saved `running` job from the previous process is
persistently marked `interrupted`. The status page shows the time the
interruption was **detected** (the actual stop time may be unknown), previous
progress, and a **Resume weather** action for interrupted/failed weather jobs.
Resume preserves the request count and reuses completed venue archives; it does
not re-download games, lines, drives, or cached historical weather. Starting the
server alone does not automatically resume an interrupted job.

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

Publish already-saved venue and weather files without weather/API requests:

```sh
node artifacts/api-server/publish-data.mjs --weather
```

Run the publication security check only:

```sh
node artifacts/api-server/publish-data.mjs --check
```

The collector uses whole-season requests, short pauses, and bounded retries to
conserve API quota. Current-season data can be incomplete, and the 2020 season
was shortened.

## Stadium weather

**Pull weather (all seasons)** reads the saved 2015–2026 games; it does not
re-download games, lines, or drives. It downloads the CFBD venue list once and
reuses `data/venues.csv`. Select **Refresh venue list** before a weather pull
to explicitly re-download it (one CFBD API call).

`data/venues.csv` columns:

| Column | Meaning |
| --- | --- |
| `id`, `name`, `city`, `state` | CFBD venue identity and location |
| `latitude`, `longitude` | Stadium coordinates, decimal degrees |
| `elevation` | Elevation as supplied by CFBD, in meters |
| `timezone` | Venue time zone as supplied by CFBD |
| `dome`, `grass` | 1/0 flags; blank if unknown |

`data/weather_YEAR.csv` contains one row for every saved game, including
postseason, indoor games, and games without weather coverage. Files are listed
in `data/manifest.json`, with row counts, pull timestamps, sizes, and warnings.
The venue manifest entry uses season `0` because it is shared by all seasons.

Weather columns:

| Columns | Meaning |
| --- | --- |
| `game_id`, `season`, `week`, `venue_id` | Join keys and season/week |
| `latitude`, `longitude`, `dome`, `kickoff_utc` | Stadium coordinates, indoor flag, original kickoff timestamp in UTC |
| `kickoff_temperature_f`, `kickoff_wind_mph`, `kickoff_gust_mph`, `kickoff_wind_direction_deg` | Temperature (°F), wind speed/gusts at 10 m (mph), direction (degrees) at the kickoff hour |
| `kickoff_precipitation_in`, `kickoff_rain_in`, `kickoff_snowfall_in`, `kickoff_humidity_pct` | Hourly precipitation, rain and snowfall (inches), relative humidity (%) |
| `avg4h_temperature_f`, `avg4h_wind_mph`, `avg4h_gust_mph`, `avg4h_wind_direction_deg` | Four-hour averages in the same units; wind direction uses a circular mean |
| `avg4h_precipitation_in`, `avg4h_rain_in`, `avg4h_snowfall_in`, `avg4h_humidity_pct` | Four-hour averages of hourly amounts/measurements |
| `max4h_gust_mph`, `total4h_precipitation_in` | Maximum gust and sum of hourly precipitation over the four hours |
| `source` | `archive`, `forecast`, or `missing` |
| `missing_reason` | Why coverage is missing or partial; otherwise blank |

Kickoff is floored to its UTC hour. Aggregates use that hour and the next three
hours, crossing midnight/year boundaries as necessary. An aggregate is blank
unless all four measurements are present; missing measurements are never
treated as zero. Null kickoff values stay blank. For opposing wind directions
with no meaningful circular mean, average direction is blank. Indoor games
still receive **outdoor stadium weather**, not an estimate of indoor conditions.
Open-Meteo's precipitation/rain/snowfall values represent the preceding hour.

The job requests the [Open-Meteo Historical Weather API](https://open-meteo.com/en/docs/historical-weather-api)
for windows ending at least six UTC dates before today. For newer windows it
uses the [regular Forecast API](https://open-meteo.com/en/docs), including recent
past days and up to 16 forecast dates (today through today + 15).
Games beyond that forecast horizon, with TBD kickoff times, unmatched venues,
or unavailable weather receive `source=missing` and an explanation.
Sources describe the selected API, not observed station measurements; archive
data is gridded historical weather and forecasts are model predictions.

Requests are batched by venue and season: at most one archive request and,
when needed, one forecast request for that venue/season's eligible date range.
Only needed historical game hours are cached under ignored `.cache/weather/`.
Repeat pulls reuse those stable archive values. Forecasts are always fetched
again, and are replaced by archive values when old enough. Changed venue
coordinates invalidate the corresponding cached archive hours.

The initial pull can take a long time. Calls are paced, rate-limit/server
errors receive bounded backoff, and completed venue caches let another run
resume without starting over. A season CSV is replaced atomically only after
all its venue requests succeed. Completed season files are retained and
published **as soon as each season finishes, before the next season starts**.
A later season or publishing failure never undoes already-published seasons.
If a process is interrupted, resume will also retry publishing any saved
season whose push did not complete. A weather failure never rolls back the
existing games, lines, drives, or compact exports. During Refresh 2026, those
updated non-weather files are still published if weather collection fails.
Request starts, HTTP statuses, retries, and season publication successes are
logged without credentials; request counters are saved before each request.

The free Open-Meteo service is for non-commercial use and has request limits;
large date ranges may count as multiple calls against those limits. See its
[terms](https://open-meteo.com/en/terms). Data attribution:
[Open-Meteo](https://open-meteo.com/) and its underlying weather data providers,
licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
CFBD data remains subject to CFBD's terms.

Weather CSVs are raw season-level files and may exceed 90 KB. The existing
`export/` compact parts retain their original schema and size limits.
