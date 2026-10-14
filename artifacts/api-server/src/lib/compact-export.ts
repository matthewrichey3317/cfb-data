import { promises as fs } from "node:fs";
import path from "node:path";
import { csvCell, parseCsv, type Row } from "./collector-csv";

// Decimal KB: leave every file strictly below 90,000 bytes, including its header.
export const MAX_PART_BYTES = 90000;
export const COMPACT_COLUMNS = [
  "game_id", "season", "week", "season_type", "kickoff_utc", "completed",
  "neutral_site", "conference_game", "home_team", "away_team",
  "home_conference", "away_conference", "home_points", "away_points",
  "ou_close", "ou_open", "spread_close", "total_providers",
  "home_drives", "home_plays", "home_yards", "home_td", "home_fg", "home_drive_points",
  "away_drives", "away_plays", "away_yards", "away_td", "away_fg", "away_drive_points",
] as const;
type Part = { file: string; season: number; part: number; firstWeek: number; lastWeek: number; rowCount: number; bytes: number };
type Side = { drives: number; plays: number; yards: number; td: number; fg: number; points: number };
type Market = { close: number[]; open: number[]; spread: number[]; totalProviders: Set<string> };
const emptySide = (): Side => ({ drives: 0, plays: 0, yards: 0, td: 0, fg: 0, points: 0 });

function number(value: unknown): number | null {
  if (value == null || String(value).trim() === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`Invalid numeric value: ${String(value)}`);
  return n;
}
function requiredNumber(value: unknown, label: string): number {
  const n = number(value);
  if (n === null) throw new Error(`Missing ${label}`);
  return n;
}
function flag(value: unknown): number {
  if (value === "true" || value === "1" || value === true) return 1;
  if (value === "false" || value === "0" || value === false) return 0;
  throw new Error(`Invalid boolean: ${String(value)}`);
}
function decimal(n: number | null): string {
  return n === null ? "" : String(Number(n.toFixed(1)));
}
function median(values: number[]): string {
  if (!values.length) return "";
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return decimal(sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2);
}
async function readRows(dataDir: string, kind: string, year: number): Promise<Row[]> {
  return parseCsv(await fs.readFile(path.join(dataDir, `${kind}_${year}.csv`), "utf8"));
}

export async function compactSeason(dataDir: string, year: number): Promise<Row[]> {
  const games = await readRows(dataDir, "games", year);
  const lines = await readRows(dataDir, "lines", year);
  const drives = await readRows(dataDir, "drives", year);
  const markets = new Map<string, Market>();
  const seenProviders = new Set<string>();
  for (const line of lines) {
    const id = String(line.gameId || line.id);
    const provider = String(line.provider);
    const key = `${id}:${provider}`;
    if (seenProviders.has(key)) throw new Error(`Duplicate line provider for ${key}`);
    seenProviders.add(key);
    const market = markets.get(id) ?? { close: [], open: [], spread: [], totalProviders: new Set<string>() };
    const close = number(line.overUnder), open = number(line.overUnderOpen), spread = number(line.spread);
    if (close !== null) { market.close.push(close); market.totalProviders.add(provider); }
    if (open !== null) market.open.push(open);
    if (spread !== null) market.spread.push(spread);
    markets.set(id, market);
  }
  const stats = new Map<string, { home: Side; away: Side }>();
  for (const drive of drives) {
    const id = String(drive.gameId);
    const gameStats = stats.get(id) ?? { home: emptySide(), away: emptySide() };
    const side = flag(drive.isHomeOffense) ? gameStats.home : gameStats.away;
    const points = requiredNumber(drive.endOffenseScore, "end offense score") - requiredNumber(drive.startOffenseScore, "start offense score");
    const result = String(drive.driveResult).trim().toUpperCase();
    side.drives++;
    side.plays += requiredNumber(drive.plays, "drive plays");
    side.yards += requiredNumber(drive.yards, "drive yards");
    // Score movement identifies offensive TDs, not pick-six/return TDs by the defense.
    if ((result === "TD" || result.endsWith(" TD") || result.includes("TOUCHDOWN")) && points >= 6) side.td++;
    if (result === "FG" || result === "FG GOOD" || result === "FIELD GOAL") side.fg++;
    side.points += points;
    stats.set(id, gameStats);
  }
  const seenGames = new Set<string>();
  const rows = games.map(game => {
    const id = String(game.id);
    if (seenGames.has(id)) throw new Error(`Duplicate game ${id}`);
    seenGames.add(id);
    if (number(game.season) !== year) throw new Error(`Wrong season for game ${id}`);
    if (game.seasonType !== "regular" && game.seasonType !== "postseason") throw new Error(`Unexpected season type for game ${id}`);
    const kickoff = new Date(String(game.startDate));
    if (!Number.isFinite(kickoff.getTime())) throw new Error(`Invalid kickoff for ${id}`);
    const market = markets.get(id), gameStats = stats.get(id);
    const row: Row = {
      game_id: id, season: year, week: requiredNumber(game.week, "game week"),
      season_type: game.seasonType, kickoff_utc: kickoff.toISOString().replace(".000Z", "Z"),
      completed: flag(game.completed), neutral_site: flag(game.neutralSite),
      conference_game: flag(game.conferenceGame),
      home_team: game.homeTeam, away_team: game.awayTeam,
      home_conference: game.homeConference, away_conference: game.awayConference,
      home_points: number(game.homePoints), away_points: number(game.awayPoints),
      ou_close: market ? median(market.close) : "", ou_open: market ? median(market.open) : "",
      spread_close: market ? median(market.spread) : "", total_providers: market ? market.totalProviders.size : "",
    };
    for (const [prefix, side] of [["home", gameStats?.home], ["away", gameStats?.away]] as const) {
      row[`${prefix}_drives`] = side?.drives ?? "";
      row[`${prefix}_plays`] = side?.plays ?? "";
      row[`${prefix}_yards`] = side?.yards ?? "";
      row[`${prefix}_td`] = side?.td ?? "";
      row[`${prefix}_fg`] = side?.fg ?? "";
      row[`${prefix}_drive_points`] = side?.points ?? "";
    }
    return row;
  });
  return rows.sort((a, b) => Number(a.week) - Number(b.week) ||
    String(a.season_type).localeCompare(String(b.season_type)) ||
    String(a.kickoff_utc).localeCompare(String(b.kickoff_utc)) ||
    Number(a.game_id) - Number(b.game_id));
}

function splitSeason(rows: Row[], year: number): { entry: Part; csv: string }[] {
  const header = COMPACT_COLUMNS.join(",") + "\n";
  const headerBytes = Buffer.byteLength(header);
  let csv = header, bytes = headerBytes, count = 0, firstWeek = 0, lastWeek = 0;
  const parts: { entry: Part; csv: string }[] = [];
  function flush() {
    if (!count) return;
    const part = parts.length + 1;
    parts.push({ entry: { file: `games_compact_${year}_part${part}.csv`, season: year, part, firstWeek, lastWeek, rowCount: count, bytes }, csv });
    csv = header; bytes = headerBytes; count = 0;
  }
  // Keep whole weeks together when possible, splitting a week only if needed.
  const weeks = new Map<number, Row[]>();
  for (const row of rows) {
    const week = Number(row.week);
    const group = weeks.get(week) ?? [];
    group.push(row); weeks.set(week, group);
  }
  for (const [week, group] of weeks) {
    const records = group.map(row => COMPACT_COLUMNS.map(column => {
      const value = row[column];
      return csvCell(typeof value === "number" ? decimal(value) : value);
    }).join(",") + "\n");
    const groupBytes = records.reduce((n, record) => n + Buffer.byteLength(record), 0);
    if (count && bytes + groupBytes >= MAX_PART_BYTES) flush();
    for (const record of records) {
      const size = Buffer.byteLength(record);
      if (headerBytes + size >= MAX_PART_BYTES) throw new Error("A compact game row exceeds the part limit");
      if (bytes + size >= MAX_PART_BYTES) flush();
      if (!count) firstWeek = week;
      lastWeek = week;
      csv += record; bytes += size; count++;
    }
  }
  flush();
  return parts;
}

export async function buildCompactExport(dataDir: string, exportDir: string, seasons: number[]) {
  if (!seasons.length || new Set(seasons).size !== seasons.length ||
    seasons.some(y => !Number.isInteger(y) || y < 2015 || y > 2026)) throw new Error("Export seasons must be unique years from 2015–2026");
  await fs.mkdir(exportDir, { recursive: true });
  // Prevent a CLI export and a refresh from writing the same index concurrently.
  const lockPath = path.join(exportDir, ".build.lock");
  const lock = await fs.open(lockPath, "wx");
  const staged: string[] = [];
  try {
    let previous: Part[] = [];
    try { previous = JSON.parse(await fs.readFile(path.join(exportDir, "index.json"), "utf8")).files; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    const parts = [];
    for (const year of seasons) parts.push(...splitSeason(await compactSeason(dataDir, year), year));
    const files = [...previous.filter(p => !seasons.includes(p.season)), ...parts.map(p => p.entry)]
      .sort((a, b) => a.season - b.season || a.part - b.part);
    // Build and validate everything before replacing any existing export.
    for (const part of parts) {
      const temp = path.join(exportDir, part.entry.file + ".tmp");
      staged.push(temp);
      await fs.writeFile(temp, part.csv);
    }
    const indexTemp = path.join(exportDir, "index.json.tmp");
    staged.push(indexTemp);
    await fs.writeFile(indexTemp, JSON.stringify({ files }, null, 2) + "\n");
    for (const part of parts) await fs.rename(path.join(exportDir, part.entry.file + ".tmp"), path.join(exportDir, part.entry.file));
    await fs.rename(indexTemp, path.join(exportDir, "index.json"));
    // Drop obsolete part numbers only for the seasons being rebuilt.
    const keep = new Set(files.map(p => p.file));
    for (const name of await fs.readdir(exportDir)) {
      const match = /^games_compact_(\d{4})_part\d+\.csv$/.exec(name);
      if (match && seasons.includes(Number(match[1])) && !keep.has(name)) await fs.rm(path.join(exportDir, name));
    }
    return files;
  } finally {
    for (const temp of staged) await fs.rm(temp, { force: true });
    await lock.close();
    await fs.rm(lockPath, { force: true });
  }
}
