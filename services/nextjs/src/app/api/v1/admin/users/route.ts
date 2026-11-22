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
    const page = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1));
    const q = url.searchParams.get("q")?.trim().slice(0, 120);
    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where: q ? { OR: [{ email: { contains: q, mode: "insensitive" } }, { name: { contains: q, mode: "insensitive" } }] } : undefined,
        select: { id: true, email: true, emailVerified: true, name: true, role: true, accountStatus: true, createdAt: true, updatedAt: true },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit, skip: (page - 1) * limit,
      }),
      prisma.user.count({ where: q ? { OR: [{ email: { contains: q, mode: "insensitive" } }, { name: { contains: q, mode: "insensitive" } }] } : undefined }),
    ]);
    return Response.json({ data: { users, page, limit, total } }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
