import { AccountStatus, Role } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { errorResponse, readJson } from "@/lib/http/api-response";
import { requireRole, requireSession } from "@/lib/middleware/auth-session";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const changeSchema = z.object({
  accountStatus: z.nativeEnum(AccountStatus).optional(),
  role: z.nativeEnum(Role).optional(),
  reason: z.string().trim().min(8).max(500),
}).strict().refine((value) => value.accountStatus !== undefined || value.role !== undefined, "At least one account field is required");

export async function PATCH(request: Request, context: { params: { userId: string } }) {
  try {
    const session = requireRole(await requireSession(request.headers), "ADMIN", "SUPER_ADMIN");
    const actorRole = String(session.user.role ?? "USER").toUpperCase();
    const userId = context.params.userId;
    if (!/^[a-f\d]{24}$/i.test(userId)) return Response.json({ error: { code: "NOT_FOUND", message: "User not found" } }, { status: 404 });
    const input = changeSchema.parse(await readJson(request, 8 * 1024));
    if (userId === session.user.id) throw new TypeError("Administrators cannot change their own role or account status");
    if (input.role !== undefined && actorRole !== "SUPER_ADMIN") {
      return Response.json({ error: { code: "FORBIDDEN", message: "Only a super administrator can change roles" } }, { status: 403 });
    }
    const before = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true, accountStatus: true } });
    if (!before) return Response.json({ error: { code: "NOT_FOUND", message: "User not found" } }, { status: 404 });
    const after = { role: input.role ?? before.role, accountStatus: input.accountStatus ?? before.accountStatus };
    const isPrivileged = before.role === "ADMIN" || before.role === "SUPER_ADMIN";
    const losesPrivilegedAccess = isPrivileged && (after.role !== before.role || (after.accountStatus !== null && after.accountStatus !== "ACTIVE"));
    if (losesPrivilegedAccess) {
      const remainingAdmins = await prisma.user.count({
        where: { id: { not: userId }, role: { in: ["ADMIN", "SUPER_ADMIN"] }, accountStatus: "ACTIVE" },
      });
      if (remainingAdmins === 0) return Response.json({ error: { code: "LAST_ADMIN", message: "At least one active administrator must remain" } }, { status: 409 });
    }
    const requestId = (request.headers.get("x-request-id") ?? randomUUID()).slice(0, 128);
    const updated = await prisma.$transaction(async (tx) => {
      const user = await tx.user.update({ where: { id: userId }, data: after,
        select: { id: true, email: true, emailVerified: true, name: true, role: true, accountStatus: true, updatedAt: true } });
      await tx.adminAuditLog.create({ data: { actorId: session.user.id, actorRole, action: "USER_ACCOUNT_UPDATED", targetType: "User", targetId: userId,
        reason: input.reason, requestId, before, after } });
      return user;
    });
    return Response.json({ data: updated }, { headers: { "Cache-Control": "private, no-store", "X-Request-Id": requestId } });
  } catch (error) {
    return errorResponse(error);
  }
}
