import {
  computeStoredObjectChecksumSHA256,
  createPresignedPutUrl,
  copyStoredObject,
  createFinalMovieObjectKey,
  createQuarantineObjectKey,
  deleteStoredObject,
  getS3BucketName,
  headStoredObject,
  readStoredObjectPrefix,
} from "@/lib/storage/s3";
import type { CreateProjectUploadInput } from "@/lib/schemas/projects";
import { MovieUploadSessionError, MovieUploadValidationError } from "@/lib/storage/errors";
import { MovieUploadRepository } from "@/repositories/MovieUploadRepository";
import { Prisma } from "@prisma/client";

const UPLOAD_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export async function prepareMovieUpload(input: CreateProjectUploadInput) {
  const extension = input.fileName.split(".").at(-1)?.toLowerCase();
  if (!extension) throw new MovieUploadValidationError("A supported video file extension is required");
  const objectKey = createQuarantineObjectKey(extension);
  const signedUpload = await createPresignedPutUrl({
    key: objectKey,
    contentType: input.contentType,
    contentLength: input.fileSize,
    checksumSHA256: input.checksumSHA256,
  });
  return { objectKey, ...signedUpload };
}

function detectVideoSignature(bytes: Uint8Array, contentType: string): { container: string; mimeType: string } | null {
  if (contentType === "video/mp4" || contentType === "video/quicktime") {
    if (bytes.length < 12 || String.fromCharCode(...bytes.slice(4, 8)) !== "ftyp") return null;
    const majorBrand = String.fromCharCode(...bytes.slice(8, 12));
    if (contentType === "video/quicktime" && majorBrand !== "qt  ") return null;
    if (contentType === "video/mp4" && majorBrand === "qt  ") return null;
    return { container: "iso-bmff", mimeType: contentType };
  }

  const isEbml = bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
  if (!isEbml) return null;
  const headerText = new TextDecoder("ascii").decode(bytes).toLowerCase();
  if (contentType === "video/webm" && headerText.includes("webm")) return { container: "webm", mimeType: "video/webm" };
  if (contentType === "video/x-matroska" && !headerText.includes("webm")) return { container: "matroska", mimeType: "video/x-matroska" };
  return null;
}

export async function validateUploadedMovieObject(input: {
  objectKey: string;
  expectedSize: number;
  expectedContentType: string;
  expectedChecksumSHA256?: string;
}) {
  const metadata = await headStoredObject(input.objectKey);
  if (metadata.contentLength !== input.expectedSize) {
    throw new MovieUploadValidationError("Uploaded file size does not match the declared size");
  }
  if (metadata.contentType !== input.expectedContentType) {
    throw new MovieUploadValidationError("Uploaded content type does not match the declared type");
  }
  const checksumSHA256 = metadata.checksumSHA256 ?? await computeStoredObjectChecksumSHA256(input.objectKey);
  if (input.expectedChecksumSHA256 && checksumSHA256 !== input.expectedChecksumSHA256) {
    throw new MovieUploadValidationError("Uploaded file checksum could not be verified");
  }

  const prefix = await readStoredObjectPrefix(input.objectKey, 1024);
  const signature = detectVideoSignature(prefix, input.expectedContentType);
  if (!signature) {
    throw new MovieUploadValidationError("Uploaded bytes do not match an allowed video format");
  }
  return { ...metadata, checksumSHA256, ...signature };
}

function uploadConflict(message: string, code = "UPLOAD_CONFLICT", status = 409): MovieUploadSessionError {
  return new MovieUploadSessionError(message, code, status);
}

function assertIdempotentUploadMatches(
  current: NonNullable<Awaited<ReturnType<typeof MovieUploadRepository.findByOwnerAndIdempotencyKey>>>,
  input: CreateProjectUploadInput,
) {
  if (
    current.project.title !== input.title ||
    current.asset.originalFilename !== input.fileName ||
    current.expectedContentType !== input.contentType ||
    current.expectedSizeBytes !== BigInt(input.fileSize) ||
    (current.expectedChecksum ?? undefined) !== input.checksumSHA256
  ) {
    throw uploadConflict("Idempotency-Key was already used for a different upload", "IDEMPOTENCY_KEY_REUSED");
  }
}

async function presignExistingUpload(current: NonNullable<Awaited<ReturnType<typeof MovieUploadRepository.findByOwnerAndIdempotencyKey>>>, ownerId: string) {
  if (["VERIFIED", "ABORTED", "FAILED", "EXPIRED"].includes(current.status)) {
    throw uploadConflict("This upload session is already finalized", "UPLOAD_SESSION_FINALIZED");
  }
  if (current.status === "COMPLETION_PENDING") {
    throw uploadConflict("Upload completion is already being verified", "UPLOAD_COMPLETION_PENDING");
  }
  if (current.expiresAt.getTime() <= Date.now()) {
    const expired = await MovieUploadRepository.markExpired(current.id, ownerId, current.asset.id);
    if (!expired) throw uploadConflict("Upload session changed while expiring", "UPLOAD_STATE_CONFLICT");
    await deleteStoredObject(current.asset.storageKey);
    throw uploadConflict("Upload session has expired", "UPLOAD_SESSION_EXPIRED", 410);
  }

  const signed = await createPresignedPutUrl({
    key: current.asset.storageKey,
    contentType: current.expectedContentType,
    contentLength: Number(current.expectedSizeBytes),
    checksumSHA256: current.expectedChecksum ?? undefined,
  });
  const updated = await MovieUploadRepository.updatePresignedExpiry(current.id, ownerId, signed.expiresAt);
  if (updated.count !== 1) throw uploadConflict("Upload session changed while renewing its URL");
  return { uploadId: current.id, uploadUrl: signed.url, requiredHeaders: signed.requiredHeaders, expiresAt: signed.expiresAt };
}

export async function createMovieUploadSession(input: {
  ownerId: string;
  idempotencyKey: string;
  upload: CreateProjectUploadInput;
}) {
  const existing = await MovieUploadRepository.findByOwnerAndIdempotencyKey(input.ownerId, input.idempotencyKey);
  if (existing) {
    assertIdempotentUploadMatches(existing, input.upload);
    return presignExistingUpload(existing, input.ownerId);
  }

  const prepared = await prepareMovieUpload(input.upload);
  const expiresAt = new Date(Date.now() + UPLOAD_SESSION_TTL_MS);
  try {
    const records = await MovieUploadRepository.createUploadRecords({
      ownerId: input.ownerId,
      title: input.upload.title,
      fileName: input.upload.fileName,
      contentType: input.upload.contentType,
      fileSize: input.upload.fileSize,
      checksumSHA256: input.upload.checksumSHA256,
      objectKey: prepared.objectKey,
      bucket: getS3BucketName(),
      idempotencyKey: input.idempotencyKey,
      expiresAt,
      presignedUrlExpiresAt: prepared.expiresAt,
    });
    return {
      uploadId: records.uploadSession.id,
      uploadUrl: prepared.url,
      requiredHeaders: prepared.requiredHeaders,
      expiresAt: prepared.expiresAt,
    };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const winner = await MovieUploadRepository.findByOwnerAndIdempotencyKey(input.ownerId, input.idempotencyKey);
      if (winner) {
        assertIdempotentUploadMatches(winner, input.upload);
        return presignExistingUpload(winner, input.ownerId);
      }
    }
    throw error;
  }
}

function projectResponse(records: NonNullable<Awaited<ReturnType<typeof MovieUploadRepository.findOwnedSession>>>) {
  const { project, asset } = records;
  return {
    id: project.id,
    title: project.title,
    status: project.status,
    fileSize: project.fileSize,
    mimeType: project.mimeType,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    asset: {
      id: asset.id,
      originalFilename: asset.originalFilename,
      mimeType: asset.mimeType,
      sizeBytes: asset.sizeBytes?.toString() ?? null,
      checksum: asset.checksum,
      status: asset.status,
      scanStatus: asset.scanStatus,
      detectedContainer: asset.detectedContainer,
      detectedMimeType: asset.detectedMimeType,
      quarantinedAt: asset.quarantinedAt,
      verifiedAt: asset.verifiedAt,
    },
    upload: { id: records.id, status: records.status, expiresAt: records.expiresAt },
  };
}

async function requireOwnedUpload(uploadId: string, ownerId: string) {
  const records = await MovieUploadRepository.findOwnedSession(uploadId, ownerId);
  if (!records) throw uploadConflict("Upload session was not found", "UPLOAD_SESSION_NOT_FOUND", 404);
  return records;
}

export async function completeMovieUpload(uploadId: string, ownerId: string) {
  let records = await requireOwnedUpload(uploadId, ownerId);
  if (records.status === "VERIFIED") return { project: projectResponse(records) };
  if (["ABORTED", "EXPIRED", "FAILED"].includes(records.status)) {
    throw uploadConflict("Upload session cannot be completed", "UPLOAD_SESSION_FINALIZED");
  }
  if (records.status !== "COMPLETION_PENDING" && records.expiresAt.getTime() <= Date.now()) {
    const expired = await MovieUploadRepository.markExpired(uploadId, ownerId, records.asset.id);
    if (expired) {
      await deleteStoredObject(records.asset.storageKey);
      throw uploadConflict("Upload session has expired", "UPLOAD_SESSION_EXPIRED", 410);
    }
    records = await requireOwnedUpload(uploadId, ownerId);
    if (records.status === "VERIFIED") return { project: projectResponse(records) };
    if (["ABORTED", "EXPIRED", "FAILED"].includes(records.status)) {
      throw uploadConflict("Upload session cannot be completed", "UPLOAD_SESSION_FINALIZED");
    }
  }

  if (records.status !== "COMPLETION_PENDING") {
    // Avoid pinning the session in COMPLETION_PENDING when completion is called
    // before the browser PUT has reached storage.
    await headStoredObject(records.asset.storageKey);
    const changed = await MovieUploadRepository.markCompletionPending(uploadId, ownerId);
    if (changed.count !== 1) {
      records = await requireOwnedUpload(uploadId, ownerId);
      if (records.status === "VERIFIED") return { project: projectResponse(records) };
      if (records.status !== "COMPLETION_PENDING") {
        throw uploadConflict("Upload session changed before verification", "UPLOAD_SESSION_FINALIZED");
      }
    }
    records = await requireOwnedUpload(uploadId, ownerId);
  }

  let verified;
  try {
    verified = await validateUploadedMovieObject({
      objectKey: records.asset.storageKey,
      expectedSize: Number(records.expectedSizeBytes),
      expectedContentType: records.expectedContentType,
      expectedChecksumSHA256: records.expectedChecksum ?? undefined,
    });
  } catch (error) {
    if (error instanceof MovieUploadValidationError) {
      await MovieUploadRepository.markFailed(uploadId, ownerId, records.asset.id, error.code);
    }
    throw error;
  }

  const extension = records.asset.originalFilename.split(".").at(-1)?.toLowerCase() ?? "";
  const stagingObjectKey = records.asset.storageKey;
  const finalObjectKey = createFinalMovieObjectKey(uploadId, extension);
  await copyStoredObject(stagingObjectKey, finalObjectKey, records.expectedContentType);
  const finalVerified = await validateUploadedMovieObject({
    objectKey: finalObjectKey,
    expectedSize: Number(records.expectedSizeBytes),
    expectedContentType: records.expectedContentType,
    expectedChecksumSHA256: verified.checksumSHA256,
  });

  const committed = await MovieUploadRepository.markVerified({
    uploadId,
    ownerId,
    projectId: records.project.id,
    assetId: records.asset.id,
    finalObjectKey,
    bucket: records.asset.bucket,
    fileSize: finalVerified.contentLength ?? Number(records.expectedSizeBytes),
    contentType: records.expectedContentType,
    checksumSHA256: finalVerified.checksumSHA256,
    etag: finalVerified.etag,
    detectedContainer: finalVerified.container,
    detectedMimeType: finalVerified.mimeType,
  });
  records = await requireOwnedUpload(uploadId, ownerId);
  if (!committed && records.status !== "VERIFIED") {
    await deleteStoredObject(finalObjectKey).catch(() => {
      console.error("Uncommitted upload promotion cleanup failed");
    });
    throw uploadConflict("Upload verification state changed unexpectedly", "UPLOAD_STATE_CONFLICT");
  }
  if (committed) {
    await deleteStoredObject(stagingObjectKey).catch(() => {
      console.error("Verified upload staging cleanup failed");
    });
  }
  return { project: projectResponse(records) };
}

export async function cancelMovieUpload(uploadId: string, ownerId: string) {
  const records = await requireOwnedUpload(uploadId, ownerId);
  if (records.status === "VERIFIED") {
    throw uploadConflict("A verified upload cannot be canceled", "UPLOAD_CANNOT_BE_CANCELED");
  }
  if (records.status !== "ABORTED") {
    const changed = await MovieUploadRepository.markAborted(uploadId, ownerId, records.asset.id);
    if (!changed) {
      const latest = await requireOwnedUpload(uploadId, ownerId);
      if (latest.status !== "ABORTED") {
        throw uploadConflict("Upload session changed before cancellation", "UPLOAD_STATE_CONFLICT");
      }
    }
  }
  await deleteStoredObject(records.asset.storageKey);
  const extension = records.asset.originalFilename.split(".").at(-1)?.toLowerCase() ?? "";
  await deleteStoredObject(createFinalMovieObjectKey(uploadId, extension));
  return { uploadId, status: "ABORTED" as const };
}
