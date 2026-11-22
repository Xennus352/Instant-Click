import { randomUUID } from "node:crypto";
import { z } from "zod";
import { errorResponse, readJson } from "@/lib/http/api-response";
import { requireRole, requireSession } from "@/lib/middleware/auth-session";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const packageSchema = z.object({
  key: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{1,63}$/),
  name: z.string().trim().min(2).max(100),
  credits: z.number().int().min(1).max(100_000_000),
  bonusCredits: z.number().int().min(0).max(100_000_000).default(0),
  amountMinor: z.string().regex(/^[1-9]\d{0,8}$/).refine((amount) => Number(amount) >= 500, "Dinger requires at least 500 MMK"),
  currency: z.literal("MMK"),
  enabled: z.boolean(),
  displayOrder: z.number().int().min(0).max(100_000).default(0),
  reason: z.string().trim().min(8).max(500),
}).strict();

export async function GET(request: Request) {
  try {
    requireRole(await requireSession(request.headers), "ADMIN", "SUPER_ADMIN", "FINANCE");
    const packages = await prisma.creditPackage.findMany({ orderBy: [{ displayOrder: "asc" }, { key: "asc" }] });
    return Response.json({ data: packages.map(({ amountMinor, ...item }) => ({ ...item, amountMinor: amountMinor.toString() })) },
      { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}

export async function PUT(request: Request) {
  try {
    const session = requireRole(await requireSession(request.headers), "ADMIN", "SUPER_ADMIN", "FINANCE");
    const input = packageSchema.parse(await readJson(request, 16 * 1024));
    const beforeRow = await prisma.creditPackage.findUnique({ where: { key: input.key } });
    const before = beforeRow ? { id: beforeRow.id, key: beforeRow.key, name: beforeRow.name, credits: beforeRow.credits,
      bonusCredits: beforeRow.bonusCredits, amountMinor: beforeRow.amountMinor.toString(), currency: beforeRow.currency,
      enabled: beforeRow.enabled, displayOrder: beforeRow.displayOrder, createdAt: beforeRow.createdAt.toISOString(), updatedAt: beforeRow.updatedAt.toISOString() } : null;
    const { reason, amountMinor, ...data } = input;
    const requestId = (request.headers.get("x-request-id") ?? randomUUID()).slice(0, 128);
    const afterRow = await prisma.$transaction(async (tx) => {
      const row = await tx.creditPackage.upsert({ where: { key: data.key },
        create: { ...data, amountMinor: BigInt(amountMinor) },
        update: { name: data.name, credits: data.credits, bonusCredits: data.bonusCredits, amountMinor: BigInt(amountMinor), currency: data.currency, enabled: data.enabled, displayOrder: data.displayOrder } });
      await tx.adminAuditLog.create({ data: { actorId: session.user.id, actorRole: String(session.user.role ?? "ADMIN"),
        action: before ? "CREDIT_PACKAGE_UPDATED" : "CREDIT_PACKAGE_CREATED", targetType: "CreditPackage", targetId: row.id,
        reason, requestId, before, after: { id: row.id, key: row.key, name: row.name, credits: row.credits,
          bonusCredits: row.bonusCredits, amountMinor: row.amountMinor.toString(), currency: row.currency,
          enabled: row.enabled, displayOrder: row.displayOrder, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() } } });
      return row;
    });
    const { amountMinor: minor, ...item } = afterRow;
    return Response.json({ data: { ...item, amountMinor: minor.toString() } }, { headers: { "Cache-Control": "private, no-store", "X-Request-Id": requestId } });
  } catch (error) { return errorResponse(error); }
}
