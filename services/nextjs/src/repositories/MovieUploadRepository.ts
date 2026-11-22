import { prisma } from "@/lib/prisma";

const uploadSessionInclude = { asset: true, project: true } as const;

export const MovieUploadRepository = {
  findByOwnerAndIdempotencyKey(ownerId: string, idempotencyKey: string) {
    return prisma.movieUploadSession.findUnique({
      where: { ownerId_idempotencyKey: { ownerId, idempotencyKey } },
      include: uploadSessionInclude,
    });
  },

  findOwnedSession(uploadId: string, ownerId: string) {
    return prisma.movieUploadSession.findFirst({
      where: { id: uploadId, ownerId },
      include: uploadSessionInclude,
    });
  },

  updatePresignedExpiry(uploadId: string, ownerId: string, presignedUrlExpiresAt: Date) {
    return prisma.movieUploadSession.updateMany({
      where: { id: uploadId, ownerId, status: { in: ["CREATED", "UPLOADING"] } },
      data: { status: "UPLOADING", presignedUrlExpiresAt },
    });
  },

  async createUploadRecords(input: {
    ownerId: string;
    title: string;
    fileName: string;
    contentType: string;
    fileSize: number;
    checksumSHA256?: string;
    objectKey: string;
    bucket: string;
    idempotencyKey: string;
    expiresAt: Date;
    presignedUrlExpiresAt: Date;
  }) {
    return prisma.$transaction(async (tx) => {
      const project = await tx.movieProject.create({
        data: {
          userId: input.ownerId,
          title: input.title,
          sourceVideoKey: input.objectKey,
          sourceVideoUrl: `s3://${input.bucket}/${input.objectKey}`,
          status: "UPLOADED",
        },
      });
      const asset = await tx.movieAsset.create({
        data: {
          projectId: project.id,
          ownerId: input.ownerId,
          bucket: input.bucket,
          storageKey: input.objectKey,
          originalFilename: input.fileName,
          mimeType: input.contentType,
          status: "PENDING_UPLOAD",
          scanStatus: "NOT_CONFIGURED",
        },
      });
      const uploadSession = await tx.movieUploadSession.create({
        data: {
          assetId: asset.id,
          projectId: project.id,
          ownerId: input.ownerId,
          idempotencyKey: input.idempotencyKey,
          expectedSizeBytes: BigInt(input.fileSize),
          expectedContentType: input.contentType,
          checksumAlgorithm: input.checksumSHA256 ? "SHA256" : null,
          expectedChecksum: input.checksumSHA256 ?? null,
          status: "UPLOADING",
          expiresAt: input.expiresAt,
          presignedUrlExpiresAt: input.presignedUrlExpiresAt,
        },
      });
      return { project, asset, uploadSession };
    });
  },

  markCompletionPending(uploadId: string, ownerId: string) {
    return prisma.movieUploadSession.updateMany({
      where: { id: uploadId, ownerId, status: { in: ["CREATED", "UPLOADING"] } },
      data: { status: "COMPLETION_PENDING", completionRequestedAt: new Date() },
    });
  },

  async markVerified(input: {
    uploadId: string;
    ownerId: string;
    projectId: string;
    assetId: string;
    finalObjectKey: string;
    bucket: string;
    fileSize: number;
    contentType: string;
    checksumSHA256: string;
    etag?: string;
    detectedContainer: string;
    detectedMimeType: string;
  }) {
    const now = new Date();
    return prisma.$transaction(async (tx) => {
      const sessionUpdate = await tx.movieUploadSession.updateMany({
        where: { id: input.uploadId, ownerId: input.ownerId, status: "COMPLETION_PENDING" },
        data: { status: "VERIFIED", verifiedAt: now },
      });
      if (sessionUpdate.count !== 1) return false;

      await tx.movieAsset.update({
        where: { id: input.assetId },
        data: {
          sizeBytes: BigInt(input.fileSize),
          storageKey: input.finalObjectKey,
          bucket: input.bucket,
          mimeType: input.contentType,
          checksum: input.checksumSHA256,
          checksumAlgorithm: "SHA256",
          etag: input.etag,
          sizeVerifiedAt: now,
          checksumVerifiedAt: now,
          signatureVerifiedAt: now,
          detectedContainer: input.detectedContainer,
          detectedMimeType: input.detectedMimeType,
          status: "QUARANTINED",
          scanStatus: "NOT_CONFIGURED",
          quarantinedAt: now,
          verifiedAt: now,
        },
      });
      await tx.movieProject.update({
        where: { id: input.projectId },
        data: {
          fileSize: input.fileSize,
          mimeType: input.contentType,
          sourceVideoKey: input.finalObjectKey,
          sourceVideoUrl: `s3://${input.bucket}/${input.finalObjectKey}`,
        },
      });
      return true;
    });
  },

  async markFailed(uploadId: string, ownerId: string, assetId: string, failureCode: string) {
    return prisma.$transaction(async (tx) => {
      const update = await tx.movieUploadSession.updateMany({
        where: { id: uploadId, ownerId, status: "COMPLETION_PENDING" },
        data: { status: "FAILED", failureCode },
      });
      if (update.count === 1) {
        await tx.movieAsset.update({ where: { id: assetId }, data: { status: "FAILED" } });
      }
      return update.count === 1;
    });
  },

  async markExpired(uploadId: string, ownerId: string, assetId: string) {
    return prisma.$transaction(async (tx) => {
      const update = await tx.movieUploadSession.updateMany({
        where: { id: uploadId, ownerId, status: { in: ["CREATED", "UPLOADING"] } },
        data: { status: "EXPIRED", failureCode: "UPLOAD_EXPIRED" },
      });
      if (update.count === 1) {
        await tx.movieAsset.update({ where: { id: assetId }, data: { status: "ABORTED" } });
      }
      return update.count === 1;
    });
  },

  async markAborted(uploadId: string, ownerId: string, assetId: string) {
    return prisma.$transaction(async (tx) => {
      const update = await tx.movieUploadSession.updateMany({
        where: { id: uploadId, ownerId, status: { in: ["CREATED", "UPLOADING", "COMPLETION_PENDING", "FAILED", "EXPIRED"] } },
        data: { status: "ABORTED" },
      });
      if (update.count === 1) {
        await tx.movieAsset.update({ where: { id: assetId }, data: { status: "ABORTED" } });
      }
      return update.count === 1;
    });
  },
};
