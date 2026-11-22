import { requireSession } from "@/lib/middleware/auth-session";
import { errorResponse } from "@/lib/http/api-response";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Public-to-authenticated, read-only view of the current admin-managed MMK prices. */
export async function GET(request: Request) {
  try {
    await requireSession(request.headers);
    const packages = await prisma.creditPackage.findMany({
      where: { enabled: true, currency: "MMK", amountMinor: { gte: BigInt(500), lte: BigInt(999_999_999) } },
      select: { key: true, name: true, credits: true, bonusCredits: true, amountMinor: true, currency: true },
      orderBy: [{ displayOrder: "asc" }, { key: "asc" }],
    });
    return Response.json({ data: packages.map(({ amountMinor, ...item }) => ({ ...item, amountMinor: amountMinor.toString() })) },
      { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}
