import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const repository = "matthewrichey3317/cfb-data";
const repositoryUrl = `https://github.com/${repository}.git`;

async function command(root: string, program: string, args: string[], env = process.env) {
  try {
    return (await exec(program, args, {
      cwd: root, env, maxBuffer: 32 * 1024 * 1024, timeout: 180000,
    })).stdout;
  } catch {
    // Never include command stderr: credential helpers can expose sensitive values.
    throw new Error(`${program} ${args[0]} failed. Check GitHub access, token expiry, and repository synchronization.`);
  }
}

export function assertSafeContents(name: string, content: Buffer, secrets: string[]) {
  if (secrets.some(secret => secret && content.includes(Buffer.from(secret)))) {
    throw new Error(`Publication blocked: secret found in ${name}`);
  }
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|postgres(?:ql)?:\/\/[^:\s]+:[^@\s]+@/.test(content.toString("utf8"))) {
    throw new Error(`Publication blocked: possible credential found in ${name}`);
  }
}

export async function securityCheck(root: string) {
  const secrets = [process.env.CFBD_API_KEY, process.env.GH_TOKEN, process.env.SESSION_SECRET]
    .filter((value): value is string => Boolean(value));
  if (!process.env.CFBD_API_KEY || !process.env.GH_TOKEN) {
    throw new Error("CFBD_API_KEY and GH_TOKEN must be configured for the publication security check");
  }
  const names = (await command(root, "git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]))
    .split("\0").filter(Boolean);
  for (const name of new Set(names)) {
    if (/(^|\/)\.env(?:\.|$)|\.env(?:\.|$)|\.(?:pem|key)$/i.test(name)) {
      throw new Error(`Publication blocked: environment or credential file tracked: ${name}`);
    }
    try {
      assertSafeContents(name, await fs.readFile(path.join(root, name)), secrets);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const objects = (await command(root, "git", ["rev-list", "--objects", "--all"]))
    .trim().split("\n").filter(Boolean);
  const ids = objects.map(line => line.split(" ")[0]);
  let blobs = 0;
  for (const id of ids) {
    if ((await command(root, "git", ["cat-file", "-t", id])).trim() !== "blob") continue;
    const content = await command(root, "git", ["cat-file", "blob", id]);
    assertSafeContents("Git history", Buffer.from(content), secrets);
    blobs++;
  }
  return { files: new Set(names).size, historicalBlobs: blobs };
}

export async function publishCurrentSeason(root: string) {
  if (!process.env.GH_TOKEN) throw new Error("GH_TOKEN is not configured; raw data and compact exports are saved locally");
  const account = (await command(root, "gh", ["api", "user", "--jq", ".login"])).trim();
  if (account !== "matthewrichey3317") throw new Error("GitHub token belongs to the wrong account");
  const remote = (await command(root, "git", ["config", "--get", "remote.origin.url"])).trim();
  if (remote !== repositoryUrl) throw new Error("GitHub origin does not match the configured cfb-data repository");
  await securityCheck(root);
  const gitAuth = ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"];
  await command(root, "git", [...gitAuth, "fetch", "origin", "main"]);
  await command(root, "git", ["merge-base", "--is-ancestor", "origin/main", "HEAD"]);
  const files = [
    "data/games_2026.csv", "data/lines_2026.csv", "data/drives_2026.csv",
    "data/manifest.json", "export/index.json",
  ];
  const tracked = (await command(root, "git", ["ls-files", "-z", "export/games_compact_2026_part*.csv"])).split("\0").filter(Boolean);
  const existing = (await fs.readdir(path.join(root, "export")))
    .filter(name => /^games_compact_2026_part\d+\.csv$/.test(name)).map(name => `export/${name}`);
  files.push(...new Set([...tracked, ...existing]));
  // An isolated index ensures unrelated staged files cannot enter this commit.
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "cfb-publish-"));
  const env = { ...process.env, GIT_INDEX_FILE: path.join(temp, "index") };
  try {
    await command(root, "git", ["read-tree", "HEAD"], env);
    await command(root, "git", ["add", "-A", "--", ...files], env);
    const changed = (await command(root, "git", ["diff", "--cached", "--name-only"], env)).trim();
    if (changed) {
      await command(root, "git", ["commit", "-m", "Refresh 2026 college football data and compact exports"], env);
      await command(root, "git", ["reset", "HEAD", "--", ...files]);
    }
    await command(root, "git", [...gitAuth, "push", "origin", "HEAD:main"]);
    const local = (await command(root, "git", ["rev-parse", "HEAD"])).trim();
    const remoteHead = (await command(root, "gh", ["api", `repos/${repository}/git/ref/heads/main`, "--jq", ".object.sha"])).trim();
    if (local !== remoteHead) throw new Error("GitHub publication verification failed; local data is intact");
    return `https://github.com/${repository}`;
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}
