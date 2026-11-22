import { errorResponse, readJson } from "@/lib/http/api-response";
import { internalServiceAuthError } from "@/lib/middleware/internal-service";
import { getIdempotencyKey, releaseCreditsSchema } from "@/lib/schemas/credits";
import { releaseReservedCredits } from "@/services/CreditWalletService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: { reservationId: string } }) {
  const authError = internalServiceAuthError(request);
  if (authError) return authError;
  try {
    const key = getIdempotencyKey(request);
    if (!key) throw new TypeError("A valid Idempotency-Key header is required");
    const input = releaseCreditsSchema.parse(await readJson(request));
    const userId = request.headers.get("x-user-id") ?? "";
    const reservationId = context.params.reservationId;
    const transaction = await releaseReservedCredits({
      ...input,
      userId,
      reservationId,
      idempotencyKey: `release:${reservationId}:${key}`,
    });
    return Response.json({ data: { id: transaction.id, type: transaction.type, amount: transaction.amount, balanceAfter: transaction.balanceAfter, reservedAfter: transaction.reservedAfter, status: transaction.status } }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
