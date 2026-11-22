import { errorResponse } from "@/lib/http/api-response";
import { requireRole, requireSession } from "@/lib/middleware/auth-session";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Counts are read directly from persisted records; no estimated/demo figures are returned. */
export async function GET(request: Request) {
  try {
    requireRole(await requireSession(request.headers), "ADMIN", "SUPER_ADMIN");
    const [users, projects, assets, jobs, failedJobs, paidOrders, openPayments, auditEvents] = await Promise.all([
      prisma.user.count(),
      prisma.movieProject.count(),
      prisma.movieAsset.count(),
      prisma.jobRecord.count(),
      prisma.jobRecord.count({ where: { status: "FAILED" } }),
      prisma.paymentOrder.count({ where: { status: "PAID" } }),
      prisma.paymentOrder.count({ where: { status: { in: ["CREATED", "PENDING"] } } }),
      prisma.adminAuditLog.count(),
    ]);
    return Response.json({ data: { users, projects, assets, jobs, failedJobs, paidOrders, openPayments, auditEvents, asOf: new Date().toISOString() } },
      { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
