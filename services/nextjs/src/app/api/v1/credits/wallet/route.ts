import { requireSession } from "@/lib/middleware/auth-session";
import { errorResponse } from "@/lib/http/api-response";
import { getCreditWallet } from "@/services/CreditQueryService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const session = await requireSession(request.headers);
    return Response.json({ data: await getCreditWallet(session.user.id) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
