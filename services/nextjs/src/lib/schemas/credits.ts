import { z } from "zod";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Must be a MongoDB ObjectId");
const idempotencyKey = z.string().trim().min(8).max(128).regex(/^[\w:.-]+$/);

export const reserveCreditsSchema = z.object({
  projectId: objectId,
  amount: z.number().int().positive().safe(),
}).strict();

export const captureCreditsSchema = z.object({
  amount: z.number().int().positive().safe(),
  projectId: objectId,
  jobId: objectId.optional(),
  sourceRecordId: z.string().min(1).max(128).optional(),
  reason: z.string().trim().max(500).optional(),
  usage: z.object({
    feature: z.enum([
      "AUDIO_EXTRACTION", "TRANSCRIPTION", "MOVIE_ANALYSIS", "SCRIPT_GENERATION",
      "NARRATION", "SUBTITLE_GENERATION", "VIDEO_RENDERING",
    ]),
    metric: z.string().trim().min(1).max(100),
    quantity: z.number().finite().nonnegative(),
    unit: z.string().trim().min(1).max(40),
    sourceRecordId: z.string().min(1).max(128).optional(),
  }).optional(),
}).strict();

export const releaseCreditsSchema = z.object({
  amount: z.number().int().positive().safe(),
  projectId: objectId,
  jobId: objectId.optional(),
  sourceRecordId: z.string().min(1).max(128).optional(),
  reason: z.string().trim().max(500).optional(),
}).strict();

export const balanceChangeSchema = z.object({
  userId: objectId,
  type: z.enum(["GRANT", "ADJUSTMENT", "EXPIRY"]),
  amount: z.number().int().safe().refine((value) => value !== 0),
  sourceRecordId: z.string().min(1).max(128).optional(),
  reason: z.string().trim().min(3).max(500),
}).strict().superRefine((input, ctx) => {
  if (input.type === "GRANT" && input.amount <= 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["amount"], message: `${input.type} amount must be positive` });
  }
  if (["ADJUSTMENT", "EXPIRY"].includes(input.type) && input.amount === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["amount"], message: "Amount must not be zero" });
  }
});

export const refundCreditsSchema = z.object({
  userId: objectId,
  captureId: objectId,
  amount: z.number().int().positive().safe(),
  projectId: objectId.optional(),
  jobId: objectId.optional(),
  reason: z.string().trim().min(3).max(500),
}).strict();

export const transactionListSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: objectId.optional(),
}).strict();

export function getIdempotencyKey(request: Request) {
  const key = idempotencyKey.safeParse(request.headers.get("idempotency-key"));
  return key.success ? key.data : null;
}
