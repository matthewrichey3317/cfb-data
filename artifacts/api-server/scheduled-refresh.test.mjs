import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { build } from "esbuild";

test("headless CLI refreshes/pushes latest 2026, fails non-zero, and preserves earlier commits", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "cfb-headless-test-"));
  const root = path.join(temp, "seed"), bare = path.join(temp, "remote.git");
  const bin = path.join(temp, "bin"), cli = path.join(temp, "refresh.mjs");
  const mock = path.join(temp, "mock.mjs"), calls = path.join(temp, "calls.json");
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const remote = (...args) => execFileSync("git", ["--git-dir", bare, ...args], { encoding: "utf8" }).trim();
  try {
    await fs.mkdir(root); await fs.mkdir(bin);
    await fs.mkdir(path.join(root, "data")); await fs.mkdir(path.join(root, "export"));
    const files = {
      ".gitignore": ".cache/\ndata/job.json\ndata/*.tmp\ndata/.*.part.json\nexport/*.tmp\nexport/.build.lock\n",
      "data/games_2026.csv": "id\n900\n",
      "data/lines_2026.csv": "id\n900\n",
      "data/drives_2026.csv": "id\n900\n",
      "data/weather_2026.csv": "game_id,source\n900,forecast\n",
      "data/venues.csv": "id,name,latitude,longitude,dome,grass\n1,Fixture,0,0,0,1\n",
      "data/games_2025.csv": "id\n2025\n",
      "data/weather_2025.csv": "game_id,source\n2025,archive\n",
      "data/manifest.json": JSON.stringify({ version: 1, files: [{ file: "games_2025.csv", type: "games", season: 2025, rowCount: 1 }] }),
      "export/games_compact_2025_part1.csv": "game_id\n2025\n",
      "export/games_compact_2026_part1.csv": "game_id\n900\n",
      "export/index.json": JSON.stringify({ files: [{ file: "games_compact_2025_part1.csv", season: 2025, part: 1, rowCount: 1 }] }),
    };
    for (const [name, text] of Object.entries(files)) await fs.writeFile(path.join(root, name), text);
    git("init", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
    git("add", "."); git("commit", "-m", "Baseline"); git("init", "--bare", bare);
    git("remote", "add", "fixture", bare); git("push", "fixture", "main");
    await fs.writeFile(path.join(bin, "gh"), `#!/bin/sh
if [ "$1" = "--version" ]; then echo "fixture gh"
elif [ "$2" = "user" ]; then echo "matthewrichey3317"
else git --git-dir="$TEST_REMOTE" rev-parse refs/heads/main
fi
`);
    await fs.chmod(path.join(bin, "gh"), 0o700);
    await fs.writeFile(mock, `
import fs from "node:fs";
const calls=[];
globalThis.fetch=async input=>{
  const u=new URL(input);calls.push(u.toString());fs.writeFileSync(process.env.TEST_CALLS,JSON.stringify(calls));
  if(u.hostname==="api.collegefootballdata.com"){
    if(process.env.TEST_FAILURE==="cfbd")return new Response("",{status:401});
    const data=u.searchParams.get("seasonType")==="postseason"?[]:
      u.pathname==="/games"?[{id:101,season:2026,week:1,seasonType:"regular",startDate:"2026-01-01T12:00:00Z",completed:true,neutralSite:false,conferenceGame:true,venueId:1,homeTeam:"Home",awayTeam:"Away",homeConference:"Fixture",awayConference:"Fixture",homePoints:7,awayPoints:0}]:
      u.pathname==="/lines"?[{id:101,lines:[{provider:"Fixture",overUnder:48,spread:-3}]}]:
      [{id:"drive-1",gameId:101,offense:"Home",defense:"Away",isHomeOffense:true,plays:5,yards:75,startOffenseScore:0,endOffenseScore:7,driveResult:"TD",scoring:true}];
    return Response.json(data);
  }
  if(process.env.TEST_FAILURE==="weather")return new Response("",{status:403});
  const time=[12,13,14,15].map(h=>"2026-01-01T"+h+":00");
  const vars=["temperature_2m","wind_speed_10m","wind_gusts_10m","wind_direction_10m","precipitation","rain","snowfall","relative_humidity_2m"];
  return Response.json({utc_offset_seconds:0,hourly_units:{snowfall:"cm"},hourly:{time,...Object.fromEntries(vars.map(v=>[v,[10,10,10,10]]))}});
};
`);
    await build({ entryPoints: ["src/refresh.ts"], outfile: cli, bundle: true, platform: "node", format: "esm",
      banner: { js: 'import {createRequire} from "node:module";globalThis.require=createRequire(import.meta.url);' } });
    const env = {
      ...process.env, NODE_ENV: "production", LOG_LEVEL: "error",
      CFBD_API_KEY: "fixture-cfbd-secret", GH_TOKEN: "fixture-github-secret",
      PATH: `${bin}:${process.env.PATH}`, TEST_REMOTE: bare, TEST_CALLS: calls,
      GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.file://${bare}.insteadOf`,
      GIT_CONFIG_VALUE_0: "https://github.com/matthewrichey3317/cfb-data.git",
    };
    const invoke = (failure = "", args = []) => spawnSync(process.execPath, ["--import", mock, cli, ...args],
      { env: { ...env, TEST_FAILURE: failure }, encoding: "utf8", timeout: 60000 });
    const initial = remote("rev-parse", "main");
    const check = invoke("", ["--check"]);
    assert.equal(check.status, 0, check.stderr); assert.match(check.stdout, /Preflight passed/);
    assert.equal(remote("rev-parse", "main"), initial);
    await assert.rejects(fs.access(calls));
    const success = invoke();
    assert.equal(success.status, 0, success.stderr); assert.match(success.stdout, /SUCCESS/);
    const requests = JSON.parse(await fs.readFile(calls, "utf8"));
    assert.equal(requests.filter(u => u.includes("api.collegefootballdata.com")).length, 6);
    assert.equal(requests.filter(u => u.includes("archive-api.open-meteo.com")).length, 1);
    assert.match(remote("show", "main:data/games_2026.csv"), /101/);
    assert.match(remote("show", "main:data/weather_2026.csv"), /archive/);
    assert.equal(remote("show", "main:data/games_2025.csv") + "\n", files["data/games_2025.csv"]);
    assert.equal(remote("show", "main:data/weather_2025.csv") + "\n", files["data/weather_2025.csv"]);
    assert.equal(remote("show", "main:export/games_compact_2025_part1.csv") + "\n", files["export/games_compact_2025_part1.csv"]);
    assert.equal(remote("ls-tree", "--name-only", "main", "data/job.json", ".cache"), "");
    const published = remote("rev-parse", "main");
    const failure = invoke("cfbd");
    assert.equal(failure.status, 1); assert.match(failure.stderr, /FAILED:.*401/);
    assert.equal(remote("rev-parse", "main"), published);
    const weatherFailure = invoke("weather");
    assert.equal(weatherFailure.status, 1); assert.match(weatherFailure.stderr, /weather failed/);
    assert.equal(remote("merge-base", "--is-ancestor", published, "main"), "");
    assert.match(remote("show", "main:data/weather_2026.csv"), /archive/);
    for (const result of [check, success, failure, weatherFailure]) {
      assert.ok(!`${result.stdout}${result.stderr}`.includes(env.CFBD_API_KEY));
      assert.ok(!`${result.stdout}${result.stderr}`.includes(env.GH_TOKEN));
    }
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
