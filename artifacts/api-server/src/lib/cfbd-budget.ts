import { promises as fs } from "node:fs";
import path from "node:path";

// Called BEFORE every actual CFBD attempt, including retries. Actions caches
// this ledger even on failure. Leave 100 calls for manual/other API use.
export async function countScheduledCfbdCall(root: string, now = new Date()): Promise<void> {
  const file = path.join(root, ".cache/cfbd/usage.json");
  let usage: Record<string, number> = {};
  try { usage = JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) throw new Error("Invalid CFBD usage ledger; refusing unmetered API calls");
  const month = now.toISOString().slice(0, 7);
  const count = usage[month] ?? 0;
  if (!Number.isInteger(count) || count < 0) throw new Error("Invalid CFBD usage ledger; refusing unmetered API calls");
  if (count >= 900) throw new Error("Scheduled CFBD budget reached (900 attempts this UTC month). No request made; resume next month or review account quota.");
  usage[month] = count + 1;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(`${file}.tmp`, JSON.stringify(usage) + "\n");
  await fs.rename(`${file}.tmp`, file);
}
