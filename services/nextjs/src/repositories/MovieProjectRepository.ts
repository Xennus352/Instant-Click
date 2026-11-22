import { prisma } from "@/lib/prisma";

const projectListSelect = {
  id: true,
  title: true,
  originalTitle: true,
  description: true,
  status: true,
  duration: true,
  fileSize: true,
  mimeType: true,
  createdAt: true,
  updatedAt: true,
  completedAt: true,
  assets: {
    take: 1,
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      originalFilename: true,
      mimeType: true,
      sizeBytes: true,
      status: true,
      scanStatus: true,
      detectedContainer: true,
      detectedMimeType: true,
      verifiedAt: true,
      quarantinedAt: true,
    },
  },
  uploadSessions: {
    take: 1,
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, expiresAt: true },
  },
} as const;

export const MovieProjectRepository = {
  listOwned(userId: string, cursor: string | undefined, limit: number) {
    return prisma.movieProject.findMany({
      where: { userId },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      take: limit + 1,
      select: projectListSelect,
    });
  },
};
