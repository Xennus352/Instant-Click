import { createHash } from "node:crypto";
import { File } from "node:buffer";
import Redis from "ioredis";
import { UnrecoverableError, Worker } from "bullmq";
import { PrismaClient } from "@prisma/client";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { buildMeasuredSrt, combineNaraWavs, parseNaraWav, splitNarrationText } from "./media-timing.mjs";

const QUEUE_PREFIX = "instantcap";
const QUEUES = ["audio-extract", "asr", "understand", "recap", "narrate", "subtitle", "render"];
const MAX_ASR_AUDIO_BYTES = Number(process.env.MAX_ASR_AUDIO_BYTES ?? 128 * 1024 * 1024);
const MAX_NARRATION_AUDIO_BYTES = Number(process.env.MAX_NARRATION_AUDIO_BYTES ?? 256 * 1024 * 1024);
const REQUEST_TIMEOUT_MS = Number(process.env.PIPELINE_WORKER_HTTP_TIMEOUT_MS ?? 120_000);
const API_URL = (process.env.PIPELINE_API_URL ?? "http://nextjs:3000").replace(/\/$/, "");
const API_KEY = process.env.INTERNAL_API_KEY ?? "";

class PipelineWorkerError extends Error {
  constructor(code, message, retryable = true) {
    super(message);
    this.name = "PipelineWorkerError";
    this.code = code;
    this.retryable = retryable;
  }
}

function requireEnv(value, code, message) {
  if (!value?.trim()) throw new PipelineWorkerError(code, message, true);
  return value.trim();
}

function serviceUrl(value, fallback, label) {
  const input = value?.trim() || fallback;
  try {
    const url = new URL(input);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("invalid endpoint");
    return url.toString().replace(/\/$/, "");
  } catch {
    throw new PipelineWorkerError(`${label}_ENDPOINT_INVALID`, `${label} endpoint is invalid`, false);
  }
}

function requestHeaders(extra = {}) {
  return { "x-internal-api-key": API_KEY, ...extra };
}

async function requestJson(url, options, code) {
  let response;
  try {
    response = await fetch(url, { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch {
    throw new PipelineWorkerError(code, `The ${code.toLowerCase()} dependency is unavailable`, true);
  }
  if (!response.ok) {
    const retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
    throw new PipelineWorkerError(retryable ? code : "WORKER_REQUEST_REJECTED", `Worker request failed with HTTP ${response.status}`, retryable);
  }
  try {
    return await response.json();
  } catch {
    throw new PipelineWorkerError("WORKER_RESPONSE_INVALID", "Worker returned invalid JSON", true);
  }
}

async function notifyApi(jobId, event) {
  if (API_KEY.length < 32) throw new PipelineWorkerError("INTERNAL_API_KEY_UNAVAILABLE", "Internal API authentication is not configured", true);
  await requestJson(`${API_URL}/api/internal/pipeline/jobs/${encodeURIComponent(jobId)}`, {
    method: "POST",
    headers: requestHeaders({ "content-type": "application/json", accept: "application/json" }),
    body: JSON.stringify(event),
  }, "PIPELINE_API_UNAVAILABLE");
}

function getRedisConnection() {
  const redisUrl = process.env.REDIS_URL?.trim();
  if (!redisUrl) throw new PipelineWorkerError("REDIS_URL_UNAVAILABLE", "Redis URL is not configured", true);
  return new Redis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: true });
}

function getS3Client() {
  const endpoint = requireEnv(process.env.S3_ENDPOINT, "OBJECT_STORAGE_UNAVAILABLE", "S3 endpoint is not configured");
  const accessKeyId = requireEnv(process.env.S3_ACCESS_KEY, "OBJECT_STORAGE_UNAVAILABLE", "S3 access key is not configured");
  const secretAccessKey = requireEnv(process.env.S3_SECRET_KEY, "OBJECT_STORAGE_UNAVAILABLE", "S3 secret key is not configured");
  let parsed;
  try { parsed = new URL(endpoint); } catch { throw new PipelineWorkerError("OBJECT_STORAGE_UNAVAILABLE", "S3 endpoint is invalid", false); }
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new PipelineWorkerError("OBJECT_STORAGE_UNAVAILABLE", "S3 endpoint is invalid", false);
  }
  return new S3Client({
    endpoint: parsed.origin + parsed.pathname.replace(/\/$/, ""),
    region: process.env.S3_REGION?.trim() || "us-east-1",
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE?.trim().toLowerCase() !== "false",
    credentials: { accessKeyId, secretAccessKey },
  });
}

const redis = getRedisConnection();
const prisma = new PrismaClient();
let s3;

async function assertAssetStillEligible(data) {
  const asset = await prisma.movieAsset.findFirst({
    where: {
      id: data.assetId,
      projectId: data.projectId,
      ownerId: data.ownerId,
      status: "READY",
      scanStatus: "CLEAN",
      verifiedAt: { not: null },
      sizeVerifiedAt: { not: null },
      checksumVerifiedAt: { not: null },
      signatureVerifiedAt: { not: null },
    },
    select: { id: true, bucket: true, storageKey: true },
  });
  if (!asset) throw new PipelineWorkerError("ASSET_NOT_READY", "Movie asset is no longer verified and scan-clean", false);
  if (asset.bucket !== data.bucket || asset.storageKey !== data.assetKey) {
    throw new PipelineWorkerError("ASSET_CHANGED", "Movie asset storage metadata changed after queueing", false);
  }
  return asset;
}

function privateStorageClient() {
  s3 ??= getS3Client();
  return s3;
}

async function callAudioExtractor(job) {
  const base = process.env.FFMPEG_WORKER_URL?.trim();
  if (!base) throw new PipelineWorkerError("AUDIO_EXTRACTOR_UNAVAILABLE", "No FFmpeg extraction service is configured", true);
  const endpoint = serviceUrl(base, "", "FFMPEG_WORKER");
  const outputKey = `${job.data.projectId}/audio/extracted.wav`;
  const result = await requestJson(`${endpoint}/extract-audio`, {
    method: "POST",
    headers: requestHeaders({ "content-type": "application/json", accept: "application/json" }),
    body: JSON.stringify({
      bucket: job.data.bucket,
      source_key: job.data.assetKey,
      project_id: job.data.projectId,
      job_id: String(job.id),
    }),
  }, "AUDIO_EXTRACTOR_UNAVAILABLE");
  if (result.project_id !== job.data.projectId || result.job_id !== String(job.id) || result.audio_key !== outputKey) {
    throw new PipelineWorkerError("AUDIO_EXTRACTOR_INVALID_RESULT", "FFmpeg worker returned mismatched extraction identifiers or output key", true);
  }
  let metadata;
  try {
    metadata = await privateStorageClient().send(new HeadObjectCommand({ Bucket: job.data.bucket, Key: outputKey }));
  } catch {
    throw new PipelineWorkerError("AUDIO_ARTIFACT_UNAVAILABLE", "FFmpeg output is not available in private storage", true);
  }
  const duration = Number(result.duration);
  const fileSize = Number(metadata.ContentLength);
  const reportedFileSize = Number(result.file_size);
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isSafeInteger(fileSize) || fileSize <= 0 ||
      !Number.isSafeInteger(reportedFileSize) || reportedFileSize !== fileSize) {
    throw new PipelineWorkerError("AUDIO_EXTRACTOR_INVALID_RESULT", "FFmpeg worker metadata does not match the stored audio artifact", true);
  }
  if (result.format !== "wav" || Number(result.sample_rate) !== 16_000 || Number(result.channels) !== 1) {
    throw new PipelineWorkerError("AUDIO_EXTRACTOR_INVALID_FORMAT", "Audio artifact must be mono 16 kHz WAV", false);
  }
  if (fileSize > 2_147_483_647) {
    throw new PipelineWorkerError("AUDIO_ARTIFACT_TOO_LARGE", "Extracted audio exceeds the supported metadata size", false);
  }
  try {
    const prefix = await privateStorageClient().send(new GetObjectCommand({ Bucket: job.data.bucket, Key: outputKey, Range: "bytes=0-11" }));
    const bytes = Buffer.from(await prefix.Body.transformToByteArray());
    if (bytes.length < 12 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") {
      throw new PipelineWorkerError("AUDIO_EXTRACTOR_INVALID_FORMAT", "Extracted artifact is not a WAV file", false);
    }
  } catch (error) {
    if (error instanceof PipelineWorkerError) throw error;
    throw new PipelineWorkerError("AUDIO_ARTIFACT_UNAVAILABLE", "Unable to verify extracted audio", true);
  }
  return {
    executionMode: "production",
    audioKey: outputKey,
    duration,
    fileSize,
    format: "wav",
    sampleRate: 16_000,
    channels: 1,
  };
}

async function getAsrAudio(audioBucket, audioKey) {
  let head;
  try {
    head = await privateStorageClient().send(new HeadObjectCommand({ Bucket: audioBucket, Key: audioKey }));
  } catch {
    throw new PipelineWorkerError("ASR_AUDIO_UNAVAILABLE", "Extracted audio is not available in private storage", true);
  }
  const length = Number(head.ContentLength);
  if (!Number.isSafeInteger(length) || length <= 0) {
    throw new PipelineWorkerError("ASR_AUDIO_INVALID", "Extracted audio has no valid size", false);
  }
  if (length > MAX_ASR_AUDIO_BYTES) {
    throw new PipelineWorkerError("ASR_INPUT_TOO_LARGE", "Extracted audio exceeds the configured ASR memory limit", false);
  }
  try {
    const result = await privateStorageClient().send(new GetObjectCommand({ Bucket: audioBucket, Key: audioKey }));
    return Buffer.from(await result.Body.transformToByteArray());
  } catch {
    throw new PipelineWorkerError("ASR_AUDIO_UNAVAILABLE", "Extracted audio could not be read from private storage", true);
  }
}

async function assertAsrReady() {
  const endpoint = serviceUrl(process.env.ASR_WORKER_URL, "http://asr-worker:8001", "ASR_WORKER");
  const readiness = await requestJson(`${endpoint}/ready`, { method: "GET", headers: { accept: "application/json" } }, "NARA_MODEL_UNAVAILABLE");
  if (readiness.ready !== true || readiness.model_loaded !== true) {
    throw new PipelineWorkerError("NARA_MODEL_UNAVAILABLE", "Nara SAR model is not ready", true);
  }
  return endpoint;
}

async function runAsr(job) {
  const endpoint = await assertAsrReady();
  const audio = await prisma.audioExtraction.findUnique({ where: { projectId: job.data.projectId } });
  if (!audio || audio.status !== "COMPLETED") {
    throw new PipelineWorkerError("ASR_AUDIO_EXTRACTION_MISSING", "Completed audio extraction is unavailable", true);
  }
  const bytes = await getAsrAudio(job.data.bucket, audio.audioKey);
  const form = new FormData();
  form.set("file", new File([bytes], "source.wav", { type: "audio/wav" }));
  form.set("language", "my");
  // Nara SAR's released runner returns transcript text but has no timestamp decoder.
  form.set("return_timestamps", "false");
  const result = await requestJson(`${endpoint}/transcribe/file`, {
    method: "POST",
    headers: requestHeaders({ accept: "application/json" }),
    body: form,
  }, "NARA_INFERENCE_UNAVAILABLE");
  const fullText = typeof result.text === "string" ? result.text.trim() : "";
  if (/^\[mock transcription\b/i.test(fullText)) {
    throw new PipelineWorkerError("NARA_INFERENCE_NOT_IMPLEMENTED", "ASR worker returned its placeholder transcription", true);
  }
  if (!fullText) throw new PipelineWorkerError("NARA_RESULT_INVALID", "ASR worker returned no transcript", true);
  const rawSegments = Array.isArray(result.segments) ? result.segments : [];
  const segments = rawSegments.map((segment) => ({
    start: Number(segment.start ?? segment.start_time ?? segment.startTime),
    end: Number(segment.end ?? segment.end_time ?? segment.endTime),
    text: String(segment.text ?? "").trim(),
    ...(Number.isFinite(Number(segment.confidence)) ? { confidence: Number(segment.confidence) } : {}),
    ...(typeof segment.speaker === "string" ? { speaker: segment.speaker } : {}),
  }));
  if (segments.some((segment) => !Number.isFinite(segment.start) || !Number.isFinite(segment.end) || !segment.text)) {
    throw new PipelineWorkerError("NARA_RESULT_INVALID", "ASR worker returned invalid transcript segments", true);
  }
  return {
    executionMode: "production",
    fullText,
    language: typeof result.language === "string" ? result.language : "my",
    modelVersion: process.env.NARA_MODEL_VERSION?.trim() || "nara-sar-v1",
    segments,
  };
}

async function assertGeminiReady() {
  const endpoint = serviceUrl(process.env.AI_WORKER_URL, "http://ai-worker:8003", "AI_WORKER");
  const readiness = await requestJson(`${endpoint}/ready`, { method: "GET", headers: { accept: "application/json" } }, "AI_PROVIDER_UNAVAILABLE");
  if (readiness.ready !== true || readiness.default_provider !== "gemini" || readiness.gemini_configured !== true) {
    throw new PipelineWorkerError("AI_PROVIDER_UNAVAILABLE", "A configured Gemini provider is required; no AI request was sent", true);
  }
  return endpoint;
}

async function runUnderstand(job) {
  const endpoint = await assertGeminiReady();
  const transcript = await prisma.transcription.findUnique({ where: { projectId: job.data.projectId } });
  if (!transcript || transcript.status !== "COMPLETED") {
    throw new PipelineWorkerError("TRANSCRIPT_UNAVAILABLE", "Completed transcription is unavailable", true);
  }
  const result = await requestJson(`${endpoint}/analyze`, {
    method: "POST",
    headers: requestHeaders({ "content-type": "application/json", accept: "application/json" }),
    body: JSON.stringify({ transcript: transcript.fullText, language: transcript.language, include_characters: true, include_key_scenes: false }),
  }, "AI_ANALYSIS_UNAVAILABLE");
  if (result.plot_summary === "A story about..." || result.characters?.some((character) => character.name === "Protagonist")) {
    throw new PipelineWorkerError("AI_ANALYSIS_MOCK_RESULT", "AI worker returned its placeholder analysis", true);
  }
  return {
    executionMode: "production",
    genre: result.genre,
    themes: result.themes,
    characters: (result.characters ?? []).map((character) => ({
      name: character.name,
      description: character.description ?? undefined,
      // The text model sees no video frames; screen-time claims are not persisted.
      importance: character.importance ?? 1,
    })),
    plotSummary: result.plot_summary,
    // No visual/timestamp alignment service exists; do not surface inferred scene timing.
    keyScenes: [],
    mood: result.mood,
    tone: result.tone,
    modelProvider: "gemini",
    modelVersion: process.env.GEMINI_MODEL_VERSION?.trim() || process.env.GEMINI_MODEL?.trim() || "gemini-3.8-flash",
  };
}

async function runRecap(job) {
  const endpoint = await assertGeminiReady();
  const [transcript, analysis] = await Promise.all([
    prisma.transcription.findUnique({ where: { projectId: job.data.projectId } }),
    prisma.movieAnalysis.findUnique({
      where: { projectId: job.data.projectId },
      include: { characters: true, keyScenes: true },
    }),
  ]);
  if (!transcript || transcript.status !== "COMPLETED" || !analysis || analysis.status !== "COMPLETED") {
    throw new PipelineWorkerError("AI_PREREQUISITE_UNAVAILABLE", "Completed transcript and analysis are required for recap generation", true);
  }
  const result = await requestJson(`${endpoint}/recap`, {
    method: "POST",
    headers: requestHeaders({ "content-type": "application/json", accept: "application/json" }),
    body: JSON.stringify({
      transcript: transcript.fullText,
      analysis: {
        genre: analysis.genre,
        themes: analysis.themes,
        characters: analysis.characters.map((character) => ({
          name: character.name, description: character.description,
          screen_time: character.screenTime, importance: character.importance,
        })),
        plot_summary: analysis.plotSummary,
        key_scenes: analysis.keyScenes.map((scene) => ({
          start_time: scene.startTime, end_time: scene.endTime,
          description: scene.description, importance: scene.importance,
        })),
        mood: analysis.mood,
        tone: analysis.tone,
      },
      style: "cinematic",
      target_length: 300,
      language: transcript.language,
    }),
  }, "AI_RECAP_UNAVAILABLE");
  if (/mock recap script/i.test(result.content ?? "") || result.segments?.some((segment) => /mock segment/i.test(segment.text ?? ""))) {
    throw new PipelineWorkerError("AI_RECAP_MOCK_RESULT", "AI worker returned its placeholder recap", true);
  }
  const segments = (result.segments ?? []).map((segment) => ({
    order: Number(segment.order), text: String(segment.text ?? "").trim(),
    voiceId: segment.voice_id ?? undefined, notes: segment.notes ?? undefined,
  }));
  if (!segments.length || segments.some((segment) => !segment.text || !Number.isSafeInteger(segment.order))) {
    throw new PipelineWorkerError("AI_RECAP_RESULT_INVALID", "Gemini returned no usable recap segments", true);
  }
  return {
    executionMode: "production",
    content: result.content,
    segments,
    style: String(result.style ?? "cinematic").toUpperCase(),
    targetLength: Number(result.target_length ?? 300),
    language: result.language ?? transcript.language,
    modelProvider: "gemini",
  };
}

async function assertTtsReady(voice) {
  const endpoint = serviceUrl(process.env.TTS_WORKER_URL, "http://tts-worker:8006", "TTS_WORKER");
  const readiness = await requestJson(`${endpoint}/ready`, { method: "GET", headers: { accept: "application/json" } }, "NARA_TTS_UNAVAILABLE");
  if (readiness.ready !== true || !Array.isArray(readiness.available_voices) || !readiness.available_voices.includes(voice)) {
    throw new PipelineWorkerError("NARA_TTS_UNAVAILABLE", "Configured Nara Mini voice is not ready", true);
  }
  return endpoint;
}

async function synthesizeChunk(endpoint, text, voice, language) {
  const response = await requestJson(`${endpoint}/synthesize`, {
    method: "POST",
    headers: requestHeaders({ "content-type": "application/json", accept: "application/json" }),
    body: JSON.stringify({ text, voice, language: language === "my" ? "my" : "my+en", normalize_numbers: true }),
  }, "NARA_TTS_INFERENCE_UNAVAILABLE");
  if (response.voice !== voice || Number(response.sample_rate) !== 24_000 || typeof response.audio_base64 !== "string" || response.audio_base64.length > 360_000_000) {
    throw new PipelineWorkerError("NARA_TTS_RESULT_INVALID", "Nara Mini returned invalid voice or audio metadata", true);
  }
  let wav;
  try { wav = Buffer.from(response.audio_base64, "base64"); parseNaraWav(wav); }
  catch { throw new PipelineWorkerError("NARA_TTS_RESULT_INVALID", "Nara Mini did not return valid mono 24 kHz PCM16 WAV audio", true); }
  if (wav.toString("base64") !== response.audio_base64.replace(/=+$/, "") && wav.toString("base64").replace(/=+$/, "") !== response.audio_base64.replace(/=+$/, "")) {
    throw new PipelineWorkerError("NARA_TTS_RESULT_INVALID", "Nara Mini returned malformed base64 audio", false);
  }
  return wav;
}

async function runNarrate(job) {
  const voice = process.env.NARA_TTS_VOICE?.trim() || "shoon";
  const endpoint = await assertTtsReady(voice);
  const script = await prisma.recapScript.findUnique({
    where: { projectId: job.data.projectId }, include: { segments: { orderBy: { order: "asc" } } },
  });
  if (!script || script.status === "REGENERATING" || !script.segments.length) {
    throw new PipelineWorkerError("RECAP_SCRIPT_UNAVAILABLE", "A persisted recap script with ordered segments is required", true);
  }
  const audioBuffers = [];
  const segments = [];
  let order = 0;
  for (const scriptSegment of script.segments) {
    // Stay below the worker's internal 200-character phonemizer chunk limit.
    for (const text of splitNarrationText(scriptSegment.text, 180)) {
      const wav = await synthesizeChunk(endpoint, text, voice, script.language);
      const { duration } = parseNaraWav(wav);
      const audioKey = `${job.data.projectId}/narration/${job.data.runId}/${String(order).padStart(5, "0")}.wav`;
      await privateStorageClient().send(new PutObjectCommand({ Bucket: job.data.bucket, Key: audioKey, Body: wav, ContentType: "audio/wav" }));
      const head = await privateStorageClient().send(new HeadObjectCommand({ Bucket: job.data.bucket, Key: audioKey }));
      if (Number(head.ContentLength) !== wav.length) throw new PipelineWorkerError("NARRATION_ARTIFACT_INVALID", "Stored narration segment size did not verify", true);
      audioBuffers.push(wav);
      segments.push({ order, scriptSegmentId: scriptSegment.id, text, audioKey, duration, voiceId: voice });
      order += 1;
      if (segments.length > 10_000) throw new PipelineWorkerError("NARRATION_TOO_LARGE", "Narration exceeds the supported segment count", false);
    }
  }
  const combined = combineNaraWavs(audioBuffers);
  if (combined.wav.length > MAX_NARRATION_AUDIO_BYTES) throw new PipelineWorkerError("NARRATION_TOO_LARGE", "Combined narration exceeds the configured artifact limit", false);
  const audioKey = `${job.data.projectId}/narration/${job.data.runId}/combined.wav`;
  await privateStorageClient().send(new PutObjectCommand({ Bucket: job.data.bucket, Key: audioKey, Body: combined.wav, ContentType: "audio/wav" }));
  const head = await privateStorageClient().send(new HeadObjectCommand({ Bucket: job.data.bucket, Key: audioKey }));
  if (Number(head.ContentLength) !== combined.wav.length) throw new PipelineWorkerError("NARRATION_ARTIFACT_INVALID", "Stored combined narration size did not verify", true);
  return { executionMode: "production", audioKey, totalDuration: combined.duration, voicePreset: voice, segments };
}

async function runSubtitle(job) {
  const narration = await prisma.narration.findUnique({
    where: { projectId: job.data.projectId }, include: { segments: { orderBy: { order: "asc" } } },
  });
  if (!narration || narration.status !== "COMPLETED" || !narration.segments.length ||
      narration.segments.some((segment) => !segment.audioKey?.startsWith(`${job.data.projectId}/narration/`))) {
    throw new PipelineWorkerError("NARRATION_UNAVAILABLE", "Completed measured narration is required before subtitle generation", true);
  }
  const built = buildMeasuredSrt(narration.segments.map((segment) => ({ text: segment.text, duration: segment.duration })));
  const contentBytes = Buffer.from(built.content, "utf8");
  if (contentBytes.length > 1_000_000) throw new PipelineWorkerError("SUBTITLE_TOO_LARGE", "Subtitle artifact exceeds the supported size", false);
  const subtitleKey = `${job.data.projectId}/subtitles/${job.data.runId}/my.srt`;
  await privateStorageClient().send(new PutObjectCommand({ Bucket: job.data.bucket, Key: subtitleKey, Body: contentBytes, ContentType: "application/x-subrip; charset=utf-8" }));
  const head = await privateStorageClient().send(new HeadObjectCommand({ Bucket: job.data.bucket, Key: subtitleKey }));
  if (Number(head.ContentLength) !== contentBytes.length) throw new PipelineWorkerError("SUBTITLE_ARTIFACT_INVALID", "Stored subtitle size did not verify", true);
  return { executionMode: "production", subtitleKey, content: built.content, language: "my", format: "SRT", duration: built.duration };
}

async function runRender(job) {
  const workerBucket = requireEnv(process.env.S3_BUCKET, "OBJECT_STORAGE_UNAVAILABLE", "S3 bucket is not configured");
  if (workerBucket !== job.data.bucket) throw new PipelineWorkerError("OBJECT_STORAGE_BUCKET_MISMATCH", "Render worker and pipeline bucket configuration do not match", false);
  const [narration, subtitle, readiness] = await Promise.all([
    prisma.narration.findUnique({ where: { projectId: job.data.projectId }, include: { segments: { orderBy: { order: "asc" } } } }),
    prisma.subtitle.findFirst({ where: { projectId: job.data.projectId, status: "COMPLETED", key: `${job.data.projectId}/subtitles/${job.data.runId}/my.srt` } }),
    (async () => {
      const endpoint = serviceUrl(process.env.FFMPEG_WORKER_URL, "http://render-worker:8004", "RENDER_WORKER");
      const ready = await requestJson(`${endpoint}/ready`, { method: "GET", headers: { accept: "application/json" } }, "RENDER_WORKER_UNAVAILABLE");
      if (ready.ready !== true || ready.ffmpeg_available !== true || ready.ffprobe_available !== true) throw new PipelineWorkerError("RENDER_WORKER_UNAVAILABLE", "FFmpeg/ffprobe render worker is not ready", true);
      return endpoint;
    })(),
  ]);
  if (!narration || narration.status !== "COMPLETED" || !narration.segments.length ||
      narration.segments.some((segment) => !segment.audioKey?.startsWith(`${job.data.projectId}/narration/`)) ||
      !subtitle?.key?.startsWith(`${job.data.projectId}/subtitles/`)) {
    throw new PipelineWorkerError("MEDIA_INPUTS_UNAVAILABLE", "Completed narration and subtitles are required before rendering", true);
  }
  const firstAudioKey = narration.segments[0].audioKey;
  const narrationRun = firstAudioKey.split("/")[2];
  if (!narrationRun || narration.segments.some((segment) => segment.audioKey.split("/")[2] !== narrationRun)) {
    throw new PipelineWorkerError("MEDIA_INPUTS_INVALID", "Persisted narration segments do not share one generated run", false);
  }
  const outputKey = `${job.data.projectId}/renders/${job.data.runId}/final.mp4`;
  const result = await requestJson(`${readiness}/render`, {
    method: "POST",
    headers: requestHeaders({ "content-type": "application/json", accept: "application/json" }),
    body: JSON.stringify({
      project_id: job.data.projectId, video_key: job.data.assetKey,
      audio_key: `${job.data.projectId}/narration/${narrationRun}/combined.wav`,
      subtitle_key: subtitle.key, output_key: outputKey, resolution: "1080p", fps: 30, codec: "libx264", preset: "medium",
    }),
  }, "VIDEO_RENDER_FAILED");
  if (result.project_id !== job.data.projectId || result.output_key !== outputKey || result.status !== "completed" ||
      !Number.isFinite(Number(result.duration)) || Number(result.duration) <= 0 || !Number.isSafeInteger(Number(result.file_size)) || Number(result.file_size) <= 0) {
    throw new PipelineWorkerError("VIDEO_RENDER_RESULT_INVALID", "Render worker returned incomplete or mismatched output metadata", true);
  }
  const head = await privateStorageClient().send(new HeadObjectCommand({ Bucket: job.data.bucket, Key: outputKey }));
  if (Number(head.ContentLength) !== Number(result.file_size)) throw new PipelineWorkerError("VIDEO_RENDER_RESULT_INVALID", "Rendered MP4 size does not match private storage", true);
  const prefix = await privateStorageClient().send(new GetObjectCommand({ Bucket: job.data.bucket, Key: outputKey, Range: "bytes=0-31" }));
  const header = Buffer.from(await prefix.Body.transformToByteArray());
  if (header.length < 12 || header.toString("ascii", 4, 8) !== "ftyp") throw new PipelineWorkerError("VIDEO_RENDER_RESULT_INVALID", "Rendered output does not have an MP4 ftyp signature", false);
  return { executionMode: "production", outputKey, duration: Number(result.duration), fileSize: Number(result.file_size), resolution: "1080p", fps: 30, codec: "h264" };
}

async function runStage(job) {
  if (!job?.id || !job.data?.projectId || !job.data?.ownerId || !job.data?.assetId) {
    throw new PipelineWorkerError("PIPELINE_JOB_INVALID", "Pipeline job is missing required identifiers", false);
  }
  await assertAssetStillEligible(job.data);
  if (job.name === "audio-extract") return callAudioExtractor(job);
  if (job.name === "asr") return runAsr(job);
  if (job.name === "understand") return runUnderstand(job);
  if (job.name === "recap") return runRecap(job);
  if (job.name === "narrate") return runNarrate(job);
  if (job.name === "subtitle") return runSubtitle(job);
  if (job.name === "render") return runRender(job);
  throw new PipelineWorkerError("PIPELINE_STAGE_UNSUPPORTED", "Pipeline stage is unsupported", false);
}

const workers = QUEUES.map((queueName) => new Worker(queueName, async (job) => {
  await notifyApi(String(job.id), { event: "started", attemptsMade: job.attemptsMade });
  try {
    await notifyApi(String(job.id), { event: "progress", progress: 5 });
    const result = await runStage(job);
    await notifyApi(String(job.id), { event: "progress", progress: 90 });
    await notifyApi(String(job.id), { event: "completed", result });
    return { completed: true };
  } catch (error) {
    const failure = error instanceof PipelineWorkerError
      ? error
      : new PipelineWorkerError("PIPELINE_WORKER_FAILED", "Pipeline stage failed unexpectedly", true);
    if (!failure.retryable) {
      await notifyApi(String(job.id), { event: "failed", code: failure.code });
      throw new UnrecoverableError(failure.message);
    }
    throw failure;
  }
}, {
  connection: redis,
  prefix: QUEUE_PREFIX,
  concurrency: Number(process.env.PIPELINE_WORKER_CONCURRENCY ?? 1),
}));

for (const worker of workers) {
  worker.on("failed", (job, error) => {
    if (!job) return;
    const attempts = Number(job.opts.attempts ?? 1);
    if (job.attemptsMade < attempts || error instanceof UnrecoverableError) return;
    const code = error instanceof PipelineWorkerError ? error.code : "PIPELINE_WORKER_FAILED";
    notifyApi(String(job.id), { event: "failed", code }).catch(() => {
      console.error("Unable to report terminal pipeline failure", { jobId: job.id, code });
    });
  });
  worker.on("error", (error) => {
    console.error("Pipeline queue worker error", { name: error.name, code: "QUEUE_WORKER_ERROR" });
  });
}

console.info("Pipeline consumers started", { queues: QUEUES, prefix: QUEUE_PREFIX });

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.info("Shutting down pipeline consumers", { signal });
  await Promise.all(workers.map((worker) => worker.close()));
  await Promise.all([redis.quit(), prisma.$disconnect(), s3?.destroy()]);
}

process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
process.once("SIGINT", () => { void shutdown("SIGINT"); });

process.on("unhandledRejection", (error) => {
  const message = error instanceof Error ? error.message : "Unknown unhandled rejection";
  console.error("Pipeline consumer unhandled rejection", { message, digest: createHash("sha256").update(message).digest("hex").slice(0, 12) });
});
