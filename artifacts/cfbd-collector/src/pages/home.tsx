import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useGetCollectorStatus,
  getGetCollectorStatusQueryKey,
  useStartHistoricalPull,
  useRefreshCurrentSeason,
  useStartWeatherPull,
} from '@workspace/api-client-react';
import type { CollectorJob, CollectorFile } from '@workspace/api-client-react';
import { AlertTriangle, Database, RefreshCw, KeyRound, CloudSun } from 'lucide-react';

function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
function fmtTime(s: string | null) {
  if (!s) return '—';
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
function errMsg(e: unknown) {
  if (!e) return null;
  if (e instanceof Error) return e.message;
  return String(e);
}

const stateStyle: Record<CollectorJob['state'], string> = {
  idle: 'bg-muted text-muted-foreground',
  running: 'bg-accent text-accent-foreground',
  completed: 'bg-primary text-primary-foreground',
  failed: 'bg-destructive text-destructive-foreground',
};

export default function Home() {
  const qc = useQueryClient();
  const status = useGetCollectorStatus({
    query: { queryKey: getGetCollectorStatusQueryKey(), refetchInterval: 2000 },
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: getGetCollectorStatusQueryKey() });
  const pull = useStartHistoricalPull({ mutation: { onSettled: invalidate } });
  const refresh = useRefreshCurrentSeason({ mutation: { onSettled: invalidate } });
  const weather = useStartWeatherPull({ mutation: { onSettled: invalidate } });
  const [refreshVenues, setRefreshVenues] = useState(false);

  const data = status.data;
  const files = useMemo<CollectorFile[]>(
    () => [...(data?.files ?? [])].sort((a, b) => b.season - a.season || a.type.localeCompare(b.type)),
    [data?.files],
  );
  const job = data?.job;
  const running = job?.state === 'running';
  const disabled = !data || running || !data.keyConfigured || pull.isPending || refresh.isPending || weather.isPending;
  const pct = job && job.totalFiles > 0 ? Math.round((job.completedFiles / job.totalFiles) * 100) : 0;
  const mutationError = errMsg(pull.error) ?? errMsg(refresh.error) ?? errMsg(weather.error);
  const totalRows = files.reduce((s, f) => s + f.rowCount, 0);

  return (
    <div className="min-h-[100dvh] bg-background">
      <div className="mx-auto max-w-5xl px-4 py-8 md:py-12">
        <header className="flex flex-col gap-4 border-b-2 border-foreground pb-5 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">Backend job / status</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">CFBD Data Collector</h1>
          </div>
          <div className="flex flex-wrap gap-2 md:justify-end">
            <button
              data-testid="button-historical-pull"
              disabled={disabled}
              onClick={() => pull.mutate()}
              className="inline-flex items-center gap-2 rounded-sm bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground transition-all duration-150 hover:-translate-y-px hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:translate-y-0"
            >
              <Database className="h-4 w-4" />
              {pull.isPending ? 'Starting…' : 'Full historical pull'}
            </button>
            <button
              data-testid="button-weather-pull"
              disabled={disabled}
              onClick={() => weather.mutate({ data: { refreshVenues } })}
              className="inline-flex items-center gap-2 rounded-sm border border-foreground/70 bg-card px-3.5 py-2 text-sm font-medium transition-colors hover:bg-accent/15 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <CloudSun className="h-4 w-4" />
              {weather.isPending ? 'Starting…' : 'Pull weather (all seasons)'}
            </button>
            <button
              data-testid="button-refresh-season"
              disabled={disabled}
              onClick={() => refresh.mutate()}
              className="inline-flex items-center gap-2 rounded-sm border border-foreground/70 bg-card px-3.5 py-2 text-sm font-medium transition-all duration-150 hover:-translate-y-px hover:border-accent hover:bg-accent/15 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:translate-y-0"
            >
              <RefreshCw className={`h-4 w-4 ${refresh.isPending ? 'animate-spin' : ''}`} />
              Refresh {data?.currentSeason ?? 2026}
            </button>
          </div>
        </header>
        <p className="mt-2 font-mono text-[11px] text-muted-foreground">
          Historical pull skips existing raw files. Refresh updates only {data?.currentSeason ?? 2026} raw files, compact exports, and weather, then pushes to GitHub. Weather pulls reuse historical caches; forecasts are refreshed and become archive data when available.
        </p>
        <label className="mt-2 flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
          <input type="checkbox" data-testid="checkbox-refresh-venues" checked={refreshVenues} disabled={disabled} onChange={event => setRefreshVenues(event.target.checked)} />
          Refresh venue list on next weather pull (otherwise reuse venues.csv)
        </label>

        {mutationError && (
          <div data-testid="text-mutation-error" className="mt-4 flex items-start gap-2 rounded-sm border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {mutationError}
          </div>
        )}
        {data && !data.keyConfigured && (
          <div data-testid="text-key-missing" className="mt-4 flex items-start gap-2 rounded-sm border border-accent bg-accent/15 px-3 py-2 text-sm">
            <KeyRound className="mt-0.5 h-4 w-4 shrink-0" /> CFBD API key is not configured. Actions are disabled until it is set.
          </div>
        )}

        {status.isLoading ? (
          <div className="mt-6 space-y-3">
            {[0, 1, 2, 3].map((i) => <div key={i} className="h-10 animate-pulse rounded-sm bg-muted" />)}
          </div>
        ) : status.isError && !data ? (
          <div className="mt-6 rounded-sm border border-destructive/40 bg-destructive/10 p-4 text-sm">
            <p className="font-medium text-destructive">Could not load collector status.</p>
            <p className="mt-1 font-mono text-xs text-muted-foreground">{errMsg(status.error)}</p>
            <button data-testid="button-retry" onClick={() => status.refetch()} className="mt-3 rounded-sm border border-foreground/60 px-3 py-1 text-sm transition-colors hover:bg-muted">Retry</button>
          </div>
        ) : data && job ? (
          <>
            <section className="mt-6 rounded-sm border border-card-border bg-card p-4" data-testid="section-job">
              <div className="flex flex-wrap items-center gap-3">
                <span data-testid="status-job" className={`rounded-sm px-2 py-0.5 font-mono text-xs uppercase tracking-wider ${stateStyle[job.state]}`}>{job.state}</span>
                {job.mode && <span className="font-mono text-xs text-muted-foreground">mode: {job.mode}</span>}
                <span data-testid="text-job-message" className="text-sm">{job.message}</span>
              </div>
              <div className="mt-4 h-2 overflow-hidden rounded-sm bg-muted">
                <div
                  className={`h-full origin-left transition-transform duration-500 ${job.state === 'failed' ? 'bg-destructive' : running ? 'bg-accent' : 'bg-primary'}`}
                  style={{ transform: `scaleX(${pct / 100})` }}
                />
              </div>
              <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 font-mono text-xs md:grid-cols-6">
                {[
                  ['Files', `${job.completedFiles}/${job.totalFiles}`],
                  ['Skipped', job.skippedFiles],
                  ['API calls', job.calls],
                  ['On disk', `${files.length} CSVs`],
                  ['Started', fmtTime(job.startedAt)],
                  ['Finished', fmtTime(job.finishedAt)],
                ].map(([k, v]) => (
                  <div key={k as string}>
                    <dt className="uppercase tracking-wider text-muted-foreground">{k}</dt>
                    <dd className="mt-0.5 text-foreground" data-testid={`text-job-${String(k).toLowerCase().replace(' ', '-')}`}>{v}</dd>
                  </div>
                ))}
              </dl>
              {job.error && (
                <pre data-testid="text-job-error" className="mt-4 whitespace-pre-wrap rounded-sm border-l-4 border-destructive bg-destructive/10 px-3 py-2 font-mono text-xs text-destructive">{job.error}</pre>
              )}
            </section>

            <section className="mt-6">
              <div className="mb-2 flex items-baseline justify-between">
                <h2 className="text-sm font-semibold uppercase tracking-wider">Manifest</h2>
                <span className="font-mono text-xs text-muted-foreground">{totalRows.toLocaleString()} rows</span>
              </div>
              {files.length === 0 ? (
                <div className="rounded-sm border border-dashed border-input px-4 py-10 text-center">
                  <p className="text-sm font-medium">No CSV files yet.</p>
                  <p className="mt-1 text-xs text-muted-foreground">Run a full historical pull to collect all {data.expectedFiles} files.</p>
                </div>
              ) : (
                <div className="overflow-x-auto rounded-sm border border-card-border bg-card">
                  <table className="w-full text-left font-mono text-xs">
                    <thead className="border-b border-border bg-secondary text-muted-foreground">
                      <tr>
                        {['Season', 'Type', 'Rows', 'Pulled', 'Size', 'Warnings'].map((h, i) => (
                          <th key={h} className={`px-3 py-2 font-medium uppercase tracking-wider ${i === 2 || i === 4 ? 'text-right' : ''}`}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {files.map((f) => (
                        <tr key={f.file} data-testid={`row-file-${f.file}`} title={f.file} className={`border-b border-border/60 transition-colors last:border-0 hover:bg-accent/10 ${f.season === data.currentSeason ? 'bg-primary/[0.04]' : ''}`}>
                          <td className="px-3 py-2 font-semibold">{f.type === 'venues' ? '—' : f.season}</td>
                          <td className="px-3 py-2">{f.type}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{f.rowCount.toLocaleString()}</td>
                          <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{fmtTime(f.pulledAt)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{fmtBytes(f.bytes)}</td>
                          <td className="px-3 py-2">
                            {f.warnings.length === 0 ? (
                              <span className="text-muted-foreground">—</span>
                            ) : (
                              <ul className="space-y-0.5 text-[hsl(30_70%_30%)]">
                                {f.warnings.map((w, i) => <li key={i} className="flex gap-1"><AlertTriangle className="mt-px h-3 w-3 shrink-0" />{w}</li>)}
                              </ul>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        ) : null}
      </div>
    </div>
  );
}
