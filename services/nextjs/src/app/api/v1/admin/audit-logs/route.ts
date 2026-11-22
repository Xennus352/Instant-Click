import { errorResponse } from "@/lib/http/api-response";
import { requireRole, requireSession } from "@/lib/middleware/auth-session";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    requireRole(await requireSession(request.headers), "ADMIN", "SUPER_ADMIN");
    const url = new URL(request.url);
    const limit = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "50", 10) || 50));
    const targetType = url.searchParams.get("targetType")?.trim().slice(0, 80);
    const action = url.searchParams.get("action")?.trim().slice(0, 100);
    const where = { ...(targetType ? { targetType } : {}), ...(action ? { action } : {}) };
    const [entries, total] = await Promise.all([
      prisma.adminAuditLog.findMany({ where, select: { id: true, actorId: true, actorRole: true, action: true, targetType: true, targetId: true,
        reason: true, requestId: true, before: true, after: true, createdAt: true }, orderBy: { createdAt: "desc" }, take: limit }),
      prisma.adminAuditLog.count({ where }),
    ]);
    return Response.json({ data: { entries, total, limit } }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
