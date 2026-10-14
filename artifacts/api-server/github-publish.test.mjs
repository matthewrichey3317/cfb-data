import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";

const compiled = await build({
  entryPoints: ["src/lib/github-publish.ts"],
  bundle: true, write: false, platform: "node", format: "esm",
});
const { assertSafeContents, publishCurrentSeason } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`
);

test("security check rejects exact secrets and credential patterns", () => {
  assert.throws(() => assertSafeContents("file", Buffer.from("a private-value b"), ["private-value"]), /secret found/);
  assert.throws(() => assertSafeContents("file", Buffer.from(["-----BEGIN", "PRIVATE KEY-----"].join(" ")), []), /credential found/);
  assert.doesNotThrow(() => assertSafeContents("file", Buffer.from("process.env.GH_TOKEN"), ["private-value"]));
});

test("publisher commits only current-season files, handles deletions and verifies push without API calls", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "cfb-publisher-test-"));
  const root = path.join(temp, "work");
  const bare = path.join(temp, "remote.git");
  const bin = path.join(temp, "bin");
  const previous = { ...process.env };
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const write = (name, text) => fs.writeFile(path.join(root, name), text);
  try {
    await fs.mkdir(root);
    await fs.mkdir(bin);
    await fs.mkdir(path.join(root, "data"));
    await fs.mkdir(path.join(root, "export"));
    git("init", "-b", "main");
    git("config", "user.name", "Publisher test");
    git("config", "user.email", "publisher@example.invalid");
    git("init", "--bare", bare);
    git("remote", "add", "origin", "https://github.com/matthewrichey3317/cfb-data.git");
    git("config", `url.${bare}.insteadOf`, "https://github.com/matthewrichey3317/cfb-data.git");
    const names = ["data/games_2026.csv", "data/lines_2026.csv", "data/drives_2026.csv", "data/manifest.json", "export/index.json", "export/games_compact_2026_part1.csv"];
    for (const name of [...names, "export/games_compact_2026_part2.csv", "data/games_2025.csv", "unrelated.txt"]) await write(name, "original\n");
    git("add", ".");
    git("commit", "-m", "Initial fixture");
    git("push", "origin", "main");
    const helper = path.join(bin, "gh");
    await fs.writeFile(helper, `#!/bin/sh
if [ "$2" = "user" ]; then printf 'matthewrichey3317\\n'
else git --git-dir="$FAKE_REMOTE" rev-parse refs/heads/main
fi
`);
    await fs.chmod(helper, 0o700);
    process.env.PATH = `${bin}:${previous.PATH}`;
    process.env.FAKE_REMOTE = bare;
    process.env.GH_TOKEN = "test-github-credential";
    process.env.CFBD_API_KEY = "test-cfbd-credential";
    for (const name of names) await write(name, "updated\n");
    await fs.unlink(path.join(root, "export/games_compact_2026_part2.csv"));
    await write("unrelated.txt", "must not be published\n");
    git("add", "unrelated.txt");
    assert.equal(await publishCurrentSeason(root), "https://github.com/matthewrichey3317/cfb-data");
    assert.equal(git("show", "HEAD:unrelated.txt"), "original");
    assert.equal(git("show", "HEAD:data/games_2025.csv"), "original");
    assert.equal(git("show", "HEAD:data/games_2026.csv"), "updated");
    assert.equal(git("ls-tree", "--name-only", "HEAD", "export/games_compact_2026_part2.csv"), "");
    assert.equal(git("diff", "--cached", "--name-only"), "unrelated.txt");
    assert.equal(git("rev-parse", "HEAD"), execFileSync("git", ["--git-dir", bare, "rev-parse", "main"], { encoding: "utf8" }).trim());
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    await fs.rm(temp, { recursive: true, force: true });
  }
});
