import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { build } from "esbuild";
import { createHash } from "node:crypto";

async function load(entry) {
  const result = await build({ entryPoints: [entry], bundle: true, write: false, platform: "node", format: "esm" });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}
const { recentScopes, mergeRecentRows, reusableCheckpointTime, wholeSeason } = await load("src/lib/recent-refresh.ts");
const { countScheduledCfbdCall } = await load("src/lib/cfbd-budget.ts");
const now = new Date("2026-10-27T12:00:00Z");
const games = [
  { id: 1, week: 6, seasonType: "regular", startDate: "2026-10-10T18:00:00Z" },
  { id: 2, week: 8, seasonType: "regular", startDate: "2026-10-24T18:00:00Z" },
  { id: 3, week: 9, seasonType: "regular", startDate: "2026-10-31T18:00:00Z" },
  { id: 4, week: 10, seasonType: "regular", startDate: "2026-11-07T18:00:00Z" },
];

test("recent week planning caps requests at two and catches up from an old baseline", () => {
  assert.deepEqual(recentScopes("lines", games, now.toISOString(), now), [
    { seasonType: "regular", week: 8 }, { seasonType: "regular", week: 9 },
  ]);
  assert.deepEqual(recentScopes("drives", games, now.toISOString(), now), [{ seasonType: "regular", week: 8 }]);
  assert.deepEqual(recentScopes("lines", games, "2026-10-01", now), wholeSeason);
  assert.deepEqual(recentScopes("lines", games, undefined, now), wholeSeason);
  assert.deepEqual(recentScopes("lines", [], now.toISOString(), now), []);
});

test("week merging preserves old weeks, replaces selected scopes, removes orphaned games", () => {
  const old = [{ gameId: 1, provider: "old" }, { gameId: 2, provider: "stale" }, { gameId: 999 }];
  const fresh = [{ gameId: 2, provider: "new" }];
  assert.deepEqual(mergeRecentRows(old, fresh, games, [{ seasonType: "regular", week: 8 }]), [old[0], fresh[0]]);
  assert.deepEqual(mergeRecentRows(old, [], games, [{ seasonType: "regular", week: 8 }]), [old[0]]);
});

test("a cached checkpoint from an unpublished refresh cannot suppress catch-up", () => {
  const checkpoint = { checkedAt: now.toISOString(), csvHash: createHash("sha256").update("new data").digest("hex") };
  assert.equal(reusableCheckpointTime(checkpoint, "new data"), now.toISOString());
  assert.equal(reusableCheckpointTime(checkpoint, "old published data"), undefined);
  assert.deepEqual(recentScopes("lines", games, reusableCheckpointTime(checkpoint, "old published data") ?? "2026-10-01", now), wholeSeason);
});

test("monthly budget counts before attempts, refuses at 900, and resets by UTC month", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cfbd-budget-test-"));
  try {
    await countScheduledCfbdCall(root, now);
    const file = path.join(root, ".cache/cfbd/usage.json");
    assert.equal(JSON.parse(await fs.readFile(file, "utf8"))["2026-10"], 1);
    await fs.writeFile(file, JSON.stringify({ "2026-10": 899 }));
    await countScheduledCfbdCall(root, now);
    await assert.rejects(countScheduledCfbdCall(root, now), /budget reached/);
    await countScheduledCfbdCall(root, new Date("2026-11-01T00:00:00Z"));
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { "2026-10": 900, "2026-11": 1 });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
