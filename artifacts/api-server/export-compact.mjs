import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
if (args.length > 1 || (args.length && !/^(201[5-9]|202[0-6])$/.test(args[0]))) {
  throw new Error("Usage: pnpm --filter @workspace/api-server run export:compact [2015–2026]");
}
const { outputFiles } = await build({
  entryPoints: [path.join(root, "artifacts/api-server/src/lib/compact-export.ts")],
  platform: "node", format: "esm", bundle: true, write: false,
});
const { buildCompactExport } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`);
const seasons = args.length ? [Number(args[0])] : Array.from({ length: 12 }, (_, i) => 2015 + i);
const files = await buildCompactExport(path.join(root, "data"), path.join(root, "export"), seasons);
process.stdout.write(JSON.stringify({ files: files.length, rows: files.reduce((n, f) => n + f.rowCount, 0), largestPartBytes: Math.max(...files.map(f => f.bytes)), seasonsRebuilt: seasons }) + "\n");
