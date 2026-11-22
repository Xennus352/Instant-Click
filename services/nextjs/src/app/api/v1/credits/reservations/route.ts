import { errorResponse, readJson } from "@/lib/http/api-response";
import { internalServiceAuthError } from "@/lib/middleware/internal-service";
import { getIdempotencyKey, reserveCreditsSchema } from "@/lib/schemas/credits";
import { reserveCredits } from "@/services/CreditWalletService";
import { requireOwnedProject } from "@/services/CreditQueryService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const authError = internalServiceAuthError(request);
    if (authError) return authError;
    const key = getIdempotencyKey(request);
    if (!key) throw new TypeError("A valid Idempotency-Key header is required");
    const input = reserveCreditsSchema.parse(await readJson(request));
    const userId = request.headers.get("x-user-id") ?? "";
    await requireOwnedProject(input.projectId, userId);
    const transaction = await reserveCredits({
      userId,
      projectId: input.projectId,
      amount: input.amount,
      idempotencyKey: `reserve:${userId}:${key}`,
      reason: "Project processing credit reservation",
    });
    return Response.json({ data: { id: transaction.id, reservationId: transaction.reservationId, status: transaction.status, balanceAfter: transaction.balanceAfter, reservedAfter: transaction.reservedAfter } }, { status: 201, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
