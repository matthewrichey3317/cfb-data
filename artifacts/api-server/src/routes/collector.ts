import { Router, type IRouter } from "express";
import { GetCollectorStatusResponse, StartHistoricalPullResponse, RefreshCurrentSeasonResponse, StartWeatherPullBody, StartWeatherPullResponse } from "@workspace/api-zod";
import { getStatus, startJob } from "../lib/collector";

const router: IRouter = Router();
router.get("/collector/status", async (_req, res): Promise<void> => {
  res.json(GetCollectorStatusResponse.parse(await getStatus()));
});
for (const [route, mode, schema] of [
  ["/collector/pull", "historical", StartHistoricalPullResponse],
  ["/collector/refresh", "refresh", RefreshCurrentSeasonResponse],
  ["/collector/weather", "weather", StartWeatherPullResponse],
] as const) {
  router.post(route, async (req, res): Promise<void> => {
    // Reject browser cross-origin commands to protect the API call budget.
    const origin = req.get("origin");
    if (origin && new URL(origin).host !== req.get("host") && new URL(origin).host !== req.get("x-forwarded-host")) {
      res.status(403).json({ error: "Cross-origin collection requests are not allowed" }); return;
    }
    if (mode === "weather") {
      const input = StartWeatherPullBody.safeParse(req.body);
      if (!input.success) { res.status(400).json({ error: "Invalid weather options" }); return; }
      try { res.status(202).json(schema.parse(await startJob(mode, input.data.refreshVenues))); }
      catch (e) { res.status(409).json({ error: e instanceof Error ? e.message : "Unable to start" }); }
      return;
    }
    try { res.status(202).json(schema.parse(await startJob(mode))); }
    catch (e) { res.status(409).json({ error: e instanceof Error ? e.message : "Unable to start" }); }
  });
}
export default router;
