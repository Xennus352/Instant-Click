import { JobStatus } from "@prisma/client";
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
    const status = url.searchParams.get("status");
    if (status && !Object.values(JobStatus).includes(status as JobStatus)) {
      return Response.json({ error: { code: "VALIDATION_ERROR", message: "Unknown job status" } }, { status: 400 });
    }
    const where = status ? { status: status as JobStatus } : undefined;
    const [jobs, total] = await Promise.all([
      prisma.jobRecord.findMany({ where, select: { id: true, projectId: true, queueName: true, name: true, stage: true, status: true,
        progress: true, attemptsMade: true, timestamp: true, processedOn: true, finishedOn: true, runId: true, updatedAt: true },
        orderBy: { createdAt: "desc" }, take: limit }),
      prisma.jobRecord.count({ where }),
    ]);
    return Response.json({ data: { jobs, total, limit } }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
