import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { build } from "esbuild";

const result = await build({ entryPoints: ["src/lib/weather.ts"], platform: "node", format: "esm", bundle: true, write: false });
const { collectWeather, gameWeather, planWindow, weatherUrl, parseHours, variables } = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`
);
const now = new Date("2026-10-20T12:00:00Z");
const venue = { id: 1, name: "Stadium", latitude: 0, longitude: 0, dome: true, grass: false };
const game = (id, kickoff) => ({ id, season: 2026, week: 1, venueId: 1, startDate: kickoff });
function payload(start, end) {
  const time = [];
  for (let hour = Date.parse(start); hour <= Date.parse(end); hour += 3600000) time.push(new Date(hour).toISOString().slice(0, 16));
  return { utc_offset_seconds: 0, hourly_units: { snowfall: "cm" }, hourly: {
    time, ...Object.fromEntries(variables.map((v, i) => [v, time.map(() => i === 6 ? 2.54 : 10 + i)])),
  } };
}

test("UTC windows choose archive/forecast, cross midnight, and leave distant games missing", () => {
  assert.equal(planWindow("2026-10-01T23:45:00Z", now).source, "archive");
  assert.equal(planWindow("2026-10-14T23:45:00Z", now).source, "forecast");
  assert.equal(planWindow("2026-10-19T23:45:00Z", now).source, "forecast");
  assert.equal(planWindow("2026-11-10T18:00:00Z", now).source, null);
  assert.equal(planWindow("", now), null);
  const url = weatherUrl("archive", 0, 0, Date.parse("2015-12-31T23:00Z"), Date.parse("2016-01-01T02:00Z"));
  assert.equal(url.searchParams.get("end_date"), "2016-01-01");
  assert.equal(url.searchParams.get("timezone"), "UTC");
  assert.equal(url.searchParams.get("temperature_unit"), "fahrenheit");
  assert.equal(url.searchParams.get("wind_speed_unit"), "mph");
  assert.equal(url.searchParams.get("precipitation_unit"), "inch");
});

test("4-hour aggregates include kickoff plus three hours, circular wind, gust maximum, precipitation total and snowfall conversion", () => {
  const response = payload("2026-10-01T23:00Z", "2026-10-02T02:00Z");
  response.hourly.temperature_2m = [60, 62, 64, 66];
  response.hourly.wind_direction_10m = [350, 10, 350, 10];
  response.hourly.wind_gusts_10m = [10, 20, 30, 40];
  response.hourly.precipitation = [0, 0.1, 0.2, 0.3];
  const row = gameWeather(game(1, "2026-10-01T23:45:00Z"), venue, parseHours(response), "archive", now);
  assert.equal(row.kickoff_temperature_f, 60);
  assert.equal(row.avg4h_temperature_f, 63);
  assert.equal(row.avg4h_wind_direction_deg, 0);
  assert.equal(row.max4h_gust_mph, 40);
  assert.equal(row.total4h_precipitation_in, 0.6);
  assert.equal(row.kickoff_snowfall_in, 1);
  assert.equal(row.dome, 1);
  assert.equal(row.latitude, 0);
});

test("missing venues, null measurements and incomplete windows never become zero weather", () => {
  assert.equal(gameWeather(game(1, "2026-10-01T12:00Z"), undefined, {}, null, now).source, "missing");
  const response = payload("2026-10-01T12:00Z", "2026-10-01T14:00Z");
  response.hourly.temperature_2m[0] = null;
  const row = gameWeather(game(1, "2026-10-01T12:00Z"), venue, parseHours(response), "archive", now);
  assert.equal(row.kickoff_temperature_f, "");
  assert.equal(row.avg4h_temperature_f, "");
  assert.equal(row.total4h_precipitation_in, "");
  assert.throws(() => parseHours({}), /invalid/);
});

test("batches by venue/season, reuses archives and venues, refreshes forecasts, promotes to archive and preserves raw inputs on failure", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cfb-weather-test-"));
  const data = path.join(root, "data");
  const calls = [];
  const entries = [];
  const request = async (url, cfbd) => {
    calls.push(String(url));
    if (cfbd) return [venue];
    return payload(url.searchParams.get("start_date"), url.searchParams.get("end_date") + "T23:00Z");
  };
  const options = { now, request, saved: async entry => entries.push(entry), progress: async () => {} };
  try {
    await fs.mkdir(data);
    const csv = "id,season,week,venueId,startDate,startTimeTBD\n1,2026,1,1,2026-10-01T23:30:00Z,false\n2,2026,2,1,2026-10-03T12:00:00Z,false\n3,2026,3,1,2026-10-19T18:00:00Z,false\n4,2026,4,1,2026-12-01T12:00:00Z,false\n5,2026,5,999,2026-10-01T12:00:00Z,false\n";
    await fs.writeFile(path.join(data, "games_2026.csv"), csv);
    await fs.writeFile(path.join(data, "weather_2025.csv"), "untouched");
    await collectWeather(data, [2026], options);
    assert.equal(calls.length, 3); // venues + one archive + one forecast
    assert.equal(entries.at(-1).rowCount, 5);
    assert.equal(entries.at(-1).warnings.length, 1);
    assert.equal(await fs.readFile(path.join(data, "weather_2025.csv"), "utf8"), "untouched");
    calls.length = 0;
    await collectWeather(data, [2026], options);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].includes("/v1/forecast"));
    calls.length = 0;
    await collectWeather(data, [2026], { ...options, now: new Date("2026-10-30T12:00Z") });
    assert.equal(calls.length, 1);
    assert.ok(calls[0].includes("/v1/archive"));
    const previous = await fs.readFile(path.join(data, "weather_2026.csv"));
    await assert.rejects(collectWeather(data, [2026], {
      ...options, request: async () => { throw new Error("HTTP 429"); },
    }), /429/);
    assert.deepEqual(await fs.readFile(path.join(data, "weather_2026.csv")), previous);
    assert.equal(await fs.readFile(path.join(data, "games_2026.csv"), "utf8"), csv);
    calls.length = 0;
    await collectWeather(data, [], { ...options, refreshVenues: true });
    assert.equal(calls.length, 1);
    assert.equal(entries.at(-1).type, "venues");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
