import { promises as fs } from "node:fs";
import path from "node:path";
import { parseCsv, toCsv, type Row } from "./collector-csv";

const HOUR = 3600000;
const DAY = 24 * HOUR;
export const variables = [
  "temperature_2m", "wind_speed_10m", "wind_gusts_10m", "wind_direction_10m",
  "precipitation", "rain", "snowfall", "relative_humidity_2m",
] as const;
const labels = ["temperature_f", "wind_mph", "gust_mph", "wind_direction_deg", "precipitation_in", "rain_in", "snowfall_in", "humidity_pct"];
export const weatherColumns = [
  "game_id", "season", "week", "venue_id", "latitude", "longitude", "dome", "kickoff_utc",
  ...labels.map(name => `kickoff_${name}`), ...labels.map(name => `avg4h_${name}`),
  "max4h_gust_mph", "total4h_precipitation_in", "source", "missing_reason",
];
const venueColumns = ["id", "name", "city", "state", "latitude", "longitude", "elevation", "timezone", "dome", "grass"];
type Values = (number | null)[];
type Hours = Record<string, Values>;
type Source = "archive" | "forecast";
export type WeatherEntry = { file: string; type: "venues" | "weather"; season: number; rowCount: number; pulledAt: string; bytes: number; warnings: string[] };
type Options = {
  refreshVenues?: boolean;
  now?: Date;
  request?: (url: URL, cfbd?: boolean) => Promise<unknown>;
  progress: (message: string) => Promise<void>;
  saved: (entry: WeatherEntry) => Promise<void>;
};
const numeric = (value: unknown): number | null =>
  value === "" || value == null || !Number.isFinite(Number(value)) ? null : Number(value);
const flag = (value: unknown) => value === true || value === "true" || value === "1" ? 1 : value === false || value === "false" || value === "0" ? 0 : "";
const date = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const round = (value: number) => Math.round(value * 1000) / 1000;
const hourKey = (ms: number) => new Date(ms).toISOString().slice(0, 13) + ":00";

export async function atomicWeatherJson(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(`${file}.tmp`, JSON.stringify(value));
  await fs.rename(`${file}.tmp`, file);
}

export function planWindow(kickoff: unknown, now = new Date()) {
  const timestamp = typeof kickoff === "string" && kickoff.trim() ? Date.parse(kickoff) : NaN;
  if (!Number.isFinite(timestamp)) return null;
  const start = Math.floor(timestamp / HOUR) * HOUR;
  const today = Date.parse(now.toISOString().slice(0, 10));
  const archiveEnd = today - 6 * DAY + 23 * HOUR;
  const forecastStart = today - 7 * DAY;
  const forecastEnd = today + 16 * DAY - HOUR;
  // One source for the entire 4-hour window, even across midnight.
  const source: Source | null = start + 3 * HOUR <= archiveEnd ? "archive"
    : start >= forecastStart && start + 3 * HOUR <= forecastEnd ? "forecast" : null;
  return { start, end: start + 3 * HOUR, source };
}

export function weatherUrl(source: Source, lat: number, lon: number, start: number, end: number) {
  const url = new URL(source === "archive" ? "https://archive-api.open-meteo.com/v1/archive" : "https://api.open-meteo.com/v1/forecast");
  Object.entries({
    latitude: String(lat), longitude: String(lon), start_date: date(start), end_date: date(end),
    timezone: "UTC", temperature_unit: "fahrenheit", wind_speed_unit: "mph",
    precipitation_unit: "inch", hourly: variables.join(","),
  }).forEach(([key, value]) => url.searchParams.set(key, value));
  return url;
}

export function parseHours(payload: unknown): Hours {
  const body = payload as { error?: boolean; utc_offset_seconds?: number; hourly?: Record<string, unknown[]>; hourly_units?: Record<string, string> };
  if (!body || body.error || !body.hourly || !Array.isArray(body.hourly.time) || body.utc_offset_seconds !== 0) {
    throw new Error("Open-Meteo returned invalid or non-UTC hourly data");
  }
  for (const variable of variables) {
    if (!Array.isArray(body.hourly[variable]) || body.hourly[variable].length !== body.hourly.time.length) {
      throw new Error(`Open-Meteo hourly response lacks ${variable}`);
    }
  }
  const snowUnit = body.hourly_units?.snowfall;
  if (!snowUnit || !["inch", "cm", "mm"].includes(snowUnit)) throw new Error("Open-Meteo returned unknown snowfall units");
  return Object.fromEntries(body.hourly.time.map((time, index) => [
    String(time).slice(0, 16),
    variables.map(variable => {
      const n = numeric(body.hourly![variable][index]);
      if (n === null || variable !== "snowfall") return n;
      return snowUnit === "cm" ? n / 2.54 : snowUnit === "mm" ? n / 25.4 : n;
    }),
  ]));
}

function mean(values: number[], circular: boolean) {
  if (!circular) return values.reduce((sum, n) => sum + n, 0) / values.length;
  const x = values.reduce((sum, n) => sum + Math.cos(n * Math.PI / 180), 0);
  const y = values.reduce((sum, n) => sum + Math.sin(n * Math.PI / 180), 0);
  return Math.hypot(x, y) < 1e-8 ? null : (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

export function gameWeather(game: Row, venue: Row | undefined, hours: Hours, source: Source | null, now: Date): Row {
  const row: Row = Object.fromEntries(weatherColumns.map(column => [column, ""]));
  Object.assign(row, {
    game_id: game.id, season: game.season, week: game.week, venue_id: game.venueId,
    latitude: numeric(venue?.latitude) ?? "", longitude: numeric(venue?.longitude) ?? "",
    dome: flag(venue?.dome), kickoff_utc: game.startDate, source: "missing",
  });
  const window = planWindow(game.startDate, now);
  if (!venue || numeric(venue.latitude) === null || numeric(venue.longitude) === null || Math.abs(Number(venue.latitude)) > 90 || Math.abs(Number(venue.longitude)) > 180) row.missing_reason = "unmatched venue or coordinates";
  else if (!window) row.missing_reason = "invalid kickoff";
  else if (game.startTimeTBD === "true" || game.startTimeTBD === true) row.missing_reason = "kickoff time TBD";
  else if (!source) row.missing_reason = "outside forecast window";
  else {
    const samples = Array.from({ length: 4 }, (_, i) => hours[hourKey(window.start + i * HOUR)]);
    if (!samples[0] || samples[0].every(n => n === null)) {
      row.missing_reason = "weather unavailable at kickoff";
      return row;
    }
    row.source = source;
    labels.forEach((label, i) => {
      row[`kickoff_${label}`] = samples[0]?.[i] == null ? "" : round(samples[0][i]!);
      const values = samples.map(sample => sample?.[i]);
      if (values.every((n): n is number => typeof n === "number")) {
        const average = mean(values, i === 3);
        row[`avg4h_${label}`] = average === null ? "" : round(average);
      }
    });
    const gusts = samples.map(sample => sample?.[2]);
    const precip = samples.map(sample => sample?.[4]);
    if (gusts.every((n): n is number => typeof n === "number")) row.max4h_gust_mph = round(Math.max(...gusts));
    if (precip.every((n): n is number => typeof n === "number")) row.total4h_precipitation_in = round(precip.reduce((a, b) => a + b, 0));
    if (samples.some(sample => !sample || sample.some(n => n === null))) row.missing_reason = "partial hourly coverage; incomplete aggregates blank";
  }
  return row;
}

export async function collectWeather(dataDir: string, seasons: number[], options: Options) {
  const now = options.now ?? new Date();
  const request = options.request!;
  const venueFile = path.join(dataDir, "venues.csv");
  let venues: Row[];
  try {
    if (options.refreshVenues) throw Object.assign(new Error(), { code: "ENOENT" });
    venues = parseCsv(await fs.readFile(venueFile, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await options.progress("Fetching CFBD venue coordinates");
    const response = await request(new URL("https://api.collegefootballdata.com/venues"), true);
    if (!Array.isArray(response) || !response.length || response.some(v => !v || typeof v !== "object" || v.id == null)) throw new Error("Invalid CFBD venues response");
    venues = response.map(v => Object.fromEntries(venueColumns.map(column => [column, column === "dome" || column === "grass" ? flag(v[column]) : v[column] ?? ""])));
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(`${venueFile}.tmp`, toCsv(venues, venueColumns));
    await fs.rename(`${venueFile}.tmp`, venueFile);
  }
  const venueStat = await fs.stat(venueFile);
  await options.saved({ file: "venues.csv", type: "venues", season: 0, rowCount: venues.length, bytes: venueStat.size, pulledAt: venueStat.mtime.toISOString(), warnings: [] });
  const venueMap = new Map(venues.map(v => [String(v.id), v]));
  const cacheDir = path.resolve(dataDir, "../.cache/weather");
  for (const season of seasons) {
    const games = parseCsv(await fs.readFile(path.join(dataDir, `games_${season}.csv`), "utf8"));
    const groups = new Map<string, Row[]>();
    for (const game of games) {
      const venue = venueMap.get(String(game.venueId));
      const lat = numeric(venue?.latitude), lon = numeric(venue?.longitude);
      if (!venue || lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
      const group = groups.get(String(game.venueId)) ?? [];
      group.push(game);
      groups.set(String(game.venueId), group);
    }
    const rows = new Map<Row, Row>();
    let completed = 0;
    for (const [id, group] of groups) {
      const venue = venueMap.get(id)!;
      await options.progress(`Weather ${season}: venue ${++completed}/${groups.size} · ${venue.name}`);
      for (const source of ["archive", "forecast"] as const) {
        const eligible = group.filter(game => planWindow(game.startDate, now)?.source === source && game.startTimeTBD !== "true" && game.startTimeTBD !== true);
        if (!eligible.length) continue;
        const starts = eligible.map(game => planWindow(game.startDate, now)!.start);
        const needed = starts.flatMap(start => Array.from({ length: 4 }, (_, i) => hourKey(start + i * HOUR)));
        const cacheFile = path.join(cacheDir, `${season}_${id}_${source}.json`);
        let hours: Hours = {};
        const identity = `${venue.latitude},${venue.longitude}`;
        if (source === "archive") {
          try {
            const cached = JSON.parse(await fs.readFile(cacheFile, "utf8"));
            if (cached.version === 1 && cached.identity === identity) hours = cached.hours;
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
        if (source === "forecast" || needed.some(key => !(key in hours))) {
          const url = weatherUrl(source, Number(venue.latitude), Number(venue.longitude), Math.min(...starts), Math.max(...starts) + 3 * HOUR);
          const received = parseHours(await request(url));
          hours = Object.fromEntries(needed.filter(key => received[key]).map(key => [key, received[key]]));
          // Only stable archive values are reused. Forecasts are always requested anew.
          if (source === "archive") await atomicWeatherJson(cacheFile, { version: 1, identity, hours });
        }
        for (const game of eligible) rows.set(game, gameWeather(game, venue, hours, source, now));
      }
    }
    const output = games.map(game => rows.get(game) ?? gameWeather(game, venueMap.get(String(game.venueId)), {}, null, now));
    const file = `weather_${season}.csv`;
    const csv = toCsv(output, weatherColumns);
    await fs.writeFile(path.join(dataDir, `${file}.tmp`), csv);
    await fs.rename(path.join(dataDir, `${file}.tmp`), path.join(dataDir, file));
    const missing = output.filter(row => row.source === "missing").length;
    const partial = output.filter(row => row.source !== "missing" && row.missing_reason).length;
    await options.saved({ file, type: "weather", season, rowCount: output.length, bytes: Buffer.byteLength(csv), pulledAt: new Date().toISOString(),
      warnings: [...(missing ? [`${missing} games have missing weather (see missing_reason).`] : []), ...(partial ? [`${partial} games have incomplete hourly coverage.`] : [])] });
  }
}
