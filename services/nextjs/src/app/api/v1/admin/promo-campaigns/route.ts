import { randomUUID } from "node:crypto";
import { z } from "zod";
import { errorResponse, readJson } from "@/lib/http/api-response";
import { requireRole, requireSession } from "@/lib/middleware/auth-session";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const campaignSchema = z.object({
  key: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{1,63}$/),
  enabled: z.boolean(),
  freeRecapCount: z.number().int().min(0).max(20),
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().optional(),
  reason: z.string().trim().min(8).max(500),
}).strict().refine((value) => !value.startsAt || !value.endsAt || new Date(value.endsAt) > new Date(value.startsAt),
  { path: ["endsAt"], message: "endsAt must follow startsAt" });

export async function GET(request: Request) {
  try {
    requireRole(await requireSession(request.headers), "ADMIN", "SUPER_ADMIN");
    const campaigns = await prisma.promoCampaign.findMany({ orderBy: [{ createdAt: "desc" }] });
    return Response.json({ data: campaigns }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}

export async function PUT(request: Request) {
  try {
    const session = requireRole(await requireSession(request.headers), "ADMIN", "SUPER_ADMIN");
    const input = campaignSchema.parse(await readJson(request, 16 * 1024));
    const before = await prisma.promoCampaign.findUnique({ where: { key: input.key } });
    const { reason, ...values } = input;
    const data = { enabled: values.enabled, freeRecapCount: values.freeRecapCount,
      startsAt: values.startsAt ? new Date(values.startsAt) : null, endsAt: values.endsAt ? new Date(values.endsAt) : null };
    const requestId = (request.headers.get("x-request-id") ?? randomUUID()).slice(0, 128);
    const campaign = await prisma.$transaction(async (tx) => {
      const row = await tx.promoCampaign.upsert({ where: { key: values.key },
        create: { key: values.key, ...data, createdBy: session.user.id, updatedBy: session.user.id },
        update: { ...data, updatedBy: session.user.id } });
      await tx.adminAuditLog.create({ data: { actorId: session.user.id, actorRole: String(session.user.role ?? "ADMIN"),
        action: before ? "PROMO_CAMPAIGN_UPDATED" : "PROMO_CAMPAIGN_CREATED", targetType: "PromoCampaign", targetId: row.id,
        reason, requestId,
        before: before ? { key: before.key, enabled: before.enabled, freeRecapCount: before.freeRecapCount,
          startsAt: before.startsAt?.toISOString() ?? null, endsAt: before.endsAt?.toISOString() ?? null } : null,
        after: { key: row.key, enabled: row.enabled, freeRecapCount: row.freeRecapCount,
          startsAt: row.startsAt?.toISOString() ?? null, endsAt: row.endsAt?.toISOString() ?? null } } });
      return row;
    });
    return Response.json({ data: campaign }, { headers: { "Cache-Control": "private, no-store", "X-Request-Id": requestId } });
  } catch (error) { return errorResponse(error); }
}
