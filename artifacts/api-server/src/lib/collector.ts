import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./logger";
import { parseCsv, toCsv, type Row } from "./collector-csv";
import { buildCompactExport } from "./compact-export";
import { publishCurrentSeason, publishWeather } from "./github-publish";
import { collectWeather, type WeatherEntry } from "./weather";
import { weatherRequest } from "./weather-request";
import { recoverSavedJob, type CollectorJob as Job } from "./job-recovery";

// Both src/lib/collector.ts and bundled dist/index.mjs resolve to this package.
const packageDir = path.dirname(fileURLToPath(import.meta.url)).endsWith("/dist")
  ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export let dataDir = path.resolve(packageDir, "../../data");
const kinds = ["games", "lines", "drives"] as const;
type Kind = typeof kinds[number];
type Entry = { file: string; type: Kind | "venues" | "weather"; season: number; rowCount: number; pulledAt: string; bytes: number; warnings: string[] };
const idleJob: Job = { state: "idle", mode: "", message: "Ready to collect", completedFiles: 0, totalFiles: 0, calls: 0, skippedFiles: 0, startedAt: null, finishedAt: null, interruptedAt: null, error: null };
let job: Job = { ...idleJob };
let active = false;
let initialization: Promise<void> | undefined;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const defaultColumns: Record<Kind, string[]> = {
  games: ["id", "season", "week", "seasonType", "startDate", "completed", "neutralSite", "conferenceGame", "venue", "homeTeam", "homeConference", "homePoints", "awayTeam", "awayConference", "awayPoints"],
  lines: ["id", "gameId", "season", "week", "seasonType", "homeTeam", "awayTeam", "provider", "overUnder", "overUnderOpen", "spread", "spreadOpen", "homeMoneyline", "awayMoneyline"],
  drives: ["id", "gameId", "season", "seasonType", "offense", "defense", "startPeriod", "startTime", "endPeriod", "endTime", "startYardline", "plays", "yards", "driveResult", "scoring", "startOffenseScore", "startDefenseScore", "endOffenseScore", "endDefenseScore"],
};

async function atomicJson(name: string, value: unknown) {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, `${name}.tmp`), JSON.stringify(value, null, 2) + "\n");
  await fs.rename(path.join(dataDir, `${name}.tmp`), path.join(dataDir, name));
}
async function exists(name: string) {
  try { await fs.access(path.join(dataDir, name)); return true; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
}
async function readManifest(): Promise<Entry[]> {
  try { return (JSON.parse(await fs.readFile(path.join(dataDir, "manifest.json"), "utf8")) as { files: Entry[] }).files; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
}
async function saveJob() { await atomicJson("job.json", job); }

async function collectEndpoint(kind: Kind, season: number, seasonType: string): Promise<Row[]> {
  const url = new URL(`https://api.collegefootballdata.com/${kind}`);
  url.searchParams.set("year", String(season));
  url.searchParams.set("seasonType", seasonType);
  if (kind !== "lines") url.searchParams.set("classification", "fbs");
  for (let attempt = 0; attempt < 5; attempt++) {
    await sleep(1100);
    job.calls++;
    job.message = `Fetching ${kind} · ${season} · ${seasonType}`;
    await saveJob();
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${process.env.CFBD_API_KEY}`, Accept: "application/json" },
        signal: AbortSignal.timeout(120000),
      });
    } catch {
      if (attempt === 4) throw new Error(`CFBD network/timeout error for ${kind} ${season} ${seasonType}`);
      await sleep(3000 * 2 ** attempt);
      continue;
    }
    if (response.status === 429 || response.status >= 500) {
      if (attempt === 4) throw new Error(`CFBD HTTP ${response.status} after 5 attempts. Re-run to resume.`);
      const retry = response.headers.get("retry-after");
      const seconds = retry ? Number(retry) : NaN;
      const wait = retry && !Number.isFinite(seconds) ? Date.parse(retry) - Date.now() : seconds * 1000;
      const delay = Math.max(Number.isFinite(wait) ? wait : 0, 5000 * 2 ** attempt);
      if (delay > 300000) throw new Error("CFBD requests a retry more than 5 minutes away. Resume later.");
      job.message = `CFBD HTTP ${response.status}; waiting ${Math.ceil(delay / 1000)} seconds before retry`;
      await saveJob();
      await response.body?.cancel();
      await sleep(delay);
      continue;
    }
    if (!response.ok) {
      const advice = response.status === 401 ? "Check CFBD_API_KEY." : response.status === 403 ? "Check API access or monthly quota." : "Check endpoint availability.";
      throw new Error(`CFBD HTTP ${response.status} for ${kind} ${season} ${seasonType}. ${advice}`);
    }
    const rows: unknown = await response.json();
    if (!Array.isArray(rows) || rows.some(r => !r || typeof r !== "object" || Array.isArray(r))) throw new Error(`Unexpected CFBD response for ${kind} ${season}`);
    return rows as Row[];
  }
  throw new Error("Retry limit reached");
}

async function pullFile(kind: Kind, season: number, refresh: boolean) {
  const file = `${kind}_${season}.csv`;
  if (!refresh && await exists(file)) {
    // Reconcile an existing CSV without spending API calls.
    const manifest = await readManifest();
    if (!manifest.some(e => e.file === file)) {
      const stat = await fs.stat(path.join(dataDir, file));
      const rows = parseCsv(await fs.readFile(path.join(dataDir, file), "utf8"));
      manifest.push({ file, type: kind, season, rowCount: rows.length, bytes: stat.size, pulledAt: stat.mtime.toISOString(), warnings: ["Pull timestamp inferred from existing file modification time."] });
      await atomicJson("manifest.json", { version: 1, files: manifest });
    }
    job.skippedFiles++; return;
  }
  let rows: Row[] = [];
  for (const seasonType of ["regular", "postseason"]) {
    // Persist successful half-pulls so failures do not waste earlier calls.
    const part = `.${kind}_${season}_${seasonType}.part.json`;
    const raw: Row[] = await exists(part)
      ? JSON.parse(await fs.readFile(path.join(dataDir, part), "utf8"))
      : await collectEndpoint(kind, season, seasonType);
    if (!await exists(part)) await atomicJson(part, raw);
    rows.push(...raw.map(r => ({ ...r, season: r.season ?? season, seasonType: r.seasonType ?? seasonType })));
  }
  if (kind === "lines" || kind === "drives") {
    const games = parseCsv(await fs.readFile(path.join(dataDir, `games_${season}.csv`), "utf8"));
    const ids = new Set(games.map(g => String(g.id)));
    rows = rows.filter(r => ids.has(String(kind === "lines" ? r.id : r.gameId)));
  }
  if (kind === "lines") {
    rows = rows.flatMap(game => {
      if (!Array.isArray(game.lines)) throw new Error("CFBD lines response lacks provider list");
      return game.lines.map((line: Row) => ({ ...game, ...line, gameId: game.id }));
    });
  }
  if (kind === "drives") {
    rows = rows.map(r => {
      const flat: Row = { ...r };
      for (const key of ["startTime", "endTime", "elapsed"]) {
        if (r[key] && typeof r[key] === "object") {
          for (const [sub, value] of Object.entries(r[key] as Row)) flat[`${key}.${sub}`] = value;
        }
      }
      return flat;
    });
  }
  // Deduplicate by stable identifiers without dropping any provider columns.
  const seen = new Set<string>();
  rows = rows.filter(r => {
    const key = kind === "lines" ? `${r.gameId}:${r.provider}` : `${r.id}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  const csv = toCsv(rows, defaultColumns[kind]);
  const warnings: string[] = [];
  if (season < 2026 && kind === "games" && (rows.length < 700 || rows.length > 1100)) warnings.push("Game count outside typical range; 2020 was pandemic-shortened.");
  if (season < 2026 && kind === "drives" && rows.length < 15000) warnings.push("Drive count lower than a typical full season.");
  if (!rows.length) warnings.push("CFBD returned no rows; future postseason data may not be available yet.");
  await fs.writeFile(path.join(dataDir, `${file}.tmp`), csv);
  await fs.rename(path.join(dataDir, `${file}.tmp`), path.join(dataDir, file));
  const entry: Entry = { file, type: kind, season, rowCount: rows.length, bytes: Buffer.byteLength(csv), pulledAt: new Date().toISOString(), warnings };
  const manifest = (await readManifest()).filter(e => e.file !== file);
  manifest.push(entry);
  manifest.sort((a, b) => a.season - b.season || a.type.localeCompare(b.type));
  await atomicJson("manifest.json", { version: 1, files: manifest });
  for (const st of ["regular", "postseason"]) await fs.rm(path.join(dataDir, `.${kind}_${season}_${st}.part.json`), { force: true });
  logger.info({ file, rowCount: rows.length }, "CFBD CSV saved");
}

export function initializeCollector(): Promise<void> {
  initialization ??= (async () => {
    job = await recoverSavedJob(dataDir, idleJob);
    if (job.state === "interrupted") logger.warn({ interruptedAt: job.interruptedAt, mode: job.mode, calls: job.calls, message: job.message }, "Recovered interrupted collector job");
  })();
  return initialization;
}

export async function getStatus() {
  await initializeCollector();
  return { files: await readManifest(), job: { ...job }, keyConfigured: !!process.env.CFBD_API_KEY, currentSeason: 2026, expectedFiles: 36 };
}

async function beginJob(mode: "historical" | "refresh" | "weather", resume = false): Promise<void> {
  await initializeCollector();
  if (active) throw new Error("A pull is already running");
  if (!process.env.CFBD_API_KEY) throw new Error("CFBD_API_KEY is not configured");
  if (resume && (mode !== "weather" || job.mode !== "weather" || !["interrupted", "failed"].includes(job.state))) {
    throw new Error("There is no interrupted or failed weather job to resume");
  }
  const previous = resume ? { ...job } : { ...idleJob };
  active = true;
  job = { ...previous, state: "running", mode, error: null, finishedAt: null, completedFiles: 0,
    message: resume ? "Resuming weather using saved archive caches" : "Starting collection",
    totalFiles: mode === "refresh" ? 5 : mode === "weather" ? 13 : 36,
    startedAt: previous.startedAt ?? new Date().toISOString() };
  try { await saveJob(); } catch (e) { active = false; throw e; }
}

export async function startJob(mode: "historical" | "refresh" | "weather", refreshVenues = false, resume = false): Promise<Job> {
  await beginJob(mode, resume);
  void run(mode, refreshVenues);
  return { ...job };
}

// A scheduled process uses an isolated checkout, not the web server's files.
// Await the same pipeline as the button, including its verified GitHub push.
export async function refreshCurrentSeasonHeadless(workspaceRoot: string): Promise<Job> {
  if (initialization || active) throw new Error("Headless refresh requires its own fresh process");
  dataDir = path.resolve(workspaceRoot, "data");
  await beginJob("refresh");
  await run("refresh", false);
  if (job.state !== "completed") throw new Error(job.error ?? "Current-season refresh failed");
  return { ...job };
}

async function runWeather(seasons: number[], refreshVenues = false) {
  await collectWeather(dataDir, seasons, {
    refreshVenues,
    progress: async message => { job.message = message; await saveJob(); },
    request: (url, cfbd = false) => weatherRequest(url, cfbd,
      async message => { job.message = message; await saveJob(); },
      async () => { job.calls++; await saveJob(); }),
    saved: async (entry: WeatherEntry) => {
      const manifest = (await readManifest()).filter(file => file.file !== entry.file);
      manifest.push(entry);
      manifest.sort((a, b) => a.season - b.season || a.type.localeCompare(b.type));
      await atomicJson("manifest.json", { version: 1, files: manifest });
      job.completedFiles++;
      await saveJob();
      if (job.mode === "weather" && entry.type === "weather") {
        job.message = `Publishing weather ${entry.season} to GitHub`;
        await saveJob();
        await publishWeather(path.resolve(dataDir, ".."), entry.season);
        logger.info({ season: entry.season, file: entry.file, rowCount: entry.rowCount }, "Weather season saved and published");
      }
    },
  });
}

async function run(mode: "historical" | "refresh" | "weather", refreshVenues: boolean) {
  try {
    if (mode === "weather") {
      await runWeather(Array.from({ length: 12 }, (_, i) => 2015 + i), refreshVenues);
      job.state = "completed";
      job.message = "All weather seasons saved and published to GitHub";
      return;
    }
    if (mode === "refresh") {
      // A new weekly refresh must not reuse parts from an older interrupted refresh.
      for (const kind of kinds) for (const st of ["regular", "postseason"]) {
        await fs.rm(path.join(dataDir, `.${kind}_2026_${st}.part.json`), { force: true });
      }
    }
    const seasons = mode === "refresh" ? [2026] : Array.from({ length: 12 }, (_, i) => 2015 + i);
    for (const season of seasons) {
      for (const kind of kinds) {
        await pullFile(kind, season, mode === "refresh");
        job.completedFiles++;
        await saveJob();
      }
    }
    job.message = "Building compact export";
    await saveJob();
    await buildCompactExport(dataDir, path.resolve(dataDir, "../export"), seasons);
    if (mode === "refresh") {
      let weatherError: unknown;
      try { await runWeather([2026]); }
      catch (error) { weatherError = error; }
      job.message = "Publishing updated 2026 files to GitHub";
      await saveJob();
      await publishCurrentSeason(path.resolve(dataDir, ".."));
      if (weatherError) throw new Error(`Games and compact exports saved and pushed; weather failed: ${weatherError instanceof Error ? weatherError.message : "unknown weather error"}`);
    }
    job.state = "completed";
    job.message = mode === "refresh"
      ? "2026 collection, compact export, weather, and GitHub push complete"
      : "Collection and compact export complete";
  } catch (e) {
    job.state = "failed"; job.error = e instanceof Error ? e.message : "Collection failed";
    job.message = "Collection stopped; saved CSVs are intact";
    logger.error({ message: job.error }, "CFBD collection failed");
  } finally {
    job.finishedAt = new Date().toISOString();
    try { await saveJob(); } finally { active = false; }
  }
}
