import { errorResponse, readJson } from "@/lib/http/api-response";
import { internalServiceAuthError } from "@/lib/middleware/internal-service";
import { captureCreditsSchema, getIdempotencyKey } from "@/lib/schemas/credits";
import { captureReservedCredits } from "@/services/CreditWalletService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: { reservationId: string } }) {
  const authError = internalServiceAuthError(request);
  if (authError) return authError;
  try {
    const key = getIdempotencyKey(request);
    if (!key) throw new TypeError("A valid Idempotency-Key header is required");
    const input = captureCreditsSchema.parse(await readJson(request));
    const userId = request.headers.get("x-user-id") ?? "";
    const reservationId = context.params.reservationId;
    const transaction = await captureReservedCredits({
      ...input,
      userId,
      reservationId,
      idempotencyKey: `capture:${reservationId}:${key}`,
    });
    return Response.json({ data: { id: transaction.id, type: transaction.type, amount: transaction.amount, balanceAfter: transaction.balanceAfter, reservedAfter: transaction.reservedAfter, status: transaction.status } }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
