import { createHash } from "node:crypto";
import Redis from "ioredis";
import { Queue } from "bullmq";
import {
  audioExtractionResultSchema,
  finalRenderResultSchema,
  movieAnalysisResultSchema,
  narrationResultSchema,
  recapScriptResultSchema,
  subtitleResultSchema,
  transcriptionResultSchema,
} from "@/lib/schemas/pipeline";
import type { PipelineJobView, PipelineResultsResponse, PipelineStartResponse, PipelineStatusResponse } from "@/lib/schemas/pipeline";
import { PipelineRepository, PIPELINE_STAGES, type PipelineStage } from "@/repositories/PipelineRepository";
import { FreeRecapEntitlementUnavailableError } from "@/services/PromoEntitlementService";
import { computeStoredObjectChecksumSHA256, getS3BucketName, headStoredObject, readStoredObjectPrefix } from "@/lib/storage/s3";

const MAX_ATTEMPTS = 4;
const QUEUE_PREFIX = "instantcap";
const globalForPipeline = globalThis as typeof globalThis & {
  instantcapPipelineRedis?: Redis;
  instantcapPipelineQueues?: Map<string, Queue>;
};

export class PipelineError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = "PipelineError";
  }
}

function conflict(code: string, message: string) { return new PipelineError(code, message, 409); }
function unavailable(message = "Pipeline processing is temporarily unavailable") {
  return new PipelineError("PIPELINE_UNAVAILABLE", message, 503);
}

function requireFinalMediaPipeline(): void {
  const implementedStages: readonly string[] = [...PIPELINE_STAGES];
  const requiredStages = ["narrate", "subtitle", "render"];
  if (!requiredStages.every((stage) => implementedStages.includes(stage))) {
    throw new PipelineError(
      "MEDIA_PIPELINE_NOT_CONFIGURED",
      "Narration, subtitle timing, and final render are not wired to persisted pipeline stages; processing is disabled to avoid consuming a free recap without delivering the video",
      503,
    );
  }
}

async function withFreeRecapErrorMapping<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if (error instanceof FreeRecapEntitlementUnavailableError) {
      throw new PipelineError(error.code, error.message, 402);
    }
    throw error;
  }
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function redisConnection() {
  if (!globalForPipeline.instantcapPipelineRedis) {
    globalForPipeline.instantcapPipelineRedis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      lazyConnect: true,
    });
  }
  return globalForPipeline.instantcapPipelineRedis;
}

function queueFor(name: string) {
  globalForPipeline.instantcapPipelineQueues ??= new Map();
  let queue = globalForPipeline.instantcapPipelineQueues.get(name);
  if (!queue) {
    queue = new Queue(name, {
      connection: redisConnection(),
      prefix: QUEUE_PREFIX,
      defaultJobOptions: {
        attempts: MAX_ATTEMPTS,
        backoff: { type: "exponential", delay: 5_000 },
        removeOnComplete: false,
        removeOnFail: false,
      },
    });
    globalForPipeline.instantcapPipelineQueues.set(name, queue);
  }
  return queue;
}

async function assertAiProviderReady() {
  const base = (process.env.AI_WORKER_URL ?? "http://ai-worker:8003").replace(/\/$/, "");
  let response: Response;
  try {
    response = await fetch(`${base}/ready`, { signal: AbortSignal.timeout(15_000), cache: "no-store" });
  } catch {
    throw unavailable("AI provider configuration could not be verified");
  }
  let health: { ready?: boolean; default_provider?: string; gemini_configured?: boolean; provider_available?: boolean; provider_error_code?: string; provider_error?: string };
  try { health = await response.json(); } catch { throw unavailable("AI provider configuration could not be verified"); }
  if (health.provider_error_code === "GEMINI_LOCATION_UNSUPPORTED") {
    throw new PipelineError("GEMINI_LOCATION_UNSUPPORTED", "Gemini API calls are not supported from this runtime location; configure a supported Google Cloud Gemini deployment before enabling recaps", 503);
  }
  if (!response.ok) throw unavailable("AI provider configuration could not be verified");
  const provider = (process.env.AI_PROVIDER ?? health.default_provider ?? "gemini").toLowerCase();
  if (provider !== (health.default_provider ?? "").toLowerCase()) {
    throw unavailable("AI provider selection does not match the inference worker configuration");
  }
  const configured = provider === "gemini" ? health.gemini_configured : false;
  if (health.ready !== true || !health.provider_available || !configured) {
    throw unavailable("No production AI provider is available; no AI jobs were queued");
  }
}

function publicJobStatus(job: NonNullable<Awaited<ReturnType<typeof PipelineRepository.findJob>>>): PipelineJobView {
  return {
    jobId: job.jobId,
    stage: job.name as PipelineStage,
    status: job.status,
    progress: job.progress,
    attemptsMade: job.attemptsMade,
    createdAt: job.createdAt.toISOString(),
    processedOn: job.processedOn?.toISOString() ?? null,
    finishedOn: job.finishedOn?.toISOString() ?? null,
    failureCode: job.status === "FAILED" ? job.failedReason : null,
  };
}

async function enqueuePersistedJob(jobId: string) {
  const record = await PipelineRepository.findJob(jobId);
  if (!record) throw unavailable("Pipeline job record was not found");
  if (record.status !== "WAITING") return record;
  if (record.name === "understand" || record.name === "recap") await assertAiProviderReady();
  const queue = queueFor(record.queueName);
  try {
    await queue.add(record.name, record.data as Record<string, unknown>, {
      jobId: record.jobId,
      attempts: MAX_ATTEMPTS,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: false,
      removeOnFail: false,
    });
  } catch {
    // JobRecord is the durable outbox. Repeating this call with the same BullMQ
    // jobId safely repairs a lost Redis handoff without creating duplicate work.
    throw unavailable("Pipeline job was saved and will be safe to enqueue again");
  }
  return record;
}

function pipelineStageFromJob(jobName: string): PipelineStage {
  if ((PIPELINE_STAGES as readonly string[]).includes(jobName)) return jobName as PipelineStage;
  throw conflict("PIPELINE_JOB_INVALID", "Pipeline job stage is invalid");
}

export async function startMoviePipeline(ownerId: string, projectId: string, idempotencyKey: string): Promise<PipelineStartResponse> {
  requireFinalMediaPipeline();
  const project = await PipelineRepository.findOwnedEligibleProject(ownerId, projectId);
  if (!project) {
    if (!await PipelineRepository.findOwnedProject(ownerId, projectId)) {
      throw new PipelineError("PROJECT_NOT_FOUND", "Project was not found", 404);
    }
    throw conflict("ASSET_NOT_READY", "The movie asset must be verified, ready, and scan-clean before processing");
  }
  const asset = project.assets[0];
  if (!asset) throw conflict("ASSET_NOT_READY", "The movie asset must be verified, ready, and scan-clean before processing");

  const keyDigest = digest(`${ownerId}:${projectId}:${idempotencyKey}`);
  const runId = `pipeline_${projectId}_${keyDigest}`;
  const jobId = `${runId}_audio-extract`;
  let job = await PipelineRepository.findJob(jobId);
  if (!job && project.status !== "UPLOADED") {
    const current = await getMoviePipelineStatus(ownerId, projectId);
    const waiting = current.stages.find((stage) => stage.status === "WAITING" || stage.status === "DELAYED");
    if (waiting) {
      const pending = await PipelineRepository.findJob(waiting.jobId);
      if (pending) {
        await enqueuePersistedJob(pending.jobId);
        return { runId: current.runId ?? runId, status: pending.status, currentStage: pipelineStageFromJob(pending.name), job: publicJobStatus(pending) };
      }
    }
    const currentJob = current.stages.find((stage) => stage.stage === current.currentStage);
    if (currentJob) {
      if (currentJob.status === "FAILED") throw conflict("PIPELINE_FAILED", "Use the retry endpoint to resume from the failed stage");
      return { runId: current.runId ?? runId, status: currentJob.status, currentStage: pipelineStageFromJob(currentJob.stage), job: currentJob };
    }
    throw conflict("PIPELINE_ALREADY_STARTED", "This project has already entered processing; query its pipeline status");
  }
  if (!job) {
    if (project.status !== "UPLOADED") {
      throw conflict("PIPELINE_ALREADY_STARTED", "This project has already entered processing; query its pipeline status");
    }
    await assertAiProviderReady();
    job = await withFreeRecapErrorMapping(PipelineRepository.createInitialJob({
      runId, jobId, ownerId, projectId, assetId: asset.id,
      bucket: asset.bucket, assetKey: asset.storageKey, idempotencyDigest: keyDigest,
    }));
    if (!job) job = await PipelineRepository.findJob(jobId);
    if (!job) throw conflict("PIPELINE_STATE_CONFLICT", "Project state changed before processing could start");
  }
  await enqueuePersistedJob(jobId);
  return { runId, status: job.status, currentStage: "audio-extract", job: publicJobStatus(job) };
}

export async function getMoviePipelineStatus(ownerId: string, projectId: string): Promise<PipelineStatusResponse> {
  const project = await PipelineRepository.findOwnedProject(ownerId, projectId);
  if (!project) throw new PipelineError("PROJECT_NOT_FOUND", "Project was not found", 404);
  const jobs = (await PipelineRepository.findPipelineJobs(projectId))
    .filter((row) => (row.data as Record<string, unknown>).ownerId === ownerId);
  if (!jobs.length) return { projectId, projectStatus: project.status, runId: null, currentStage: null, stages: [] };

  const groups = new Map<string, typeof jobs>();
  for (const job of jobs) {
    const separator = job.jobId.lastIndexOf("_");
    const runId = separator > 0 ? job.jobId.slice(0, separator) : job.jobId;
    groups.set(runId, [...(groups.get(runId) ?? []), job]);
  }
  const latest = [...groups.entries()].sort((a, b) =>
    Math.max(...b[1].map((job) => job.createdAt.getTime())) - Math.max(...a[1].map((job) => job.createdAt.getTime())),
  )[0];
  const stageOrder: PipelineStage[] = [...PIPELINE_STAGES];
  const stages = latest[1].sort((a, b) => stageOrder.indexOf(a.name as PipelineStage) - stageOrder.indexOf(b.name as PipelineStage)).map(publicJobStatus);
  const current = stages.find((stage) => stage.status === "ACTIVE" || stage.status === "WAITING" || stage.status === "DELAYED")
    ?? [...stages].reverse().find((stage) => stage.status === "FAILED")
    ?? stages[stages.length - 1];
  return { projectId, projectStatus: project.status, runId: latest[0], currentStage: (current?.stage ?? null) as PipelineStatusResponse["currentStage"], stages };
}

export async function getMoviePipelineResults(ownerId: string, projectId: string): Promise<PipelineResultsResponse> {
  const records = await PipelineRepository.findOwnedPipelineResults(ownerId, projectId);
  if (!records) throw new PipelineError("PROJECT_NOT_FOUND", "Project was not found", 404);
  const transcript = records.transcription?.status === "COMPLETED" ? records.transcription : null;
  const analysis = records.analysis?.status === "COMPLETED" ? records.analysis : null;
  const script = records.recapScript;

  return {
    projectId: records.id,
    transcription: transcript ? {
      fullText: transcript.fullText,
      language: transcript.language,
      confidence: transcript.confidence,
      modelVersion: transcript.modelVersion,
      segments: transcript.segments.map((segment) => ({
        start: segment.start,
        end: segment.end,
        text: segment.text,
        confidence: segment.confidence,
        speaker: segment.speaker,
      })),
    } : null,
    analysis: analysis ? {
      genre: analysis.genre,
      themes: analysis.themes,
      characters: analysis.characters.map((character) => ({
        name: character.name,
        description: character.description,
        screenTime: character.screenTime,
        importance: character.importance,
      })),
      plotSummary: analysis.plotSummary,
      keyScenes: analysis.keyScenes.map((scene) => ({
        startTime: scene.startTime,
        endTime: scene.endTime,
        description: scene.description,
        importance: scene.importance,
      })),
      mood: analysis.mood,
      tone: analysis.tone,
      modelProvider: analysis.modelProvider,
      modelVersion: analysis.modelVersion,
    } : null,
    recapScript: script ? {
      content: script.content,
      style: script.style,
      targetLength: script.targetLength,
      language: script.language,
      version: script.version,
      segments: script.segments.map((segment) => ({
        order: segment.order,
        text: segment.text,
        startTime: segment.startTime,
        endTime: segment.endTime,
        voiceId: segment.voiceId,
        notes: segment.notes,
      })),
    } : null,
  };
}

export async function retryMoviePipeline(ownerId: string, projectId: string, idempotencyKey: string) {
  requireFinalMediaPipeline();
  const project = await PipelineRepository.findOwnedEligibleProject(ownerId, projectId);
  if (!project) {
    if (!await PipelineRepository.findOwnedProject(ownerId, projectId)) throw new PipelineError("PROJECT_NOT_FOUND", "Project was not found", 404);
    throw conflict("ASSET_NOT_READY", "The movie asset must remain verified, ready, and scan-clean to retry processing");
  }
  const asset = project.assets[0];
  if (!asset) throw conflict("ASSET_NOT_READY", "The movie asset must remain verified, ready, and scan-clean to retry processing");
  const keyDigest = digest(`${ownerId}:${projectId}:retry:${idempotencyKey}`);
  const runId = `pipeline_${projectId}_${keyDigest}`;
  const existing = await Promise.all(PIPELINE_STAGES.map((stage) => PipelineRepository.findJob(`${runId}_${stage}`)));
  const existingJob = existing.find(Boolean);
  if (existingJob) {
    await enqueuePersistedJob(existingJob.jobId);
    return { runId, status: existingJob.status, currentStage: pipelineStageFromJob(existingJob.name), job: publicJobStatus(existingJob) };
  }
  const current = await getMoviePipelineStatus(ownerId, projectId);
  if (project.status !== "FAILED") throw conflict("PIPELINE_NOT_FAILED", "Only a failed pipeline can be retried");
  const failed = current.stages.find((stage) => stage.status === "FAILED");
  if (!failed) throw conflict("FAILED_STAGE_NOT_FOUND", "No failed stage is available to retry");
  const latestJobs = await PipelineRepository.findPipelineJobs(projectId);
  const source = latestJobs.find((job) => job.jobId === failed.jobId);
  if (!source) throw conflict("FAILED_STAGE_NOT_FOUND", "The failed stage record is unavailable");
  await assertAiProviderReady();
  const jobId = `${runId}_${failed.stage}`;
  const job = await withFreeRecapErrorMapping(PipelineRepository.createRetryJob({
    runId, jobId, stage: pipelineStageFromJob(failed.stage), ownerId, projectId,
    assetId: asset.id, bucket: asset.bucket, assetKey: asset.storageKey,
    idempotencyDigest: keyDigest, retryOfJobId: source.jobId,
  }));
  const retryJob = job ?? await PipelineRepository.findJob(jobId);
  if (!retryJob) throw conflict("PIPELINE_STATE_CONFLICT", "Project state changed before retry could start");
  await enqueuePersistedJob(jobId);
  return { runId, status: retryJob.status, currentStage: pipelineStageFromJob(retryJob.name), job: publicJobStatus(retryJob) };
}

async function enqueueNextStage(job: Awaited<ReturnType<typeof PipelineRepository.completeStage>>) {
  if (job?.status === "WAITING") await enqueuePersistedJob(job.jobId);
}

export async function processPipelineWorkerEvent(jobId: string, event: {
  event: "started" | "progress" | "failed" | "completed";
  attemptsMade?: number;
  progress?: number;
  code?: string;
  result?: unknown;
}) {
  const job = await PipelineRepository.findJob(jobId);
  if (!job) throw new PipelineError("PIPELINE_JOB_NOT_FOUND", "Pipeline job was not found", 404);
  const stage = pipelineStageFromJob(job.name);
  if (event.event === "started") {
    const updated = await PipelineRepository.markStarted(jobId, event.attemptsMade);
    if (!updated) throw conflict("PIPELINE_STATE_CONFLICT", "Pipeline job cannot enter the active state");
    return publicJobStatus(updated);
  }
  if (event.event === "progress") {
    const updated = await PipelineRepository.markProgress(jobId, event.progress ?? 0);
    if (updated.count !== 1) throw conflict("PIPELINE_STATE_CONFLICT", "Progress is accepted only for an active job");
    const latest = await PipelineRepository.findJob(jobId);
    return latest ? publicJobStatus(latest) : null;
  }
  if (event.event === "failed") {
    const updated = await PipelineRepository.markFailed(jobId, event.code ?? "WORKER_FAILED");
    if (!updated) throw conflict("PIPELINE_STATE_CONFLICT", "Pipeline job cannot enter the failed state");
    return publicJobStatus(updated);
  }

  const result = stage === "audio-extract" ? audioExtractionResultSchema.parse(event.result)
    : stage === "asr" ? transcriptionResultSchema.parse(event.result)
      : stage === "understand" ? movieAnalysisResultSchema.parse(event.result)
        : stage === "recap" ? recapScriptResultSchema.parse(event.result)
          : stage === "narrate" ? narrationResultSchema.parse(event.result)
            : stage === "subtitle" ? subtitleResultSchema.parse(event.result)
              : finalRenderResultSchema.parse(event.result);
  const modelProvider = "modelProvider" in result ? result.modelProvider : undefined;
  if ((stage === "understand" || stage === "recap") && modelProvider !== "gemini") {
    throw unavailable("The selected AI worker has no verified production provider");
  }
  const jobData = job.data as Record<string, unknown>;
  const projectId = String(jobData.projectId);
  const runId = String(jobData.runId);
  if (stage === "narrate") {
    const value = result as ReturnType<typeof narrationResultSchema.parse>;
    const prefix = `${projectId}/narration/${runId}/`;
    if (value.audioKey !== `${prefix}combined.wav` || value.segments.some((segment) => !segment.audioKey.startsWith(prefix)) ||
        new Set(value.segments.map((segment) => segment.order)).size !== value.segments.length ||
        Math.abs(value.segments.reduce((sum, segment) => sum + segment.duration, 0) - value.totalDuration) > 0.05) {
      throw conflict("NARRATION_RESULT_INVALID", "Narration artifact keys, ordering, or measured durations are invalid");
    }
  }
  if (stage === "subtitle") {
    const value = result as ReturnType<typeof subtitleResultSchema.parse>;
    if (value.subtitleKey !== `${projectId}/subtitles/${runId}/my.srt` || !value.content.startsWith("1\n00:")) {
      throw conflict("SUBTITLE_RESULT_INVALID", "Subtitle artifact key or SRT content is invalid");
    }
  }
  let verifiedOutput: { checksumSHA256: string } | undefined;
  if (stage === "render") {
    const value = result as ReturnType<typeof finalRenderResultSchema.parse>;
    const expectedKey = `${projectId}/renders/${runId}/final.mp4`;
    try {
      if (getS3BucketName() !== String(jobData.bucket) || value.outputKey !== expectedKey) {
        throw new Error("Rendered output does not match the pipeline's private destination");
      }
      const metadata = await headStoredObject(value.outputKey);
      if (metadata.contentLength !== value.fileSize || value.fileSize < 32) throw new Error("Rendered output size does not match private storage");
      const signature = Buffer.from(await readStoredObjectPrefix(value.outputKey, 32));
      if (signature.length < 12 || signature.toString("ascii", 4, 8) !== "ftyp") throw new Error("Rendered output has no MP4 file type signature");
      verifiedOutput = { checksumSHA256: await computeStoredObjectChecksumSHA256(value.outputKey) };
    } catch {
      throw unavailable("Final MP4 is not present and verified in private object storage");
    }
  }
  const next = await PipelineRepository.completeStage(jobId, result, verifiedOutput);
  if (!next) throw conflict("PIPELINE_STATE_CONFLICT", "Pipeline completion was not accepted");
  await enqueueNextStage(next);
  return publicJobStatus(next);
}

export function pipelineStageNames() { return [...PIPELINE_STAGES]; }

export async function shutdownPipelineQueues() {
  await Promise.all([...globalForPipeline.instantcapPipelineQueues?.values() ?? []].map((queue) => queue.close()));
  globalForPipeline.instantcapPipelineQueues?.clear();
  if (globalForPipeline.instantcapPipelineRedis) {
    await globalForPipeline.instantcapPipelineRedis.quit();
    globalForPipeline.instantcapPipelineRedis = undefined;
  }
}
