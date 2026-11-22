import { errorResponse } from "@/lib/http/api-response";
import { requireSession } from "@/lib/middleware/auth-session";
import { transactionListSchema } from "@/lib/schemas/credits";
import { getCreditTransactions } from "@/services/CreditQueryService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const session = await requireSession(request.headers);
    const query = Object.fromEntries(new URL(request.url).searchParams.entries());
    const { cursor, limit } = transactionListSchema.parse(query);
    return Response.json({ data: await getCreditTransactions(session.user.id, cursor, limit) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
