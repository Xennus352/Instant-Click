import { errorResponse, readJson } from "@/lib/http/api-response";
import { requireRole, requireSession } from "@/lib/middleware/auth-session";
import { balanceChangeSchema, getIdempotencyKey } from "@/lib/schemas/credits";
import { postCreditBalanceChange } from "@/services/CreditWalletService";
import { randomUUID } from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const session = requireRole(await requireSession(request.headers), "ADMIN", "SUPER_ADMIN");
    const key = getIdempotencyKey(request);
    if (!key) throw new TypeError("A valid Idempotency-Key header is required");
    const input = balanceChangeSchema.parse(await readJson(request));
    const requestId = (request.headers.get("x-request-id") ?? randomUUID()).slice(0, 128);
    const transaction = await postCreditBalanceChange({
      ...input,
      idempotencyKey: `admin:${session.user.id}:${input.userId}:${input.type}:${key}`,
      metadata: { actorUserId: session.user.id },
      adminAudit: { actorId: session.user.id, actorRole: String(session.user.role ?? "ADMIN"), requestId },
    });
    return Response.json({ data: { id: transaction.id, type: transaction.type, amount: transaction.amount, balanceAfter: transaction.balanceAfter, reservedAfter: transaction.reservedAfter, status: transaction.status } }, { status: 201, headers: { "Cache-Control": "private, no-store", "X-Request-Id": requestId } });
  } catch (error) {
    return errorResponse(error);
  }
}
