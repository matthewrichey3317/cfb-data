import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";

const { outputFiles } = await build({ entryPoints: ["src/lib/compact-export.ts"], bundle: true, format: "esm", platform: "node", write: false });
const { compactSeason, buildCompactExport, COMPACT_COLUMNS } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`);
const game = (id, week = 1) => ({
  id, season: 2026, week, seasonType: "regular", startDate: "2026-09-01T17:30:00-05:00",
  completed: false, neutralSite: true, conferenceGame: false,
  homeTeam: "Home", awayTeam: "Away", homeConference: "SEC", awayConference: "",
  homePoints: null, awayPoints: null,
});
const drive = (isHomeOffense, result, start, end, plays, yards) => ({
  gameId: 1, isHomeOffense, driveResult: result, startOffenseScore: start,
  endOffenseScore: end, plays, yards,
});
function csv(rows, columns) {
  const keys = columns ?? [...new Set(rows.flatMap(Object.keys))];
  const cell = x => {
    const s = x == null ? "" : String(x);
    return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return keys.join(",") + "\n" + rows.map(r => keys.map(k => cell(r[k])).join(",")).join("\n") + "\n";
}
async function fixture(t, games, lines = [], drives = []) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "compact-export-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const data = path.join(root, "data"), out = path.join(root, "export");
  await fs.mkdir(data);
  for (const [kind, rows] of [["games", games], ["lines", lines], ["drives", drives]]) {
    await fs.writeFile(path.join(data, `${kind}_2026.csv`), csv(rows));
  }
  return { data, out };
}
test("medians skip blanks, retain home spread sign, count closing-total providers and blank absent data", async t => {
  const { data } = await fixture(t, [game(1), game(2)], [
    { gameId: 1, provider: "A", overUnder: 40, overUnderOpen: 41, spread: -7 },
    { gameId: 1, provider: "B", overUnder: 45.5, overUnderOpen: "", spread: -6.5 },
    { gameId: 1, provider: "C", overUnder: "", overUnderOpen: 43, spread: "" },
  ]);
  const [a, b] = await compactSeason(data, 2026);
  assert.equal(a.ou_close, "42.8");
  assert.equal(a.ou_open, "42");
  assert.equal(a.spread_close, "-6.8");
  assert.equal(a.total_providers, 2);
  assert.equal(a.kickoff_utc, "2026-09-01T22:30:00Z");
  assert.equal(a.completed, 0); assert.equal(a.neutral_site, 1);
  assert.equal(a.home_points, null);
  for (const key of ["ou_close", "ou_open", "spread_close", "total_providers", "home_drives", "away_drive_points"]) assert.equal(b[key], "");
  assert.deepEqual(Object.keys(a).sort(), [...COMPACT_COLUMNS].sort());
});
test("separates offenses and scores; defensive touchdowns and missed field goals are not offensive scores", async t => {
  const { data } = await fixture(t, [game(1)], [], [
    drive(true, "TD", 0, 7, 8, 75), drive(true, "FG", 7, 10, 5, 20),
    drive(true, "INT TD", 10, 10, 1, 0), drive(false, "RUSHING TD", 0, 6, 3, 60),
    drive(false, "MISSED FG", 6, 6, 4, 15), drive(false, "FG GOOD", 6, 9, 2, 5),
  ]);
  const [r] = await compactSeason(data, 2026);
  assert.deepEqual([r.home_drives, r.home_plays, r.home_yards, r.home_td, r.home_fg, r.home_drive_points], [3, 14, 95, 1, 1, 10]);
  assert.deepEqual([r.away_drives, r.away_plays, r.away_yards, r.away_td, r.away_fg, r.away_drive_points], [3, 9, 80, 1, 1, 9]);
});
test("UTF-8 byte limit includes headers, orders weeks and splits oversized weeks without losing rows", async t => {
  const games = Array.from({ length: 1500 }, (_, i) => ({ ...game(i + 1, i < 1000 ? 2 : 1), homeTeam: "Équipe ".repeat(15) }));
  const { data, out } = await fixture(t, games);
  const parts = await buildCompactExport(data, out, [2026]);
  assert.ok(parts.length > 1);
  assert.equal(parts.reduce((sum, p) => sum + p.rowCount, 0), games.length);
  let lastWeek = 0;
  for (const part of parts) {
    const text = await fs.readFile(path.join(out, part.file), "utf8");
    assert.ok(Buffer.byteLength(text) < 90000);
    assert.equal(Buffer.byteLength(text), part.bytes);
    assert.equal(text.split("\n")[0], COMPACT_COLUMNS.join(","));
    assert.ok(part.firstWeek >= lastWeek); lastWeek = part.lastWeek;
  }
});
test("season-only rebuild preserves other seasons and removes obsolete parts", async t => {
  const { data, out } = await fixture(t, [game(1)]);
  await fs.mkdir(out);
  const older = { file: "games_compact_2025_part1.csv", season: 2025, part: 1, firstWeek: 1, lastWeek: 1, rowCount: 1, bytes: 7 };
  await fs.writeFile(path.join(out, older.file), "keep me");
  await fs.writeFile(path.join(out, "games_compact_2026_part9.csv"), "obsolete");
  await fs.writeFile(path.join(out, "index.json"), JSON.stringify({ files: [older] }));
  const parts = await buildCompactExport(data, out, [2026]);
  assert.equal(await fs.readFile(path.join(out, older.file), "utf8"), "keep me");
  assert.deepEqual(parts.find(p => p.season === 2025), older);
  await assert.rejects(fs.access(path.join(out, "games_compact_2026_part9.csv")));
  assert.equal(parts.filter(p => p.season === 2026).length, 1);
});
