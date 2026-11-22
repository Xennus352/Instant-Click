# Project upload API

All routes require a Better Auth session and return `{ data: ... }` or the standard `{ error: { code, message, details? } }` envelope. `Idempotency-Key` is required for upload initialization. Browser uploads go directly to a short-lived presigned URL; browser code never receives storage credentials.

## Initialize and presign

`POST /api/v1/projects/uploads`

```json
{
  "title": "Movie title",
  "fileName": "movie.mp4",
  "contentType": "video/mp4",
  "fileSize": 123456789,
  "checksumSHA256": "optional-base64-sha256"
}
```

`checksumSHA256` is optional. On success, the API returns `{ data: { uploadId, uploadUrl, requiredHeaders, expiresAt } }`. The client PUTs the file bytes to `uploadUrl` and sends every returned required header. URL lifetime is 10 minutes (below the architecture's 15-minute ceiling); the server stores no presigned URL. The upload session lasts 24 hours. An idempotent retry with the same key and same fields renews the URL for the same quarantined object. Reusing a key with different fields returns a conflict.

Only MP4, QuickTime MOV, WebM, and Matroska MKV are accepted. Filename extension must match MIME type. The maximum upload is 2,147,483,647 bytes because `MovieProject.fileSize` is Int32; the MovieAsset size is persisted as BigInt and serialized as a decimal string.

## Complete

`POST /api/v1/projects/uploads/{uploadId}/complete`

The server scopes the upload session by the authenticated owner, verifies object HEAD size and MIME type, verifies SHA-256 from S3 or by streaming the object, and checks the container signature from the initial 1 KiB. It then copies the verified bytes to a stable private `movie-assets/{uploadId}.{extension}` key before committing the asset; the active browser PUT URL only targets the staging key, so it cannot overwrite the completed asset. Completion is idempotent. Missing objects return a retryable conflict; a size, MIME, checksum, or signature mismatch marks the session and asset failed.

Successful completion returns `{ data: { project } }`. The asset status is `QUARANTINED` and its scan status is `NOT_CONFIGURED`; this API does not mark malware scanning clean or release the asset. Processing services must require `MovieAsset.status=READY` and `scanStatus=CLEAN` before consuming the source. The project row has the existing `UPLOADED` enum during initialization, so readers must use the upload and asset statuses to determine readiness.

## Cancel

`DELETE /api/v1/projects/uploads/{uploadId}`

Only the owning user can cancel. The session and asset are marked aborted before the private object is deleted. Cancellation is idempotent. A previously issued presigned URL can remain valid until its short expiry, but an aborted session cannot complete; quarantine object lifecycle cleanup is needed to remove any object recreated during that short window.

## Read projects

`GET /api/v1/projects?cursor=<ObjectId>&limit=25` returns only caller-owned projects. The response uses cursor pagination and includes the latest safe asset/upload status, omitting bucket names, storage keys, and source URLs. BigInt asset sizes are returned as strings for JSON safety.

## Storage configuration and dependencies

Backend storage primitives are in `services/nextjs/src/lib/storage/s3.ts`; upload verification/orchestration is in `services/nextjs/src/services/MovieUploadService.ts`. Internal HEAD/GET/DELETE use `S3_ENDPOINT`. Browser presigning uses a separate client with `S3_PUBLIC_ENDPOINT` or `S3_PUBLIC_HOSTNAME`; the URL is signed for that public endpoint and must never be rewritten afterward. `S3_FORCE_PATH_STYLE` defaults to true for MinIO and can be set false for an external provider that requires virtual-hosted addressing. Production must configure a browser-reachable public endpoint/hostname.

Sentinel's current Compose configuration publishes MinIO as host port `19002` (container port `9000`), and its development override sets `S3_PUBLIC_ENDPOINT=http://localhost:19002`. The base `.env.example` still defaults to port `9000`; use the development override or keep the public endpoint aligned with the host port. These Compose changes are owned by Sentinel and were not changed in this backend task. The `/s3/` Nginx location strips its path prefix before forwarding and therefore cannot be used with ordinary presigned URLs without a SigV4-aware proxy.

No antivirus scanner is included. Assets remain quarantined (`scanStatus=NOT_CONFIGURED`) until scanner integration marks them clean and a separate processing gate releases them. A lifecycle rule or sweeper should remove expired/aborted quarantine objects. No schema change, migration, live database write, Compose change, or deployment was performed by this implementation.
