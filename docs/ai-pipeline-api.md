# AI pipeline API and worker contract

All browser API routes require a verified Better Auth session and scope project access to the authenticated user's `MovieProject.userId`. Mutating routes require an `Idempotency-Key` header (8–128 URL-safe characters). Responses use `{ data }` or the shared `{ error: { code, message, details? } }` envelope and `Cache-Control: private, no-store`.

## Start, status, and retry

### `POST /api/v1/projects/{projectId}/pipeline`

No request body. The durable stage chain includes Nara Mini narration, measured-duration SRT subtitles, and FFmpeg render. Start still requires a verified, scan-clean asset and real Gemini readiness; requests remain blocked when Gemini reports Myanmar as unsupported. No project or entitlement changes occur before provider readiness succeeds. The free-recap campaign count is admin-configurable from 0–20. A user's wallet snapshots the count on first grant; later edits affect new wallets only. The free reservation is captured in the same MongoDB transaction that persists a verified final render and private gallery entry. Failures release it. Paid checkout/credit settlement remains unavailable.

To create the default enabled campaign (initial count two) on a deliberately selected database, first run `npm run bootstrap:free-recaps` from `services/nextjs` for a read-only dry run, then `npm run bootstrap:free-recaps -- --apply`. It creates the campaign only when absent and preserves any existing valid admin-edited count (0–20). For `NODE_ENV=production`, also pass `--confirm-production`. Application startup never seeds campaign data. Per-user wallets and grants are not bulk-backfilled: the first eligible reservation creates the wallet and grant event atomically. Bootstrap was not run during this work.

Legacy users with null/missing `accountStatus` are denied by the fail-closed session gate. Review the read-only `npm run backfill:account-status` count, take and verify a backup, and apply `npm run backfill:account-status -- --apply` only after explicit operator approval; production also requires `--confirm-production`. Apply this before deploying the fail-closed gate to avoid locking out legacy users. It updates only null/missing statuses and is idempotent.

```json
{
  "data": {
    "runId": "pipeline_<projectId>_<digest>",
    "status": "WAITING",
    "currentStage": "audio-extract",
    "job": {
      "jobId": "pipeline_<projectId>_<digest>_audio-extract",
      "stage": "audio-extract",
      "status": "WAITING",
      "progress": 0,
      "attemptsMade": 0,
      "createdAt": "<ISO-8601>",
      "processedOn": null,
      "finishedOn": null,
      "failureCode": null
    }
  }
}
```

Start is accepted only when the project belongs to the caller, is still `UPLOADED`, and has a `MovieAsset` with `status=READY`, `scanStatus=CLEAN`, `verifiedAt`, `sizeVerifiedAt`, `checksumVerifiedAt`, and `signatureVerifiedAt`. Quarantined, unscanned, failed, or otherwise unverified assets are rejected with `ASSET_NOT_READY`. Current upload completion sets `QUARANTINED`/`NOT_CONFIGURED`; a scanner must mark an asset clean and ready before this endpoint can run. Repeating start while a run is processing returns or re-enqueues its existing waiting stage; the deterministic BullMQ `jobId` prevents duplicate logical work.

When the final-media gate is resolved, the API must verify `GET {AI_WORKER_URL}/ready` (default `http://ai-worker:8003/ready`) and require real Gemini model access before creating or retrying jobs. The worker now classifies Google `FAILED_PRECONDITION` location/region failures as `GEMINI_LOCATION_UNSUPPORTED`. The backend has no Vertex AI/Gemini Enterprise adapter. No LLM call is made by the Next.js API.

### `GET /api/v1/projects/{projectId}/pipeline`

Returns the caller's latest run, `projectStatus`, `currentStage`, and stage job views. The stage view above is also exported as `PipelineJobView` and `PipelineStatusResponse` from `src/lib/schemas/pipeline.ts`. Clients can poll this endpoint; no browser-to-worker or WebSocket connection is used.

### `GET /api/v1/projects/{projectId}/pipeline/results`

Returns persisted inference artifacts for the caller's project, independently of the polling status response:

```json
{
  "data": {
    "projectId": "<projectId>",
    "transcription": null,
    "analysis": null,
    "recapScript": null
  }
}
```

Each artifact remains `null` until it has been written (transcription and analysis are exposed only when `COMPLETED`). Present objects contain the Prisma-backed fields requested by the client contract. Segments and nested entities are ordered, only selected content fields are returned, and the response excludes storage keys and BigInt values. The response type is `PipelineResultsResponse` in `src/lib/schemas/pipeline.ts`.

### `POST /api/v1/projects/{projectId}/pipeline/retry`

Requires header and JSON body `{}`. Retries only the failed stage of the latest failed run under a new idempotent run ID; already completed stage records/artifacts remain in place. Queue jobs use four attempts with exponential backoff starting at five seconds. A terminal `failed` worker event is sent only after those attempts are exhausted.

## Durable handoff and stage progression

Each stage is first recorded in MongoDB `JobRecord` with `projectId`, `queueName`, deterministic `jobId`, stage name, run/owner/project/asset IDs, and `WAITING` status. Only after that transaction commits does the API add the job to BullMQ. A Redis handoff failure leaves the durable record `WAITING`; repeating start/retry safely reuses that record and queue job ID. Starting again while project status is already processing also re-enqueues its existing waiting stage instead of creating a second run. Stage completion commits its domain record, terminal job status, project status, and the next `WAITING` stage record in one MongoDB transaction; the next BullMQ add happens after commit. Thus queue loss can be repaired without duplicate stage records. Automatic outbox draining/reconciliation is not part of this API-only scope.

BullMQ queue names and job names are `audio-extract`, `asr`, `understand`, `recap`, `narrate`, `subtitle`, and `render`. Job payloads carry `runId`, `stage`, `projectId`, `ownerId`, `assetId`, storage bucket/key, and a digest of the idempotency key. Do not expose queue payloads or storage keys to browser clients. Stage completion persists the corresponding Prisma record and creates the next durable `JobRecord` in the same transaction. Only the render callback may set project `COMPLETED` and capture the free reservation.

### Running the queue consumers

Run `npm run worker:pipeline` from `services/nextjs` as a separate long-running Node process (Node 20+). It consumes all seven queues with the `instantcap` BullMQ prefix, checks asset eligibility before every stage, and reports lifecycle events to the internal callback. Configure `DATABASE_URL`, `REDIS_URL`, `INTERNAL_API_KEY` (at least 32 characters), `PIPELINE_API_URL`, `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_REGION`, `S3_FORCE_PATH_STYLE`, and private `S3_BUCKET`. Worker URLs: `FFMPEG_WORKER_URL` (default `http://render-worker:8004`), `ASR_WORKER_URL` (default `http://asr-worker:8001`), `TTS_WORKER_URL` (default `http://tts-worker:8002`), `AI_WORKER_URL` (default `http://ai-worker:8003`). `NARA_TTS_VOICE` selects a Nara Mini voice and defaults to `shoon`; set `MAX_ASR_AUDIO_BYTES`, `MAX_NARRATION_AUDIO_BYTES`, and `PIPELINE_WORKER_HTTP_TIMEOUT_MS` to bound artifact sizes and calls.

The render worker contract is `POST {FFMPEG_WORKER_URL}/extract-audio` with `X-Internal-Api-Key` and `{project_id,job_id,bucket,source_key}`. The worker reads the private source object, writes `{project_id}/audio/extracted.wav`, and returns `{project_id,job_id,audio_key,duration,file_size,format:"wav",sample_rate:16000,channels:1}`. Its response has no execution-mode marker; the trusted consumer emits the internal production marker only after the endpoint succeeds and storage checks pass. The consumer verifies the deterministic output key, returned size against S3 HEAD metadata, mono 16 kHz WAV metadata, and the RIFF/WAVE signature before reporting stage completion. Missing endpoint configuration or unavailable worker is retryable as `AUDIO_EXTRACTOR_UNAVAILABLE`.

ASR uses the released `YeeNyunn/nara-sar` ONNX runner through `/transcribe/file`; `/ready` is 503 until the model, decoder, tokenizer, and language model files are present. The request is bounded to `MAX_AUDIO_BYTES` (default 256 MiB). Nara SAR does not provide timestamps or a detected-language label: pipeline transcripts therefore have no segments and use the caller's language label. Gemini is the only text model (`GEMINI_MODEL`, default `gemini-3.8-flash`); readiness checks actual model access at Google, and missing/invalid credentials block processing. Groq has been removed. Analysis sees the transcript only (no video frames), so generated scene timestamps are discarded; this is not visual movie understanding. Worker-to-worker auth fails closed if `INTERNAL_API_KEY` is empty; configure the same random key of at least 32 characters for the API and workers.

The standalone TTS API is `POST http://tts-worker:8002/synthesize` with `{text, voice, language, normalize_numbers}` and `X-Internal-API-Key`; it returns base64 WAV at 24 kHz mono. Voices are `shoon`, `thazin`, `ko-banyar`, and `htet-myat`. Narration requests are bounded; WAV headers and PCM format are checked; chunk WAVs and a combined private audio track are persisted. SRT cue times are cumulative measured PCM durations, not ASR timestamps. FFmpeg uses the full uploaded video as its visual source, replaces its audio with Nara Mini narration, and burns in the generated SRT. It does not select or cut scenes, so no scene-alignment claim is made.

Model download and pinned SHA-256 verification: `scripts/download-nara-models.sh download-all` (or `download-sar` / `download-mini`), then `scripts/download-nara-models.sh verify`. Set `MODEL_CACHE_DIR` to the host directory mounted as `/models`. The script downloads only inference files and verifies against the checked-in digests copied from each repository's `SHA256SUMS`. Both repositories declare Apache-2.0; retain the downloaded `LICENSE`, `NOTICE`, and (for Nara SAR) third-party notices when redistributing. Model files are not included in this source tree and were not downloaded in this change.

Workers report lifecycle events to `POST /api/internal/pipeline/jobs/{jobId}` with `X-Internal-Api-Key` matching the configured internal service key:

- `{"event":"started","attemptsMade":0}`
- `{"event":"progress","progress":35}`
- `{"event":"failed","code":"WORKER_FAILED"}` after final retry only
- `{"event":"completed","result":{...}}` with the stage result below

The callback endpoint validates the job and result, persists each result into the existing Prisma models, and advances the pipeline. Repeated completion callbacks are idempotent. The stage result types and Zod validators are in `src/lib/schemas/pipeline.ts`.

### Worker result shapes

- `audio-extract`: `{ "executionMode":"production", "audioKey":"...", "duration":120.5, "fileSize":123456, "format":"wav", "sampleRate":16000, "channels":1 }`
- `asr`: `{ "executionMode":"production", "fullText":"...", "language":"my", "confidence":0.9, "modelVersion":"nara-sar-v1", "segments":[{"start":0,"end":2.1,"text":"..."}] }`
- `understand`: `{ "executionMode":"production", "genre":[], "themes":[], "characters":[], "plotSummary":"...", "keyScenes":[], "mood":"...", "tone":"...", "modelProvider":"gemini", "modelVersion":"..." }`
- `recap`: `{ "executionMode":"production", "content":"...", "segments":[], "style":"CINEMATIC", "targetLength":300, "language":"my", "modelProvider":"gemini" }`
- `narrate`: `{ "executionMode":"production", "audioKey":".../combined.wav", "totalDuration":45.2, "voicePreset":"shoon", "segments":[{"order":0,"scriptSegmentId":"...","text":"...","audioKey":".../00000.wav","duration":2.2,"voiceId":"shoon"}] }`
- `subtitle`: `{ "executionMode":"production", "subtitleKey":".../my.srt", "content":"1\\n00:00:00,000 --> ...", "language":"my", "format":"SRT", "duration":45.2 }`
- `render`: `{ "executionMode":"production", "outputKey":".../final.mp4", "duration":45.2, "fileSize":123456, "resolution":"1080p", "fps":30, "codec":"h264" }`

The internal event body is capped at 8 MiB. Result lengths and nested items have explicit Zod bounds. Completion events must use `executionMode=production`; current mock outputs are rejected unless a trusted worker adapter only emits that marker after real processing/inference. Worker input and all result writes must remain idempotent; audio extraction output keys must be server-generated/private keys owned by that worker pipeline.

## Errors and remaining integration

- `401 UNAUTHENTICATED`, `403 EMAIL_VERIFICATION_REQUIRED`, `404 PROJECT_NOT_FOUND`, `409 ASSET_NOT_READY` / `PIPELINE_ALREADY_STARTED` / `PIPELINE_NOT_FAILED`, `400 VALIDATION_ERROR`, `402 FREE_RECAPS_UNAVAILABLE`, and `503 GEMINI_LOCATION_UNSUPPORTED` / `PIPELINE_UNAVAILABLE` are returned through the common error envelope.
- No project schema migration is needed for this implementation; it uses `MovieProject`, clean `MovieAsset`, existing stage models, and `JobRecord.projectId`.
- The BullMQ consumer now includes Nara Mini narration, measured subtitle generation, and FFmpeg render callbacks. The API verifies the deterministic render destination, S3 size, MP4 `ftyp` signature, and streaming SHA-256 before one MongoDB transaction writes `VideoRender`, a private `GalleryEntry`, project completion, and free-entitlement capture. No external calls run inside that transaction.
- Sentinel must package `src/workers/pipeline-consumer.mjs` and its dependencies into a production worker runtime; the current Next.js standalone Docker runner does not copy source files. Compose/runtime wiring is outside this change.
- AI worker readiness calls the configured Gemini model endpoint and fails closed on missing key, invalid access, timeout, or model unavailability. Groq is not supported. Worker packaging and the external key/model configuration still need production verification.
- The transactional free-entitlement service records the admin-configurable count (0–20), grants a wallet snapshot lazily, and supports idempotent reserve/release/capture. Capture occurs only with successful verified MP4 persistence. Paid-credit settlement and provider-verified checkout remain absent; starts fail closed when free entitlements are exhausted.
- No end-to-end inference or real render was run. Gemini readiness is currently region-blocked, no clean-scan path is configured, production worker packaging/runtime has not been verified, and there is no scene-selection service. Requests therefore do not complete in the configured environment.
- No scanner is implemented here. Processing stays blocked until an external scanner sets all required verification timestamps, `scanStatus=CLEAN`, and `status=READY`.
