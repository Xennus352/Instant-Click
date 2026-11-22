import { PaymentOrderStatus } from "@prisma/client";
import { errorResponse } from "@/lib/http/api-response";
import { requireRole, requireSession } from "@/lib/middleware/auth-session";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Read-only payment order view; provider payloads, references, and tokens are never returned. */
export async function GET(request: Request) {
  try {
    requireRole(await requireSession(request.headers), "ADMIN", "SUPER_ADMIN", "FINANCE");
    const url = new URL(request.url);
    const limit = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "50", 10) || 50));
    const status = url.searchParams.get("status");
    if (status && !Object.values(PaymentOrderStatus).includes(status as PaymentOrderStatus)) {
      return Response.json({ error: { code: "VALIDATION_ERROR", message: "Unknown payment status" } }, { status: 400 });
    }
    const where = status ? { status: status as PaymentOrderStatus } : undefined;
    const [orders, total] = await Promise.all([
      prisma.paymentOrder.findMany({ where, select: { id: true, userId: true, packageId: true, provider: true, status: true,
        amountMinor: true, currency: true, credits: true, bonusCredits: true, refundedMinor: true, paidAt: true, createdAt: true, updatedAt: true },
        orderBy: { createdAt: "desc" }, take: limit }),
      prisma.paymentOrder.count({ where }),
    ]);
    return Response.json({ data: { orders: orders.map(({ amountMinor, refundedMinor, ...order }) => ({
      ...order, amountMinor: amountMinor.toString(), refundedMinor: refundedMinor.toString(),
    })), total, limit } }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}
