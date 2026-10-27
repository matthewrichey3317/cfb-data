import type { Row } from "./collector-csv";
import { createHash } from "node:crypto";

export type Scope = { seasonType: string; week?: number };
export type EndpointCheckpoint = { checkedAt: string; csvHash: string };
export const wholeSeason: Scope[] = [{ seasonType: "regular" }, { seasonType: "postseason" }];
const day = 86400000;

export function reusableCheckpointTime(checkpoint: EndpointCheckpoint | undefined, csv: string): string | undefined {
  // A failed publish may cache a newer checkpoint than the durable GitHub CSV.
  // Never skip catch-up based on a snapshot that was not actually published.
  return checkpoint?.csvHash === createHash("sha256").update(csv).digest("hex")
    ? checkpoint.checkedAt : undefined;
}

// Prefer recent-week updates, but never spend more than the two calls needed
// for a whole endpoint. An old/missing checkpoint catches up in full.
export function recentScopes(kind: "lines" | "drives", games: Row[], checkedAt: string | undefined, now = new Date()): Scope[] {
  const previous = Date.parse(checkedAt ?? "");
  if (!Number.isFinite(previous)) return wholeSeason;
  const start = Math.min(now.getTime() - 8 * day, previous - 3 * day);
  const end = now.getTime() + (kind === "lines" ? 8 * day : day);
  const scopes = new Map<string, Scope>();
  for (const game of games) {
    const kickoff = Date.parse(String(game.startDate));
    if (!Number.isFinite(kickoff) || kickoff < start || kickoff > end) continue;
    const week = Number(game.week), seasonType = String(game.seasonType);
    if (!Number.isInteger(week) || week < 1 || !["regular", "postseason"].includes(seasonType)) return wholeSeason;
    scopes.set(`${seasonType}:${week}`, { seasonType, week });
  }
  return scopes.size > 2 ? wholeSeason : [...scopes.values()];
}

export function mergeRecentRows(existing: Row[], fresh: Row[], games: Row[], scopes: Scope[]): Row[] {
  const byId = new Map(games.map(game => [String(game.id), game]));
  const retained = existing.filter(row => {
    const game = byId.get(String(row.gameId ?? row.id));
    if (!game) return false;
    return !scopes.some(scope => scope.seasonType === game.seasonType &&
      (scope.week === undefined || scope.week === Number(game.week)));
  });
  return [...retained, ...fresh];
}
