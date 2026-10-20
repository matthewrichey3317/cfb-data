import { logger } from "./logger";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let lastCall = 0;

export async function weatherRequest(url: URL, cfbd: boolean, progress: (message: string) => Promise<void>, counted: () => void | Promise<void>): Promise<unknown> {
  for (let attempt = 0; attempt < 5; attempt++) {
    await sleep(Math.max(0, 1500 - (Date.now() - lastCall)));
    lastCall = Date.now();
    await counted();
    const started = Date.now();
    const details = { provider: url.hostname, path: url.pathname, startDate: url.searchParams.get("start_date"), endDate: url.searchParams.get("end_date"), latitude: url.searchParams.get("latitude"), longitude: url.searchParams.get("longitude"), attempt: attempt + 1 };
    logger.info(details, "Weather request started");
    let response: Response;
    try {
      response = await fetch(url, { headers: cfbd ? { Authorization: `Bearer ${process.env.CFBD_API_KEY}` } : {},
        signal: AbortSignal.timeout(120000) });
    } catch {
      logger.warn({ ...details, elapsedMs: Date.now() - started }, "Weather request network error or timeout");
      if (attempt === 4) throw new Error(`Weather network error (${url.hostname}); saved raw files are intact`);
      await sleep(5000 * 2 ** attempt);
      continue;
    }
    logger.info({ ...details, status: response.status, elapsedMs: Date.now() - started }, "Weather request finished");
    if (response.status === 429 || response.status >= 500) {
      await response.body?.cancel();
      if (attempt === 4) throw new Error(`Weather provider HTTP ${response.status}; resume later to reuse cached venues`);
      const retry = response.headers.get("retry-after");
      const value = retry ? Number(retry) : NaN;
      const requested = retry && !Number.isFinite(value) ? Date.parse(retry) - Date.now() : value * 1000;
      const delay = Math.max(Number.isFinite(requested) ? requested : 0, 15000 * 2 ** attempt);
      if (delay > 300000) throw new Error("Weather provider requests a long quota cooldown; resume later");
      await progress(`Weather HTTP ${response.status}; retrying in ${Math.ceil(delay / 1000)} seconds`);
      await sleep(delay);
      continue;
    }
    if (!response.ok) {
      const detail = !cfbd ? (await response.json().catch(() => ({})) as { reason?: string }).reason : "";
      if (cfbd) await response.body?.cancel();
      throw new Error(`Weather provider HTTP ${response.status} (${url.hostname})${detail ? `: ${detail.slice(0, 200)}` : ""}; existing CSVs are intact`);
    }
    return response.json();
  }
  throw new Error("Weather retry limit reached");
}
