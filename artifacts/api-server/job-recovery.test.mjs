import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";

const result = await build({ entryPoints: ["src/lib/job-recovery.ts"], platform: "node", format: "esm", bundle: true, write: false });
const { recoverSavedJob } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
const idle = { state: "idle", mode: "", message: "Ready", completedFiles: 0, totalFiles: 0, calls: 0, skippedFiles: 0, startedAt: null, finishedAt: null, interruptedAt: null, error: null };

test("startup persists interruption time, last progress and counters; repeated recovery is idempotent", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cfb-recovery-"));
  try {
    const previous = { ...idle, state: "running", mode: "weather", message: "Weather 2020: venue 30/140 · Center Parc Stadium", calls: 807, completedFiles: 6, totalFiles: 13, startedAt: "2026-10-20T14:51:00Z" };
    await fs.writeFile(path.join(dir, "job.json"), JSON.stringify(previous));
    const now = new Date("2026-10-20T18:00:00Z");
    const recovered = await recoverSavedJob(dir, idle, now);
    assert.equal(recovered.state, "interrupted");
    assert.equal(recovered.interruptedAt, now.toISOString());
    assert.equal(recovered.calls, 807);
    assert.equal(recovered.completedFiles, 6);
    assert.match(recovered.message, /Center Parc Stadium/);
    assert.equal(recovered.finishedAt, null);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, "job.json"), "utf8")), recovered);
    assert.deepEqual(await recoverSavedJob(dir, idle, new Date("2026-10-21T18:00:00Z")), recovered);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("a fresh server stays idle and completed/failed jobs are not misclassified", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cfb-recovery-"));
  try {
    assert.deepEqual(await recoverSavedJob(dir, idle), idle);
    for (const state of ["completed", "failed"]) {
      const saved = { ...idle, state };
      await fs.writeFile(path.join(dir, "job.json"), JSON.stringify(saved));
      assert.deepEqual(await recoverSavedJob(dir, idle), saved);
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
