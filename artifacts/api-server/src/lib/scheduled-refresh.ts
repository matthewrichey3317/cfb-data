import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { refreshCurrentSeasonHeadless } from "./collector";
import { repository, verifyPublicationAccess } from "./github-publish";

const exec = promisify(execFile);
type Options = {
  actions?: boolean;
  checkOnly?: boolean;
  clone?: (destination: string) => Promise<void>;
  verify?: (root: string) => Promise<void>;
  refresh?: (root: string) => Promise<unknown>;
  log?: (message: string) => void;
};

async function cloneRepository(destination: string): Promise<void> {
  try {
    // Explicit deployment dependencies; never rely on the workspace's Git login.
    await exec("git", ["--version"]);
    await exec("gh", ["--version"]);
    await exec("git", ["clone", "--depth", "1", "--single-branch", "--branch", "main",
      `https://github.com/${repository}.git`, destination],
    { timeout: 180000, maxBuffer: 1024 * 1024 });
  } catch {
    // Child-process error strings can contain credential-helper output.
    throw new Error("GitHub checkout failed. Check network access and that git and gh are installed.");
  }
}

export async function runScheduledRefresh(options: Options = {}): Promise<void> {
  if (!process.env.CFBD_API_KEY || !process.env.GH_TOKEN) {
    throw new Error("CFBD_API_KEY and GH_TOKEN must be configured (Actions uses its built-in token as GH_TOKEN)");
  }
  const log = options.log ?? console.log;
  if (options.actions) {
    if (process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_REPOSITORY !== repository || !process.env.GITHUB_WORKSPACE) {
      throw new Error("--actions requires a GitHub Actions runner for the cfb-data repository");
    }
    const root = process.env.GITHUB_WORKSPACE;
    await (options.verify ?? verifyPublicationAccess)(root);
    for (const name of ["data/manifest.json", "data/venues.csv", "export/index.json"]) {
      await fs.access(path.join(root, name));
    }
    if (options.checkOnly) { log("Actions repository/token preflight passed; no data API calls made."); return; }
    await (options.refresh ?? refreshCurrentSeasonHeadless)(root);
    log(`SUCCESS: 2026 refresh verified on https://github.com/${repository}`);
    return;
  }
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "cfb-scheduled-"));
  const checkout = path.join(temp, "checkout");
  try {
    log("Checking out the latest main branch from GitHub; published files are the durable baseline.");
    await (options.clone ?? cloneRepository)(checkout);
    await (options.verify ?? verifyPublicationAccess)(checkout);
    for (const name of ["data/manifest.json", "data/venues.csv", "export/index.json"]) {
      await fs.access(path.join(checkout, name));
    }
    if (options.checkOnly) {
      log("Preflight passed: git/gh, deployment Secrets, GitHub identity, origin, and baseline files are available. No data API calls made.");
      return;
    }
    log("Refreshing 2026 games, lines, drives, compact exports, and weather; then committing and pushing.");
    await (options.refresh ?? refreshCurrentSeasonHeadless)(checkout);
    log(`SUCCESS: 2026 refresh saved and verified on https://github.com/${repository}`);
  } finally {
    await fs.rm(temp, { recursive: true, force: true }).catch(() => {
      log("Warning: temporary checkout cleanup failed; no published GitHub files were changed by cleanup.");
    });
  }
}
