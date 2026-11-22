import { prisma } from "@/lib/prisma";
import type {
  AudioExtractionResult,
  FinalRenderResult,
  MovieAnalysisResult,
  NarrationResult,
  RecapScriptResult,
  SubtitleResult,
  TranscriptionResult,
} from "@/lib/schemas/pipeline";
import { Prisma } from "@prisma/client";
import {
  releaseFreeRecapInTransaction,
  reserveFreeRecapInTransaction,
  captureFreeRecapInTransaction,
} from "@/services/PromoEntitlementService";

export const PIPELINE_STAGES = ["audio-extract", "asr", "understand", "recap", "narrate", "subtitle", "render"] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

const nextStage: Partial<Record<PipelineStage, PipelineStage>> = {
  "audio-extract": "asr",
  asr: "understand",
  understand: "recap",
  recap: "narrate",
  narrate: "subtitle",
  subtitle: "render",
};

function queueName(stage: PipelineStage) { return stage; }

function jobRecordData(input: {
  runId: string;
  stage: PipelineStage;
  projectId: string;
  ownerId: string;
  assetId: string;
  bucket: string;
  assetKey: string;
  idempotencyDigest: string;
  retryOfJobId?: string;
}) {
  return {
    runId: input.runId,
    stage: input.stage,
    projectId: input.projectId,
    ownerId: input.ownerId,
    assetId: input.assetId,
    bucket: input.bucket,
    assetKey: input.assetKey,
    idempotencyDigest: input.idempotencyDigest,
    ...(input.retryOfJobId ? { retryOfJobId: input.retryOfJobId } : {}),
  };
}

function projectStatusForStage(stage: PipelineStage) {
  switch (stage) {
    case "audio-extract": return "AUDIO_EXTRACTING" as const;
    case "asr": return "TRANSCRIBING" as const;
    case "understand": return "ANALYZING" as const;
    case "recap": return "SCRIPT_GENERATING" as const;
    case "narrate": return "NARRATING" as const;
    case "subtitle": return "SUBTITLING" as const;
    case "render": return "RENDERING" as const;
  }
}

export const PipelineRepository = {
  findOwnedProject(ownerId: string, projectId: string) {
    return prisma.movieProject.findFirst({ where: { id: projectId, userId: ownerId } });
  },

  findOwnedPipelineResults(ownerId: string, projectId: string) {
    return prisma.movieProject.findFirst({
      where: { id: projectId, userId: ownerId },
      select: {
        id: true,
        transcription: {
          select: {
            fullText: true,
            language: true,
            confidence: true,
            modelVersion: true,
            status: true,
            segments: {
              orderBy: { start: "asc" },
              select: { start: true, end: true, text: true, confidence: true, speaker: true },
            },
          },
        },
        analysis: {
          select: {
            genre: true,
            themes: true,
            plotSummary: true,
            mood: true,
            tone: true,
            modelProvider: true,
            modelVersion: true,
            status: true,
            characters: {
              select: { name: true, description: true, screenTime: true, importance: true },
            },
            keyScenes: {
              orderBy: { startTime: "asc" },
              select: { startTime: true, endTime: true, description: true, importance: true },
            },
          },
        },
        recapScript: {
          select: {
            content: true,
            style: true,
            targetLength: true,
            language: true,
            version: true,
            segments: {
              orderBy: { order: "asc" },
              select: { order: true, text: true, startTime: true, endTime: true, voiceId: true, notes: true },
            },
          },
        },
      },
    });
  },

  findOwnedEligibleProject(ownerId: string, projectId: string) {
    return prisma.movieProject.findFirst({
      where: { id: projectId, userId: ownerId },
      include: {
        assets: {
          where: {
            ownerId,
            status: "READY",
            scanStatus: "CLEAN",
            verifiedAt: { not: null },
            sizeVerifiedAt: { not: null },
            checksumVerifiedAt: { not: null },
            signatureVerifiedAt: { not: null },
          },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
    });
  },

  findJob(jobId: string) {
    return prisma.jobRecord.findUnique({ where: { jobId } });
  },

  findPipelineJobs(projectId: string) {
    return prisma.jobRecord.findMany({
      // The caller first proves project ownership. Scope the record query by its
      // indexed projectId relation; JobRecord.data is deliberately not an auth filter.
      where: { projectId, jobId: { startsWith: `pipeline_${projectId}_` } },
      orderBy: { createdAt: "desc" },
      take: 80,
    });
  },

  async createInitialJob(input: {
    runId: string;
    jobId: string;
    ownerId: string;
    projectId: string;
    assetId: string;
    bucket: string;
    assetKey: string;
    idempotencyDigest: string;
  }) {
    try {
      return await prisma.$transaction(async (tx) => {
        const project = await tx.movieProject.findFirst({
          where: { id: input.projectId, userId: input.ownerId, status: "UPLOADED" },
        });
        const asset = await tx.movieAsset.findFirst({
          where: {
            id: input.assetId,
            projectId: input.projectId,
            ownerId: input.ownerId,
            status: "READY",
            scanStatus: "CLEAN",
            verifiedAt: { not: null },
            sizeVerifiedAt: { not: null },
            checksumVerifiedAt: { not: null },
            signatureVerifiedAt: { not: null },
          },
        });
        if (!project || !asset) return null;
        const updated = await tx.movieProject.updateMany({
          where: { id: input.projectId, userId: input.ownerId, status: "UPLOADED" },
          data: { status: "AUDIO_EXTRACTING" },
        });
        if (updated.count !== 1) return null;
        await reserveFreeRecapInTransaction(tx, { userId: input.ownerId, projectId: input.projectId, runId: input.runId });
        return tx.jobRecord.create({
          data: {
            projectId: input.projectId,
            queueName: "audio-extract",
            jobId: input.jobId,
            name: "audio-extract",
            data: jobRecordData({ ...input, stage: "audio-extract" }),
            status: "WAITING",
          },
        });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return this.findJob(input.jobId);
      }
      throw error;
    }
  },

  async createRetryJob(input: {
    runId: string;
    jobId: string;
    stage: PipelineStage;
    ownerId: string;
    projectId: string;
    assetId: string;
    bucket: string;
    assetKey: string;
    idempotencyDigest: string;
    retryOfJobId: string;
  }) {
    try {
      return await prisma.$transaction(async (tx) => {
        const project = await tx.movieProject.findFirst({
          where: { id: input.projectId, userId: input.ownerId, status: "FAILED" },
        });
        const asset = await tx.movieAsset.findFirst({
          where: {
            id: input.assetId,
            projectId: input.projectId,
            ownerId: input.ownerId,
            status: "READY",
            scanStatus: "CLEAN",
            verifiedAt: { not: null },
            sizeVerifiedAt: { not: null },
            checksumVerifiedAt: { not: null },
            signatureVerifiedAt: { not: null },
          },
        });
        if (!project || !asset) return null;
        const updated = await tx.movieProject.updateMany({
          where: { id: input.projectId, userId: input.ownerId, status: "FAILED" },
          data: { status: projectStatusForStage(input.stage) },
        });
        if (updated.count !== 1) return null;
        await reserveFreeRecapInTransaction(tx, { userId: input.ownerId, projectId: input.projectId, runId: input.runId });
        return tx.jobRecord.create({
          data: {
            projectId: input.projectId,
            queueName: queueName(input.stage),
            jobId: input.jobId,
            name: input.stage,
            data: jobRecordData(input),
            status: "WAITING",
          },
        });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return this.findJob(input.jobId);
      }
      throw error;
    }
  },

  async markStarted(jobId: string, attemptsMade?: number) {
    const job = await this.findJob(jobId);
    if (!job) return null;
    const data = job.data as Record<string, unknown>;
    const stage = job.name as PipelineStage;
    if (!PIPELINE_STAGES.includes(stage)) return null;
    return prisma.$transaction(async (tx) => {
      const updated = await tx.jobRecord.updateMany({
        where: { jobId, status: { in: ["WAITING", "ACTIVE"] } },
        data: { status: "ACTIVE", processedOn: job.processedOn ?? new Date(), ...(attemptsMade === undefined ? {} : { attemptsMade }) },
      });
      if (updated.count === 1) {
        await tx.movieProject.updateMany({
          where: { id: String(data.projectId), userId: String(data.ownerId) },
          data: { status: projectStatusForStage(stage) },
        });
      }
      return tx.jobRecord.findUnique({ where: { jobId } });
    });
  },

  markProgress(jobId: string, progress: number) {
    return prisma.jobRecord.updateMany({ where: { jobId, status: "ACTIVE" }, data: { progress } });
  },

  async markFailed(jobId: string, code: string) {
    const job = await this.findJob(jobId);
    if (!job) return null;
    const data = job.data as Record<string, unknown>;
    return prisma.$transaction(async (tx) => {
      const updated = await tx.jobRecord.updateMany({
        where: { jobId, status: { in: ["WAITING", "ACTIVE"] } },
        data: { status: "FAILED", failedReason: code, finishedOn: new Date() },
      });
      if (updated.count === 1) {
        await tx.movieProject.updateMany({
          where: { id: String(data.projectId), userId: String(data.ownerId) },
          data: { status: "FAILED" },
        });
        await releaseFreeRecapInTransaction(tx, {
          userId: String(data.ownerId), projectId: String(data.projectId), runId: String(data.runId),
        });
      }
      return tx.jobRecord.findUnique({ where: { jobId } });
    });
  },

  async completeStage(
    jobId: string,
    result: AudioExtractionResult | TranscriptionResult | MovieAnalysisResult | RecapScriptResult | NarrationResult | SubtitleResult | FinalRenderResult,
    verifiedOutput?: { checksumSHA256: string },
  ) {
    const job = await this.findJob(jobId);
    if (!job) return null;
    const stage = job.name as PipelineStage;
    if (!PIPELINE_STAGES.includes(stage)) return null;
    const data = job.data as Record<string, unknown>;
    return prisma.$transaction(async (tx) => {
      const current = await tx.jobRecord.findUnique({ where: { jobId } });
      if (!current) return null;
      if (current.status === "COMPLETED") {
        const next = nextStage[stage];
        return next ? tx.jobRecord.findUnique({ where: { jobId: `${String(data.runId)}_${next}` } }) : current;
      }
      if (current.status !== "ACTIVE" && current.status !== "WAITING") return null;

      const projectId = String(data.projectId);
      const assetId = String(data.assetId);
      const ownerId = String(data.ownerId);
      if (stage === "audio-extract") {
        const value = result as AudioExtractionResult;
        await tx.audioExtraction.upsert({
          where: { projectId },
          create: {
            projectId,
            audioKey: value.audioKey,
            audioUrl: `s3://${String(data.bucket)}/${value.audioKey}`,
            duration: value.duration,
            fileSize: value.fileSize,
            format: value.format,
            sampleRate: value.sampleRate,
            channels: value.channels,
            status: "COMPLETED",
            startedAt: current.processedOn ?? current.timestamp,
            completedAt: new Date(),
          },
          update: {
            audioKey: value.audioKey,
            audioUrl: `s3://${String(data.bucket)}/${value.audioKey}`,
            duration: value.duration,
            fileSize: value.fileSize,
            format: value.format,
            sampleRate: value.sampleRate,
            channels: value.channels,
            status: "COMPLETED",
            errorMessage: null,
            completedAt: new Date(),
          },
        });
      } else if (stage === "asr") {
        const value = result as TranscriptionResult;
        await tx.transcription.upsert({
          where: { projectId },
          create: {
            projectId,
            fullText: value.fullText,
            language: value.language,
            confidence: value.confidence,
            modelVersion: value.modelVersion,
            status: "COMPLETED",
            completedAt: new Date(),
            segments: { create: value.segments },
          },
          update: {
            fullText: value.fullText,
            language: value.language,
            confidence: value.confidence,
            modelVersion: value.modelVersion,
            status: "COMPLETED",
            completedAt: new Date(),
            segments: { deleteMany: {}, create: value.segments },
          },
        });
      } else if (stage === "understand") {
        const value = result as MovieAnalysisResult;
        await tx.movieAnalysis.upsert({
          where: { projectId },
          create: {
            projectId,
            genre: value.genre,
            themes: value.themes,
            plotSummary: value.plotSummary,
            mood: value.mood,
            tone: value.tone,
            modelProvider: value.modelProvider,
            modelVersion: value.modelVersion,
            status: "COMPLETED",
            completedAt: new Date(),
            characters: { create: value.characters.map((row) => ({
              name: row.name, description: row.description, screenTime: row.screenTime, importance: row.importance,
            })) },
            keyScenes: { create: value.keyScenes.map((row) => ({
              startTime: row.startTime, endTime: row.endTime, description: row.description, importance: row.importance,
            })) },
          },
          update: {
            genre: value.genre,
            themes: value.themes,
            plotSummary: value.plotSummary,
            mood: value.mood,
            tone: value.tone,
            modelProvider: value.modelProvider,
            modelVersion: value.modelVersion,
            status: "COMPLETED",
            completedAt: new Date(),
            characters: { deleteMany: {}, create: value.characters.map((row) => ({
              name: row.name, description: row.description, screenTime: row.screenTime, importance: row.importance,
            })) },
            keyScenes: { deleteMany: {}, create: value.keyScenes.map((row) => ({
              startTime: row.startTime, endTime: row.endTime, description: row.description, importance: row.importance,
            })) },
          },
        });
      } else if (stage === "recap") {
        const value = result as RecapScriptResult;
        await tx.recapScript.upsert({
          where: { projectId },
          create: {
            projectId,
            content: value.content,
            style: value.style,
            targetLength: value.targetLength,
            language: value.language,
            status: "DRAFT",
            segments: { create: value.segments },
          },
          update: {
            content: value.content,
            style: value.style,
            targetLength: value.targetLength,
            language: value.language,
            status: "DRAFT",
            segments: { deleteMany: {}, create: value.segments },
          },
        });
      } else if (stage === "narrate") {
        const value = result as NarrationResult;
        const script = await tx.recapScript.findUnique({ where: { projectId } });
        if (!script) throw new Error("Cannot persist narration without its recap script");
        const narrationSegments = value.segments.map((segment) => ({
          scriptSegmentId: segment.scriptSegmentId, order: segment.order, text: segment.text,
          audioKey: segment.audioKey, audioUrl: `s3://${String(data.bucket)}/${segment.audioKey}`,
          duration: segment.duration, voiceId: segment.voiceId, status: "COMPLETED" as const,
        }));
        await tx.narration.upsert({
          where: { projectId },
          create: {
            projectId, scriptId: script.id, voicePreset: value.voicePreset,
            totalDuration: value.totalDuration, status: "COMPLETED",
            startedAt: current.processedOn ?? current.timestamp, completedAt: new Date(),
            segments: { create: narrationSegments },
          },
          update: {
            scriptId: script.id, voicePreset: value.voicePreset, totalDuration: value.totalDuration,
            status: "COMPLETED", errorMessage: null, completedAt: new Date(),
            segments: { deleteMany: {}, create: narrationSegments },
          },
        });
      } else if (stage === "subtitle") {
        const value = result as SubtitleResult;
        await tx.subtitle.create({ data: {
          projectId, language: value.language, format: "SRT", content: value.content,
          key: value.subtitleKey, url: `s3://${String(data.bucket)}/${value.subtitleKey}`, status: "COMPLETED",
        } });
      } else {
        const value = result as FinalRenderResult;
        if (!verifiedOutput?.checksumSHA256) throw new Error("Final render must be storage-verified before persistence");
        const [project, narration, subtitle] = await Promise.all([
          tx.movieProject.findFirst({ where: { id: projectId, userId: ownerId }, select: { title: true } }),
          tx.narration.findUnique({ where: { projectId } }),
          tx.subtitle.findFirst({ where: { projectId, status: "COMPLETED" }, orderBy: { createdAt: "desc" } }),
        ]);
        if (!project || !narration || !subtitle) throw new Error("Final render prerequisites were not persisted");
        const render = await tx.videoRender.create({ data: {
          projectId, narrationId: narration.id, subtitleId: subtitle.id,
          outputKey: value.outputKey, outputUrl: `s3://${String(data.bucket)}/${value.outputKey}`,
          resolution: value.resolution, fps: value.fps, codec: value.codec,
          duration: value.duration, fileSize: value.fileSize, status: "COMPLETED", progress: 100,
          startedAt: current.processedOn ?? current.timestamp, completedAt: new Date(),
        } });
        await tx.galleryEntry.create({ data: {
          ownerId, projectId, videoRenderId: render.id, title: project.title,
          visibility: "PRIVATE", status: "READY",
        } });
        await tx.movieProject.updateMany({
          where: { id: projectId, userId: ownerId }, data: { status: "COMPLETED", completedAt: new Date() },
        });
        await tx.jobRecord.update({
          where: { jobId },
          data: {
            status: "COMPLETED", progress: 100,
            returnValue: { completed: true, outputKey: value.outputKey, fileSize: value.fileSize, checksumSHA256: verifiedOutput.checksumSHA256 },
            finishedOn: new Date(),
          },
        });
        // Capture and gallery publication share the transaction: failed DB writes cannot consume allowance.
        await captureFreeRecapInTransaction(tx, { userId: ownerId, projectId, runId: String(data.runId) });
      }

      const completedStatus = stage === "audio-extract" ? "AUDIO_EXTRACTED"
        : stage === "asr" ? "TRANSCRIBED"
          : stage === "understand" ? "ANALYZED" : stage === "recap" ? "SCRIPT_GENERATED"
            : stage === "narrate" ? "NARRATED" : stage === "subtitle" ? "SUBTITLED" : "COMPLETED";
      if (stage !== "render") {
        await tx.movieProject.updateMany({ where: { id: projectId, userId: ownerId }, data: { status: completedStatus } });
        await tx.jobRecord.update({
          where: { jobId },
          data: { status: "COMPLETED", progress: 100, returnValue: { completed: true }, finishedOn: new Date() },
        });
      }

      const following = nextStage[stage];
      if (!following) return tx.jobRecord.findUnique({ where: { jobId } });
      const nextJobId = `${String(data.runId)}_${following}`;
      const existingNext = await tx.jobRecord.findUnique({ where: { jobId: nextJobId } });
      if (existingNext) return existingNext;
      return tx.jobRecord.create({
        data: {
          projectId,
          queueName: queueName(following),
          jobId: nextJobId,
          name: following,
          data: jobRecordData({
            runId: String(data.runId), stage: following, projectId, ownerId, assetId,
            bucket: String(data.bucket), assetKey: String(data.assetKey),
            idempotencyDigest: String(data.idempotencyDigest),
          }),
          status: "WAITING",
        },
      });
    });
  },
};
