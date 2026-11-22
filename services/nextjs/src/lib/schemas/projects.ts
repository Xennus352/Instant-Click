import { z } from "zod";

export const projectListQuerySchema = z.object({
  cursor: z.string().regex(/^[a-f\d]{24}$/i).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
}).strict();

export const projectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, "Must be a MongoDB ObjectId");

const videoTypes = {
  mp4: { contentType: "video/mp4", extension: "mp4" },
  mov: { contentType: "video/quicktime", extension: "mov" },
  webm: { contentType: "video/webm", extension: "webm" },
  mkv: { contentType: "video/x-matroska", extension: "mkv" },
} as const;

// MovieProject.fileSize is a Mongo Int32; keep accepted files representable.
export const MAX_MOVIE_UPLOAD_BYTES = 2_147_483_647;
export const movieVideoTypes = videoTypes;

export const createProjectUploadSchema = z.object({
  title: z.string().trim().min(1).max(160),
  fileName: z.string().trim().min(1).max(255).refine(
    (value) => !/[\\/\u0000-\u001f]/.test(value) && !value.includes(".."),
    "Filename must be a plain file name",
  ),
  contentType: z.enum(["video/mp4", "video/quicktime", "video/webm", "video/x-matroska"]),
  fileSize: z.number().int().positive().max(MAX_MOVIE_UPLOAD_BYTES),
  checksumSHA256: z.string().regex(/^[A-Za-z0-9+/]{43}=$/, "Must be a base64-encoded SHA-256 checksum").optional(),
}).strict().superRefine((input, ctx) => {
  const extension = input.fileName.split(".").at(-1)?.toLowerCase();
  const matchingType = Object.values(videoTypes).find((entry) => entry.contentType === input.contentType);
  if (!matchingType || extension !== matchingType.extension) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["fileName"], message: "File extension and contentType must match an allowed video type" });
  }
});

export type CreateProjectUploadInput = z.infer<typeof createProjectUploadSchema>;
