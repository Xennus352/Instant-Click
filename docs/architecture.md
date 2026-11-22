# InstantCap architecture

This document describes the architecture represented in this repository. A service being present in source or Compose does not mean its external configuration or readiness has been verified.

## Runtime components

- **Web application and API:** `services/nextjs` contains the Next.js App Router UI, API route handlers, Better Auth integration, Prisma client, and the BullMQ pipeline consumer.
- **Persistence and queueing:** MongoDB is the application database, Redis backs BullMQ, and MinIO provides local S3-compatible object storage. The development Compose configuration supplies the local services and named data volumes.
- **Speech recognition:** `services/asr-worker` calls the Nara SAR inference runner. Its model files are downloaded separately into `model_cache`.
- **Narration:** `services/tts-worker` uses Nara Mini v1 and its available voice assets, also stored outside the source tree.
- **Text generation:** `services/ai-worker` uses Gemini for movie analysis and recap text. Gemini access is checked by worker readiness; a configured model name alone does not establish that requests will work.
- **Audio and video processing:** the pipeline consumer coordinates the render worker for audio extraction and final video rendering. Generated output is saved to private object storage before the API reports it as complete.

## Request and data flow

The browser communicates with Next.js API routes and uploads source bytes directly to private S3-compatible storage through short-lived presigned URLs. The API owns authentication, authorization, project state, database access, and job creation. Python workers do not access MongoDB directly; the pipeline consumer dispatches work through Redis/BullMQ and accepts validated internal callbacks.

The seven durable stages are `audio-extract`, `asr`, `understand`, `recap`, `narrate`, `subtitle`, and `render`. The API persists stage state and returns it to the browser through the pipeline status endpoint. Results appear only after their records are persisted.

## Readiness gates and limits

- Pipeline start requires an owned project with a verified, scan-clean source. This repository has no malware scanner implementation; an external scanner must set the required clean/ready state and verification timestamps.
- Analysis and recap generation require the configured Gemini model to pass the worker readiness check.
- Nara SAR and Nara Mini require their model artifacts to be present and loadable. Downloaded weights are not part of the Git source tree.
- The code and route contracts do not prove that live inference, storage, scanning, or rendering is available in a particular environment. Check the relevant readiness endpoints and API responses before describing a run as operational.

## Development and release boundary

Use `docker-compose.yml` with `docker-compose.dev.yml` for local development. Copy `.env.example` to `.env.dev`, replace its placeholders, and pass that file with Docker Compose's `--env-file`. Keep local environment files, downloaded models, uploads, media, and database artifacts out of Git.

The GitHub Actions workflow runs checks and builds containers. A push to `main` also publishes production container images to GHCR. The current staging job is only a placeholder message; no application deployment or Vercel workflow is configured in this repository.

## Related contracts

- [Project upload API](project-upload-api.md)
- [AI pipeline and worker API](ai-pipeline-api.md)
- [Admin API](admin-api.md)
- [Billing API](billing-api.md)
- [Dinger payment notes](dinger-payments.md)
