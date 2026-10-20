import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const result = await build({
  entryPoints: [path.join(root, "artifacts/api-server/src/lib/github-publish.ts")],
  bundle: true, write: false, platform: "node", format: "esm",
});
const publishing = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
if (process.argv.includes("--check")) {
  console.log("Security check passed:", await publishing.securityCheck(root));
} else if (process.argv.includes("--weather")) {
  console.log("Published weather:", await publishing.publishWeather(root));
} else {
  console.log("Published and verified:", await publishing.publishCurrentSeason(root));
}
