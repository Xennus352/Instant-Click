'use client';

import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  AudioLines,
  Check,
  CheckCircle2,
  CircleDashed,
  Clock3,
  FileText,
  Fingerprint,
  LoaderCircle,
  LockKeyhole,
  Play,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Volume2,
} from 'lucide-react';
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { notify } from '@/components/notification-island';

const jobStageSchema = z.enum(['audio-extract', 'asr', 'understand', 'recap']);
const jobSchema = z.object({
  jobId: z.string(),
  stage: jobStageSchema,
  status: z.string(),
  progress: z.number().nullish(),
  attemptsMade: z.number().int().nonnegative(),
  createdAt: z.string(),
  processedOn: z.string().nullish(),
  finishedOn: z.string().nullish(),
  failureCode: z.string().nullish(),
}).passthrough();

const pipelineDataSchema = z.object({
  projectId: z.string(),
  projectStatus: z.string(),
  runId: z.string().nullish(),
  currentStage: jobStageSchema.nullish(),
  stages: z.array(jobSchema),
}).passthrough();

const assetSummarySchema = z.object({
  status: z.string().nullish(),
  scanStatus: z.string().nullish(),
  quarantinedAt: z.string().nullish(),
  verifiedAt: z.string().nullish(),
}).passthrough();

const projectSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  asset: assetSummarySchema.nullish(),
}).passthrough();

const projectListDataSchema = z.object({
  items: z.array(projectSummarySchema),
  nextCursor: z.string().nullable(),
}).passthrough();

const pipelineResultsSchema = z.object({
  projectId: z.string(),
  transcription: z.object({
    fullText: z.string(),
    language: z.string(),
    confidence: z.number().nullish(),
    modelVersion: z.string(),
    segments: z.array(z.unknown()),
  }).passthrough().nullish(),
  analysis: z.object({
    genre: z.array(z.string()),
    themes: z.array(z.string()),
    characters: z.array(z.unknown()),
    plotSummary: z.string(),
    keyScenes: z.array(z.unknown()),
    mood: z.string(),
    tone: z.string(),
    modelProvider: z.string(),
    modelVersion: z.string(),
  }).passthrough().nullish(),
  recapScript: z.object({
    content: z.string(),
    style: z.string(),
    targetLength: z.number(),
    language: z.string(),
    version: z.unknown().optional(),
    segments: z.array(z.unknown()),
  }).passthrough().nullish(),
}).passthrough();

type PipelineStage = z.infer<typeof jobStageSchema>;
type PipelineJob = z.infer<typeof jobSchema>;
type PipelineData = z.infer<typeof pipelineDataSchema>;
type PipelineResults = z.infer<typeof pipelineResultsSchema>;
type ProjectSummary = z.infer<typeof projectSummarySchema>;
type StageKey = 'queued' | 'audio_extraction' | 'transcription' | 'analysis' | 'recap';
type StageStatus = 'complete' | 'active' | 'queued' | 'not_started' | 'failed' | 'blocked' | 'paused';

const stageDefinitions: Array<{ key: StageKey; label: string; description: string }> = [
  { key: 'queued', label: 'Queued', description: 'Your project is waiting for a processing slot.' },
  { key: 'audio_extraction', label: 'Audio extraction', description: 'Status reported by the project processing service.' },
  { key: 'transcription', label: 'Transcription', description: 'Transcript text is displayed only after the service saves it.' },
  { key: 'analysis', label: 'Understanding stage', description: 'Status only; no analysis content is created by this screen.' },
  { key: 'recap', label: 'Recap stage', description: 'Script text is displayed only after the service saves it.' },
];

class ApiError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getErrorDetails(payload: unknown): { message?: string; code?: string } {
  if (!isRecord(payload) || !isRecord(payload.error)) return {};
  return {
    message: typeof payload.error.message === 'string' ? payload.error.message : undefined,
    code: typeof payload.error.code === 'string' ? payload.error.code : undefined,
  };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ApiError('The server returned an unreadable response.', response.status);
  }
}

async function fetchPipeline(projectId: string, signal: AbortSignal): Promise<PipelineData> {
  const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/pipeline`, {
    credentials: 'include',
    headers: { Accept: 'application/json' },
    signal,
  });
  const payload = await readJson(response);
  if (!response.ok) {
    const error = getErrorDetails(payload);
    throw new ApiError(error.message || `The request failed (${response.status}).`, response.status, error.code);
  }

  const data = isRecord(payload) ? payload.data : undefined;
  const parsed = pipelineDataSchema.safeParse(data);
  if (!parsed.success) throw new ApiError('The pipeline response did not match the expected contract.');
  return parsed.data;
}

async function fetchPipelineResults(projectId: string, signal: AbortSignal): Promise<PipelineResults> {
  const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/pipeline/results`, {
    credentials: 'include',
    headers: { Accept: 'application/json' },
    signal,
  });
  const payload = await readJson(response);
  if (!response.ok) {
    const error = getErrorDetails(payload);
    throw new ApiError(error.message || `The request failed (${response.status}).`, response.status, error.code);
  }
  const data = isRecord(payload) ? payload.data : undefined;
  const parsed = pipelineResultsSchema.safeParse(data);
  if (!parsed.success) throw new ApiError('The results response did not match the expected contract.');
  return parsed.data;
}

function resultsErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 404) {
    return 'The processing results endpoint is not available on this server yet. Project status is still available.';
  }
  return error instanceof ApiError
    ? error.message
    : 'Processing outputs could not be loaded. Try again in a moment.';
}

async function fetchProjectSummary(projectId: string, signal: AbortSignal): Promise<ProjectSummary | null> {
  let cursor: string | undefined;
  do {
    const query = new URLSearchParams({ limit: '100' });
    if (cursor) query.set('cursor', cursor);
    const response = await fetch(`/api/v1/projects?${query.toString()}`, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
      signal,
    });
    const payload = await readJson(response);
    if (!response.ok) {
      const error = getErrorDetails(payload);
      throw new ApiError(error.message || `The request failed (${response.status}).`, response.status, error.code);
    }
    const data = isRecord(payload) ? payload.data : undefined;
    const parsed = projectListDataSchema.safeParse(data);
    if (!parsed.success) throw new ApiError('The project list response did not match the expected contract.');
    const match = parsed.data.items.find((item) => item.id === projectId);
    if (match) return match;
    cursor = parsed.data.nextCursor ?? undefined;
  } while (cursor);
  return null;
}

async function requestProcessing(projectId: string, retry: boolean): Promise<void> {
  const endpoint = retry
    ? `/api/v1/projects/${encodeURIComponent(projectId)}/pipeline/retry`
    : `/api/v1/projects/${encodeURIComponent(projectId)}/pipeline`;
  const response = await fetch(endpoint, {
    method: 'POST',
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      'Idempotency-Key': crypto.randomUUID(),
      ...(retry ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(retry ? { body: '{}' } : {}),
  });
  if (response.ok) return;
  const payload = await readJson(response);
  const error = getErrorDetails(payload);
  throw new ApiError(error.message || `Processing could not be started (${response.status}).`, response.status, error.code);
}

function apiErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return 'We could not load this project’s processing status. Check your connection and try again.';
  if (error.status === 401) return 'Your session has expired. Sign in again to view this project.';
  if (error.status === 403) return 'You do not have access to this project.';
  if (error.status === 404) return 'This project could not be found.';
  return error.message;
}

function canonicalStatus(status?: string): string {
  return (status ?? '').trim().toLowerCase().replace(/[ -]+/g, '_');
}

function pipelineJobForStage(data: PipelineData, key: StageKey): PipelineJob | undefined {
  const jobStage: Partial<Record<StageKey, PipelineStage>> = {
    audio_extraction: 'audio-extract',
    transcription: 'asr',
    analysis: 'understand',
    recap: 'recap',
  };
  const target = jobStage[key];
  return target ? data.stages.find((stage) => stage.stage === target) : undefined;
}

function stageStatusFor(data: PipelineData, key: StageKey): StageStatus {
  if (key === 'queued') {
    if (!data.runId) return 'not_started';
    const first = data.stages.find((stage) => stage.stage === 'audio-extract');
    const status = canonicalStatus(first?.status);
    if (['waiting', 'delayed', 'queued', 'pending'].includes(status)) return 'queued';
    if (['active', 'completed', 'complete', 'succeeded', 'success', 'failed'].includes(status)) return 'complete';
    return 'queued';
  }

  const job = pipelineJobForStage(data, key);
  const status = canonicalStatus(job?.status);
  if (['completed', 'complete', 'succeeded', 'success', 'done'].includes(status)) return 'complete';
  if (['running', 'active', 'processing', 'in_progress'].includes(status)) return 'active';
  if (['failed', 'error'].includes(status)) return 'failed';
  if (['blocked', 'quarantined', 'scan_blocked'].includes(status)) return 'blocked';
  if (status === 'paused') return 'paused';
  if (['queued', 'pending', 'waiting', 'delayed'].includes(status)) return 'queued';
  return data.runId ? 'queued' : 'not_started';
}

function inferredCurrentStage(data: PipelineData): StageKey | null {
  const stageMap: Record<PipelineStage, StageKey> = {
    'audio-extract': 'audio_extraction',
    asr: 'transcription',
    understand: 'analysis',
    recap: 'recap',
  };
  if (data.currentStage) return stageMap[data.currentStage];
  const active = data.stages.find((stage) => ['active', 'running', 'processing'].includes(canonicalStatus(stage.status)));
  if (active) return stageMap[active.stage];
  const waiting = data.stages.find((stage) => ['waiting', 'delayed'].includes(canonicalStatus(stage.status)));
  return waiting ? stageMap[waiting.stage] : null;
}

function scanBlockReason(project?: ProjectSummary | null): 'waiting' | 'blocked' | null {
  if (project && !project.asset) return 'waiting';
  const assetStatus = canonicalStatus(project?.asset?.status ?? undefined);
  const scanStatus = canonicalStatus(project?.asset?.scanStatus ?? undefined);
  if (['infected', 'error', 'rejected', 'failed', 'not_configured', 'unknown'].includes(scanStatus)) return 'blocked';
  if (scanStatus === 'pending' || ['quarantined', 'pending_upload', 'uploading', 'verifying'].includes(assetStatus)) return 'waiting';
  if (project?.asset && (assetStatus !== 'ready' || scanStatus !== 'clean' || !project.asset.verifiedAt)) return 'waiting';
  return null;
}

function isTerminal(data: PipelineData): boolean {
  const projectStatus = canonicalStatus(data.projectStatus);
  return ['completed', 'complete', 'failed', 'cancelled', 'canceled'].includes(projectStatus);
}

function overallProgress(data: PipelineData): number | null {
  if (!data.runId || data.stages.length === 0) return null;
  const stageOrder: PipelineStage[] = ['audio-extract', 'asr', 'understand', 'recap'];
  const total = stageOrder.reduce((sum, stageName) => {
    const stage = data.stages.find((entry) => entry.stage === stageName);
    if (!stage) return sum;
    if (canonicalStatus(stage.status) === 'completed') return sum + 100;
    const reported = typeof stage.progress === 'number' ? Math.max(0, Math.min(100, stage.progress)) : 0;
    return sum + reported;
  }, 0);
  return Math.round(total / stageOrder.length);
}

function stageIcon(status: StageStatus, key: StageKey) {
  if (status === 'complete') return <Check aria-hidden="true" size={15} />;
  if (status === 'active') return <LoaderCircle aria-hidden="true" size={16} className="animate-spin" />;
  if (status === 'failed') return <AlertCircle aria-hidden="true" size={16} />;
  if (status === 'blocked') return <LockKeyhole aria-hidden="true" size={15} />;
  if (key === 'audio_extraction') return <AudioLines aria-hidden="true" size={16} />;
  if (key === 'transcription') return <Volume2 aria-hidden="true" size={16} />;
  if (key === 'analysis') return <Fingerprint aria-hidden="true" size={16} />;
  if (key === 'recap') return <Sparkles aria-hidden="true" size={16} />;
  return <CircleDashed aria-hidden="true" size={16} />;
}

function formatUpdatedAt(value?: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
}

export function ProjectProcessingScreen({ projectId }: { projectId: string }) {
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: {
      queries: { staleTime: 2_000, refetchOnWindowFocus: true },
      mutations: { retry: false },
    },
  }));

  return (
    <QueryClientProvider client={queryClient}>
      <ProcessingContent projectId={projectId} />
    </QueryClientProvider>
  );
}

function ProcessingContent({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const pipelineQuery = useQuery({
    queryKey: ['project-pipeline', projectId],
    queryFn: ({ signal }) => fetchPipeline(projectId, signal),
    refetchInterval: (query) => {
      const current = query.state.data;
      if (!current || !current.runId || isTerminal(current)) return false;
      return 4_000;
    },
    refetchIntervalInBackground: false,
    retry: (failureCount, error) => !(error instanceof ApiError && [401, 403, 404].includes(error.status ?? 0)) && failureCount < 2,
  });
  const projectQuery = useQuery({
    queryKey: ['project-summary', projectId],
    queryFn: ({ signal }) => fetchProjectSummary(projectId, signal),
    refetchInterval: (query) => scanBlockReason(query.state.data) === 'waiting' ? 10_000 : false,
    refetchIntervalInBackground: false,
    retry: (failureCount, error) => !(error instanceof ApiError && [401, 403, 404].includes(error.status ?? 0)) && failureCount < 2,
  });
  const resultsQuery = useQuery({
    queryKey: [
      'project-pipeline-results',
      projectId,
      pipelineQuery.data?.runId ?? null,
      pipelineQuery.data?.stages
        .filter((stage) => canonicalStatus(stage.status) === 'completed')
        .map((stage) => stage.stage)
        .join(',') ?? '',
    ],
    queryFn: ({ signal }) => fetchPipelineResults(projectId, signal),
    enabled: Boolean(pipelineQuery.data),
    refetchInterval: (query) => {
      if (query.state.error instanceof ApiError && query.state.error.status === 404) return false;
      const current = pipelineQuery.data;
      return current?.runId && !isTerminal(current) ? 8_000 : false;
    },
    refetchIntervalInBackground: false,
    retry: (failureCount, error) => !(error instanceof ApiError && [401, 403, 404].includes(error.status ?? 0)) && failureCount < 1,
  });
  const processMutation = useMutation({
    mutationFn: ({ retry }: { retry: boolean }) => requestProcessing(projectId, retry),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['project-pipeline', projectId] }),
        queryClient.invalidateQueries({ queryKey: ['project-summary', projectId] }),
        queryClient.invalidateQueries({ queryKey: ['project-pipeline-results', projectId] }),
      ]);
    },
  });

  useEffect(() => {
    const error = processMutation.error ?? pipelineQuery.error ?? projectQuery.error ?? resultsQuery.error;
    if (error) notify({ tone: 'error', title: 'Project status needs attention', message: error instanceof Error ? error.message : 'The project request failed.', durationMs: 8000 });
  }, [processMutation.error, pipelineQuery.error, projectQuery.error, resultsQuery.error]);

  useEffect(() => {
    if (processMutation.status === 'success') notify({ tone: 'success', title: 'Processing request accepted', message: 'The page will show the server-reported stage and status.' });
  }, [processMutation.status]);

  const data = pipelineQuery.data;
  const summary = projectQuery.data;
  const assetNotReady = processMutation.error instanceof ApiError && processMutation.error.code === 'ASSET_NOT_READY';
  const scanReason = scanBlockReason(summary) ?? (assetNotReady ? 'waiting' : null);
  const assetReady = canonicalStatus(summary?.asset?.status ?? undefined) === 'ready'
    && canonicalStatus(summary?.asset?.scanStatus ?? undefined) === 'clean'
    && Boolean(summary?.asset?.verifiedAt);
  const currentStage = data ? inferredCurrentStage(data) : null;
  const activeStage = data && currentStage ? pipelineJobForStage(data, currentStage) : undefined;
  const terminalFailure = canonicalStatus(data?.projectStatus) === 'failed';
  const failedStage = data?.stages.find((stage) => canonicalStatus(stage.status) === 'failed');
  const canRetry = terminalFailure && Boolean(failedStage) && assetReady;
  const canStart = Boolean(data && !data.runId && canonicalStatus(data.projectStatus) === 'uploaded' && assetReady);
  const isProcessing = Boolean(data?.runId && !isTerminal(data));
  const progressValue = data ? overallProgress(data) : null;
  const transcript = resultsQuery.data?.transcription?.fullText ?? null;
  const analysisSummary = resultsQuery.data?.analysis?.plotSummary ?? null;
  const recap = resultsQuery.data?.recapScript?.content ?? null;
  const updatedLabel = formatUpdatedAt(activeStage?.finishedOn ?? activeStage?.processedOn ?? activeStage?.createdAt);
  const failureMessage = failedStage?.failureCode
    ? `${failedStage.stage} ended with ${failedStage.failureCode}. Your uploaded source is preserved.`
    : 'The processing service reported a failure. Your project data is preserved.';

  useEffect(() => {
    if (terminalFailure) {
      notify({ id: `pipeline-failed:${projectId}:${failedStage?.jobId ?? failedStage?.failureCode ?? 'unknown'}`, tone: 'error', title: 'Processing stopped', message: failureMessage, durationMs: 8000 });
    }
  }, [failedStage?.failureCode, failedStage?.jobId, failureMessage, projectId, terminalFailure]);

  useEffect(() => {
    if (scanReason) {
      notify({ id: `asset-hold:${projectId}:${scanReason}`, tone: 'warning', title: 'Processing is on hold', message: 'The backend has not confirmed that this source is ready. Start and retry remain unavailable.' });
    }
  }, [projectId, scanReason]);

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border/80 bg-card/85 backdrop-blur-xl">
        <div className="mx-auto flex h-[68px] max-w-7xl items-center justify-between gap-4 px-5 sm:px-8">
          <Link href="/app" className="inline-flex items-center gap-2.5 rounded-md font-semibold tracking-[-0.04em] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-primary text-primary-foreground"><Sparkles aria-hidden="true" size={16} /></span>
            instantcap
          </Link>
          <Link href="/app/projects" className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
            <ArrowLeft aria-hidden="true" size={15} /> Projects
          </Link>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-5 pb-16 pt-8 sm:px-8 sm:pt-12">
        <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="mb-3 inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.15em] text-primary">
              <span className="h-1.5 w-1.5 rounded-full bg-primary" /> Project studio
            </p>
            <h1 className="text-3xl font-semibold tracking-[-0.055em] sm:text-4xl">Processing status</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">Track processing states reported by the backend. This screen shows only saved project outputs.</p>
          </div>
          {data && (
            <div className="rounded-xl border border-border bg-card px-4 py-3 sm:min-w-52">
              <p className="truncate text-sm font-semibold">{summary?.title || 'Movie project'}</p>
              <p className="mt-1 text-[11px] text-muted-foreground">{data.projectStatus.replace(/_/g, ' ').toLowerCase()} · {projectId.slice(0, 8)}</p>
            </div>
          )}
        </div>

        {pipelineQuery.isPending ? (
          <LoadingState />
        ) : pipelineQuery.isError && !data ? (
          <FetchErrorState message={apiErrorMessage(pipelineQuery.error)} onRetry={() => void pipelineQuery.refetch()} isRetrying={pipelineQuery.isFetching} />
        ) : data ? (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1.65fr)_minmax(300px,0.85fr)]">
            <section aria-labelledby="pipeline-heading" className="rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-7">
              <div className="flex flex-col gap-3 border-b border-border pb-5 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h2 id="pipeline-heading" className="text-lg font-semibold tracking-[-0.025em]">Project pipeline</h2>
                  <p className="mt-1 text-sm text-muted-foreground">Stages update from the project processing service.</p>
                </div>
                <div className="inline-flex items-center gap-2 self-start rounded-full bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground">
                  {pipelineQuery.isFetching ? <LoaderCircle aria-hidden="true" size={13} className="animate-spin" /> : <Clock3 aria-hidden="true" size={13} />}
                  {updatedLabel ? `Updated ${updatedLabel}` : pipelineQuery.isFetching ? 'Refreshing status' : 'Waiting for status'}
                </div>
              </div>

              {pipelineQuery.isError && (
                <div role="alert" className="mt-4 flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm">
                  <AlertCircle aria-hidden="true" size={17} className="mt-0.5 shrink-0 text-destructive" />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">Could not refresh the latest status.</p>
                    <p className="mt-1 text-muted-foreground">Showing the last status received from the server.</p>
                  </div>
                  <button type="button" onClick={() => void pipelineQuery.refetch()} className="shrink-0 rounded-lg px-2 py-1 text-xs font-semibold text-primary underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">Retry</button>
                </div>
              )}

              {projectQuery.isError && (
                <div role="alert" className="mt-4 flex items-start justify-between gap-3 rounded-xl border border-amber-600/25 bg-amber-500/5 p-4 text-sm">
                  <p className="text-muted-foreground">Source readiness could not be verified. Start and retry controls stay unavailable until the server confirms the asset is ready.</p>
                  <button type="button" onClick={() => void projectQuery.refetch()} className="shrink-0 rounded-lg px-2 py-1 text-xs font-semibold text-primary underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">Retry</button>
                </div>
              )}

              {!projectQuery.isPending && projectQuery.data === null && !projectQuery.isError && (
                <div role="status" className="mt-4 rounded-xl border border-amber-600/25 bg-amber-500/5 p-4 text-sm text-muted-foreground">
                  Project details were not found in your project list, so source readiness cannot be verified.
                </div>
              )}

              {scanReason && <ScanBlockedNotice reason={scanReason} status={summary?.asset?.scanStatus ?? summary?.asset?.status ?? (assetNotReady ? 'ASSET_NOT_READY' : undefined)} />}

              {data.runId && progressValue !== null && (
                <div className="mt-5 rounded-xl border border-border bg-muted/25 p-4">
                  <div className="mb-2 flex items-center justify-between gap-3 text-xs">
                    <span className="font-medium text-muted-foreground">Overall progress</span>
                    <span className="font-semibold tabular-nums text-foreground">{progressValue}%</span>
                  </div>
                  <div role="progressbar" aria-label="Overall pipeline progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressValue} className="h-2 overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-primary transition-[width] duration-300" style={{ width: `${progressValue}%` }} />
                  </div>
                  <p className="mt-2 text-[10px] text-muted-foreground">Calculated from server-reported progress across four stages.</p>
                </div>
              )}

              {terminalFailure && (
                <div role="alert" className="mt-5 flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4 sm:p-5">
                  <AlertCircle aria-hidden="true" size={19} className="mt-0.5 shrink-0 text-destructive" />
                  <div className="min-w-0 flex-1">
                    <h3 className="text-sm font-semibold">Processing stopped</h3>
                    <p className="mt-1 text-sm leading-6 text-muted-foreground">{failureMessage || 'The processing service reported a failure. Your project data is preserved.'}</p>
                    {failedStage?.failureCode && <p className="mt-2 font-mono text-[11px] text-muted-foreground">{failedStage.failureCode}</p>}
                  </div>
                </div>
              )}

              {['completed', 'complete'].includes(canonicalStatus(data.projectStatus)) && (
                <div role="status" className="mt-5 flex items-start gap-3 rounded-xl border border-green-600/20 bg-green-600/5 p-4 text-sm text-green-800 dark:text-green-300">
                  <CheckCircle2 aria-hidden="true" size={18} className="mt-0.5 shrink-0" />
                  <div>
                    <p className="font-semibold">Processing complete</p>
                    <p className="mt-1 text-green-800/75 dark:text-green-200/75">
                      {recap ? 'Your recap is ready for review.' : 'The server reports completion; recap output is not available yet.'}
                    </p>
                  </div>
                </div>
              )}

              <ol className="mt-6 space-y-0" aria-label="Project processing stages">
                {stageDefinitions.map((stage, index) => {
                  const status = stageStatusFor(data, stage.key);
                  const job = stage.key === 'queued' ? undefined : pipelineJobForStage(data, stage.key);
                  const progress = job?.progress;
                  const displayProgress = typeof progress === 'number' ? Math.max(0, Math.min(100, progress)) : null;
                  const isLast = index === stageDefinitions.length - 1;
                  const isCurrent = stage.key === currentStage;
                  const detail = job?.failureCode
                    ? `Failure code: ${job.failureCode}`
                    : status === 'active' && job?.attemptsMade !== undefined
                      ? `Attempt ${job.attemptsMade + 1}`
                      : null;
                  return (
                    <li key={stage.key} className="relative grid grid-cols-[40px_minmax(0,1fr)] gap-3 sm:grid-cols-[48px_minmax(0,1fr)] sm:gap-4">
                      {!isLast && <span aria-hidden="true" className={`absolute bottom-0 left-[19px] top-10 w-px sm:left-[23px] ${status === 'complete' ? 'bg-primary/35' : 'bg-border'}`} />}
                      <span className={`relative z-10 grid h-10 w-10 place-items-center rounded-full border sm:h-12 sm:w-12 ${status === 'complete' ? 'border-primary bg-primary text-primary-foreground' : status === 'active' ? 'border-primary/40 bg-primary/10 text-primary ring-4 ring-primary/5' : status === 'failed' ? 'border-destructive/30 bg-destructive/10 text-destructive' : status === 'blocked' ? 'border-amber-600/30 bg-amber-500/10 text-amber-700 dark:text-amber-300' : 'border-border bg-background text-muted-foreground'}`}>
                        {stageIcon(status, stage.key)}
                      </span>
                      <div className={`mb-5 min-w-0 rounded-xl border p-4 sm:p-5 ${isCurrent || status === 'failed' || status === 'blocked' ? 'border-primary/20 bg-primary/[0.035]' : 'border-transparent bg-muted/35'}`}>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <h3 className={`text-sm font-semibold ${status === 'queued' || status === 'not_started' ? 'text-muted-foreground' : ''}`} aria-current={isCurrent ? 'step' : undefined}>{stage.label}</h3>
                          <StageBadge status={status} />
                        </div>
                        <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{detail || stage.description}</p>
                        {status === 'active' && displayProgress !== null && (
                          <div className="mt-4">
                            <div className="mb-1.5 flex justify-between text-[11px] text-muted-foreground">
                              <span>Server-reported stage progress</span><span className="font-medium tabular-nums">{Math.round(displayProgress)}%</span>
                            </div>
                            <div role="progressbar" aria-label={`${stage.label} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(displayProgress)} className="h-2 overflow-hidden rounded-full bg-muted">
                              <div className="h-full rounded-full bg-primary transition-[width] duration-300" style={{ width: `${displayProgress}%` }} />
                            </div>
                          </div>
                        )}
                        {status === 'active' && displayProgress === null && (
                          <p role="status" className="mt-3 inline-flex items-center gap-2 text-[11px] text-muted-foreground"><LoaderCircle aria-hidden="true" size={13} className="animate-spin text-primary" />This stage is active; detailed progress is not available.</p>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>

              {processMutation.isError && !assetNotReady && (
                <div role="alert" className="mt-1 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
                  {apiErrorMessage(processMutation.error)}
                </div>
              )}

              {(canStart || canRetry) && (
                <div className="mt-4 flex flex-col gap-3 border-t border-border pt-5 sm:flex-row sm:items-center sm:justify-between">
                  <p className="max-w-md text-xs leading-5 text-muted-foreground">
                    {canRetry ? 'Retry the failed stage. The server will confirm the source is still eligible.' : 'Start the processing pipeline when you are ready.'}
                  </p>
                  <button
                    type="button"
                    onClick={() => processMutation.mutate({ retry: canRetry })}
                    disabled={processMutation.isPending || Boolean(scanReason)}
                    className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-primary px-5 text-sm font-semibold text-primary-foreground shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-ring"
                  >
                    {processMutation.isPending ? <LoaderCircle aria-hidden="true" size={16} className="animate-spin" /> : canRetry ? <RefreshCw aria-hidden="true" size={15} /> : <Play aria-hidden="true" size={15} />}
                    {processMutation.isPending ? 'Starting…' : canRetry ? 'Retry processing' : 'Start processing'}
                    {!processMutation.isPending && <ArrowRight aria-hidden="true" size={15} />}
                  </button>
                </div>
              )}

              {isProcessing && !currentStage && !scanReason && (
                <p role="status" className="mt-5 rounded-xl border border-border bg-muted/40 p-4 text-sm text-muted-foreground">
                  Processing is active, but the service has not reported a current stage yet. This panel will refresh automatically.
                </p>
              )}
            </section>

            <aside className="space-y-5">
              {resultsQuery.isError && (
                <div role="alert" className="rounded-xl border border-amber-600/25 bg-amber-500/5 p-4 text-xs leading-5 text-muted-foreground">
                  {resultsErrorMessage(resultsQuery.error)}
                </div>
              )}
              <ContentPreviewCard
                title="Transcript"
                icon={<Volume2 aria-hidden="true" size={16} />}
                content={transcript}
                isLoading={resultsQuery.isPending}
                absentMessage="No transcript output is saved for this project."
              />
              <ContentPreviewCard
                title="Analysis summary"
                icon={<Fingerprint aria-hidden="true" size={16} />}
                content={analysisSummary}
                isLoading={resultsQuery.isPending}
                absentMessage="No analysis output is saved for this project."
              />
              <ContentPreviewCard
                title="Recap draft"
                icon={<FileText aria-hidden="true" size={16} />}
                content={recap}
                isLoading={resultsQuery.isPending}
                absentMessage="No recap script is saved for this project."
              />
              <div className="rounded-2xl border border-border bg-card p-5">
                <div className="flex items-center gap-3">
                  <span className="grid h-9 w-9 place-items-center rounded-xl bg-muted text-muted-foreground"><ShieldAlert aria-hidden="true" size={17} /></span>
                  <div><h2 className="text-sm font-semibold">Source readiness</h2><p className="mt-0.5 text-xs text-muted-foreground">Safety and readiness status are displayed only when reported by the backend.</p></div>
                </div>
                <p className="mt-4 text-xs leading-5 text-muted-foreground">A project stays on hold until the server reports it is safe and ready for processing.</p>
              </div>
            </aside>
          </div>
        ) : null}
      </div>
    </main>
  );
}

function LoadingState() {
  return (
    <div className="grid animate-pulse gap-6 lg:grid-cols-[minmax(0,1.65fr)_minmax(300px,0.85fr)]" role="status" aria-label="Loading project processing status">
      <div className="rounded-2xl border border-border bg-card p-6">
        <div className="h-5 w-48 rounded bg-muted" />
        <div className="mt-7 space-y-4">{stageDefinitions.map((stage) => <div key={stage.key} className="h-[76px] rounded-xl bg-muted/70" />)}</div>
      </div>
      <div className="space-y-5"><div className="h-56 rounded-2xl bg-muted" /><div className="h-40 rounded-2xl bg-muted" /></div>
      <span className="sr-only">Loading project processing status…</span>
    </div>
  );
}

function FetchErrorState({ message, onRetry, isRetrying }: { message: string; onRetry: () => void; isRetrying: boolean }) {
  return (
    <section className="mx-auto max-w-xl rounded-2xl border border-border bg-card p-7 text-center shadow-sm sm:p-10" role="alert">
      <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-destructive/10 text-destructive"><AlertCircle aria-hidden="true" size={21} /></span>
      <h2 className="mt-5 text-lg font-semibold">Processing status is unavailable</h2>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">{message}</p>
      <div className="mt-6 flex flex-col justify-center gap-3 sm:flex-row">
        <button type="button" onClick={onRetry} disabled={isRetrying} className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
          {isRetrying ? <LoaderCircle aria-hidden="true" size={15} className="animate-spin" /> : <RefreshCw aria-hidden="true" size={15} />}
          Try again
        </button>
        <Link href="/" className="inline-flex h-10 items-center justify-center rounded-lg border border-border bg-background px-4 text-sm font-medium hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">Back to projects</Link>
      </div>
    </section>
  );
}

function ScanBlockedNotice({ reason, status }: { reason: 'waiting' | 'blocked'; status?: string }) {
  const blocked = reason === 'blocked';
  const canonicalAssetStatus = canonicalStatus(status);
  const quarantined = canonicalAssetStatus === 'quarantined';
  const normalizedStatus = status?.toLowerCase().replace(/[_-]/g, ' ');
  return (
    <div role={blocked ? 'alert' : 'status'} className={`mt-5 flex items-start gap-3 rounded-xl border p-4 sm:p-5 ${blocked ? 'border-destructive/30 bg-destructive/5' : 'border-amber-600/25 bg-amber-500/5'}`}>
      <span className={`mt-0.5 shrink-0 ${blocked ? 'text-destructive' : 'text-amber-700 dark:text-amber-300'}`}>
        {blocked ? <AlertCircle aria-hidden="true" size={19} /> : <LockKeyhole aria-hidden="true" size={18} />}
      </span>
      <div>
        <h3 className="text-sm font-semibold">{blocked ? 'Source scan blocked processing' : quarantined ? 'Source is quarantined while checks run' : 'Source checks are still pending'}</h3>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          {blocked
            ? 'The server has not cleared this movie for processing. You can review the status, but processing cannot start.'
            : quarantined
              ? 'The movie will remain on hold until the scan is complete and the server marks the source ready.'
              : 'The movie will remain on hold until verification is complete and the server marks the source ready.'}
        </p>
        {normalizedStatus && <p className="mt-2 text-xs text-muted-foreground">Scan status: <span className="font-medium text-foreground">{normalizedStatus}</span></p>}
      </div>
    </div>
  );
}

function StageBadge({ status }: { status: StageStatus }) {
  const labels: Record<StageStatus, string> = { complete: 'Complete', active: 'In progress', queued: 'Queued', not_started: 'Not started', failed: 'Failed', blocked: 'Blocked', paused: 'Paused' };
  const classes: Record<StageStatus, string> = {
    complete: 'bg-primary/10 text-primary',
    active: 'bg-primary/10 text-primary',
    queued: 'bg-muted text-muted-foreground',
    not_started: 'bg-muted text-muted-foreground',
    failed: 'bg-destructive/10 text-destructive',
    blocked: 'bg-amber-500/10 text-amber-800 dark:text-amber-300',
    paused: 'bg-amber-500/10 text-amber-800 dark:text-amber-300',
  };
  return <span className={`rounded-full px-2.5 py-1 text-[10px] font-semibold ${classes[status]}`}>{labels[status]}</span>;
}

function ContentPreviewCard({ title, icon, content, isLoading, absentMessage }: { title: string; icon: React.ReactNode; content: string | null; isLoading: boolean; absentMessage: string }) {
  return (
    <section className="rounded-2xl border border-border bg-card p-5">
      <div className="flex items-center gap-2.5">
        <span className="grid h-8 w-8 place-items-center rounded-lg bg-muted text-primary">{icon}</span>
        <h2 className="text-sm font-semibold">{title}</h2>
      </div>
      {content ? (
        <div className="mt-4 max-h-56 overflow-auto rounded-xl bg-muted/45 p-3 text-xs leading-6 text-foreground/80">{content}</div>
      ) : isLoading ? (
        <p role="status" className="mt-4 rounded-xl border border-dashed border-border bg-muted/25 p-4 text-xs leading-5 text-muted-foreground">Checking for saved {title.toLowerCase()}…</p>
      ) : (
        <p className="mt-4 rounded-xl border border-dashed border-border bg-muted/25 p-4 text-xs leading-5 text-muted-foreground">{absentMessage}</p>
      )}
    </section>
  );
}
