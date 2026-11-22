import { z } from "zod";
import { projectIdSchema } from "@/lib/schemas/projects";

const boundedText = (max: number) => z.string().trim().min(1).max(max);
const segmentSchema = z.object({
  start: z.number().finite().nonnegative(),
  end: z.number().finite().positive(),
  text: boundedText(20_000),
  confidence: z.number().finite().min(0).max(1).optional(),
  speaker: z.string().max(160).optional(),
}).strict().refine((segment) => segment.end > segment.start, "Segment end must follow start");

export const pipelinePathSchema = z.object({ projectId: projectIdSchema }).strict();

export const pipelineStartSchema = z.object({}).strict();

export const audioExtractionResultSchema = z.object({
  executionMode: z.literal("production"),
  audioKey: z.string().min(1).max(1024).refine((value) => !value.startsWith("/") && !value.split("/").includes("..")),
  duration: z.number().finite().positive().max(12 * 60 * 60),
  fileSize: z.number().int().positive().max(2_147_483_647),
  format: z.literal("wav").default("wav"),
  sampleRate: z.literal(16_000).default(16_000),
  channels: z.literal(1).default(1),
}).strict();

export const transcriptionResultSchema = z.object({
  executionMode: z.literal("production"),
  fullText: z.string().min(1).max(1_000_000),
  language: z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/).default("my"),
  confidence: z.number().finite().min(0).max(1).optional(),
  modelVersion: z.string().min(1).max(120).default("nara-sar-v1"),
  segments: z.array(segmentSchema).max(50_000).default([]),
}).strict();

const characterSchema = z.object({
  name: boundedText(160),
  description: z.string().max(4_000).optional(),
  screenTime: z.number().finite().min(0).max(100).optional(),
  importance: z.number().int().min(1).max(5).default(1),
}).strict();

const keySceneSchema = z.object({
  startTime: z.number().finite().nonnegative(),
  endTime: z.number().finite().positive(),
  description: boundedText(4_000),
  importance: z.number().int().min(1).max(5).default(1),
}).strict().refine((scene) => scene.endTime > scene.startTime, "Scene end must follow start");

export const movieAnalysisResultSchema = z.object({
  executionMode: z.literal("production"),
  genre: z.array(boundedText(80)).max(50).default([]),
  themes: z.array(boundedText(160)).max(100).default([]),
  characters: z.array(characterSchema).max(500).default([]),
  plotSummary: boundedText(100_000),
  keyScenes: z.array(keySceneSchema).max(5_000).default([]),
  mood: boundedText(160),
  tone: boundedText(160),
  modelProvider: z.literal("gemini"),
  modelVersion: z.string().min(1).max(120),
}).strict();

export const recapScriptResultSchema = z.object({
  executionMode: z.literal("production"),
  content: z.string().min(1).max(1_000_000),
  segments: z.array(z.object({
    order: z.number().int().nonnegative(),
    text: boundedText(20_000),
    startTime: z.number().finite().nonnegative().optional(),
    endTime: z.number().finite().positive().optional(),
    voiceId: z.string().max(100).optional(),
    notes: z.string().max(4_000).optional(),
  }).strict()).max(10_000),
  style: z.enum(["CINEMATIC", "EMOTIONAL", "STORYTELLING", "SUSPENSE", "DOCUMENTARY"]),
  targetLength: z.number().int().positive().max(3_600),
  language: z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/).default("my"),
  modelProvider: z.literal("gemini"),
}).strict();

export const narrationResultSchema = z.object({
  executionMode: z.literal("production"),
  audioKey: z.string().min(1).max(1024).refine((value) => !value.startsWith("/") && !value.split("/").includes("..")),
  totalDuration: z.number().finite().positive().max(12 * 60 * 60),
  voicePreset: z.string().min(1).max(100),
  segments: z.array(z.object({
    order: z.number().int().nonnegative(), scriptSegmentId: z.string().regex(/^[a-f\d]{24}$/i),
    text: boundedText(4_800), audioKey: z.string().min(1).max(1024).refine((value) => !value.startsWith("/") && !value.split("/").includes("..")),
    duration: z.number().finite().positive().max(60 * 60), voiceId: z.string().min(1).max(100),
  }).strict()).min(1).max(10_000),
}).strict();

export const subtitleResultSchema = z.object({
  executionMode: z.literal("production"),
  subtitleKey: z.string().min(1).max(1024).refine((value) => !value.startsWith("/") && !value.split("/").includes("..")),
  content: z.string().min(1).max(1_000_000),
  language: z.literal("my"), format: z.literal("SRT"),
  duration: z.number().finite().positive().max(12 * 60 * 60),
}).strict();

export const finalRenderResultSchema = z.object({
  executionMode: z.literal("production"),
  outputKey: z.string().min(1).max(1024).refine((value) => !value.startsWith("/") && !value.split("/").includes("..")),
  duration: z.number().finite().positive().max(12 * 60 * 60),
  fileSize: z.number().int().positive().max(2_147_483_647),
  resolution: z.string().regex(/^(720p|1080p|4k)$/),
  fps: z.number().int().min(1).max(60), codec: z.string().regex(/^(h264|h265|vp9)$/),
}).strict();

export const pipelineWorkerEventSchema = z.discriminatedUnion("event", [
  z.object({ event: z.literal("started"), attemptsMade: z.number().int().min(0).max(20).optional() }).strict(),
  z.object({ event: z.literal("progress"), progress: z.number().int().min(0).max(100) }).strict(),
  z.object({ event: z.literal("failed"), code: z.string().regex(/^[A-Z0-9_]{2,80}$/) }).strict(),
  z.object({ event: z.literal("completed"), result: z.unknown() }).strict(),
]);

export type AudioExtractionResult = z.infer<typeof audioExtractionResultSchema>;
export type TranscriptionResult = z.infer<typeof transcriptionResultSchema>;
export type MovieAnalysisResult = z.infer<typeof movieAnalysisResultSchema>;
export type RecapScriptResult = z.infer<typeof recapScriptResultSchema>;

export type NarrationResult = z.infer<typeof narrationResultSchema>;
export type SubtitleResult = z.infer<typeof subtitleResultSchema>;
export type FinalRenderResult = z.infer<typeof finalRenderResultSchema>;
export type PipelineStageName = "audio-extract" | "asr" | "understand" | "recap" | "narrate" | "subtitle" | "render";
export type PipelineJobStatus = "WAITING" | "ACTIVE" | "COMPLETED" | "FAILED" | "DELAYED" | "PAUSED";
export type PipelineJobView = {
  jobId: string;
  stage: PipelineStageName;
  status: PipelineJobStatus;
  progress: number;
  attemptsMade: number;
  createdAt: string;
  processedOn: string | null;
  finishedOn: string | null;
  failureCode: string | null;
};
export type PipelineStatusResponse = {
  projectId: string;
  projectStatus: string;
  runId: string | null;
  currentStage: PipelineStageName | null;
  stages: PipelineJobView[];
};
export type PipelineStartResponse = {
  runId: string;
  status: PipelineJobStatus;
  currentStage: PipelineStageName;
  job: PipelineJobView;
};

export type PipelineResultsResponse = {
  projectId: string;
  transcription: null | {
    fullText: string;
    language: string;
    confidence: number | null;
    modelVersion: string;
    segments: Array<{ start: number; end: number; text: string; confidence: number | null; speaker: string | null }>;
  };
  analysis: null | {
    genre: string[];
    themes: string[];
    characters: Array<{ name: string; description: string | null; screenTime: number | null; importance: number }>;
    plotSummary: string;
    keyScenes: Array<{ startTime: number; endTime: number; description: string; importance: number }>;
    mood: string;
    tone: string;
    modelProvider: string;
    modelVersion: string;
  };
  recapScript: null | {
    content: string;
    style: string;
    targetLength: number;
    language: string;
    version: number;
    segments: Array<{ order: number; text: string; startTime: number | null; endTime: number | null; voiceId: string | null; notes: string | null }>;
  };
};
