import { promises as fs } from "node:fs";
import path from "node:path";

export type CollectorJob = {
  state: "idle" | "running" | "completed" | "failed" | "interrupted";
  mode: string;
  message: string;
  completedFiles: number;
  totalFiles: number;
  calls: number;
  skippedFiles: number;
  startedAt: string | null;
  finishedAt: string | null;
  interruptedAt: string | null;
  error: string | null;
};

// Called once before the HTTP server accepts requests. No worker has started
// in this process yet, so a persisted "running" job belongs to an old process.
export async function recoverSavedJob(dataDir: string, fallback: CollectorJob, now = new Date()): Promise<CollectorJob> {
  const file = path.join(dataDir, "job.json");
  let saved: CollectorJob;
  try {
    saved = { ...fallback, ...JSON.parse(await fs.readFile(file, "utf8")) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...fallback };
    throw error;
  }
  if (saved.state !== "running") return saved;
  const detectedAt = now.toISOString();
  const recovered: CollectorJob = {
    ...saved, state: "interrupted", interruptedAt: detectedAt, finishedAt: null,
    message: `Interrupted; last progress: ${saved.message}`,
    error: `Previous process stopped before this job finished. Interruption detected at ${detectedAt}. Saved CSVs and venue caches are intact.`,
  };
  await fs.writeFile(`${file}.tmp`, JSON.stringify(recovered, null, 2) + "\n");
  await fs.rename(`${file}.tmp`, file);
  return recovered;
}
