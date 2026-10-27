import { fileURLToPath } from "node:url";
import path from "node:path";
import { runScheduledRefresh } from "./lib/scheduled-refresh";

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      console.error(`FAILED: refresh interrupted by ${signal}. Previously published GitHub commits remain intact.`);
      process.exit(signal === "SIGTERM" ? 143 : 130);
    });
  }
  runScheduledRefresh({ checkOnly: process.argv.includes("--check"), actions: process.argv.includes("--actions") }).catch(error => {
    console.error(`FAILED: ${error instanceof Error ? error.message : "Current-season refresh failed"}`);
    console.error("Previously published files remain on GitHub. The next run starts from the latest published snapshot.");
    process.exitCode = 1;
  });
}
