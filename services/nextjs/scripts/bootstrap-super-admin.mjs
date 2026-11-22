import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const markerKey = "security.first-super-admin-bootstrap.v1";
const args = process.argv.slice(2);
let email;
let confirmed = false;
let confirmedProduction = false;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--email" && args[i + 1]) email = args[++i];
  else if (args[i] === "--confirm") confirmed = true;
  else if (args[i] === "--confirm-production") confirmedProduction = true;
  else throw new Error("Usage: node scripts/bootstrap-super-admin.mjs --email <verified-email> --confirm [--confirm-production]");
}

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) throw new Error("Provide the verified account email with --email");
if (!confirmed) throw new Error("No changes made. Re-run with --confirm after verifying the nominated account and database target.");
if (process.env.NODE_ENV === "production" && !confirmedProduction) throw new Error("Production bootstrap also requires --confirm-production; no changes were made.");

const prisma = new PrismaClient();

try {
  const outcome = await prisma.$transaction(async (tx) => {
    const target = await tx.user.findUnique({
      where: { email: email.trim().toLowerCase() },
      select: { id: true, emailVerified: true, role: true, accountStatus: true },
    });
    if (!target) throw new Error("The nominated account does not exist");
    if (!target.emailVerified) throw new Error("The nominated account must have a verified email");
    if (target.accountStatus !== "ACTIVE") {
      throw new Error("The nominated account must have accountStatus=ACTIVE; backfill reviewed legacy null statuses first");
    }

    const priorBootstrap = await tx.adminConfig.findUnique({ where: { key: markerKey } });
    if (priorBootstrap) {
      const marker = priorBootstrap.value && typeof priorBootstrap.value === "object" ? priorBootstrap.value : null;
      const markerUserId = marker && !Array.isArray(marker) && "userId" in marker ? marker.userId : null;
      if (markerUserId === target.id && target.role === "SUPER_ADMIN") return { userId: target.id, alreadyComplete: true };
      throw new Error("The one-time first-super-admin bootstrap was already used for a different or no-longer-privileged account");
    }
    const existingAdmin = await tx.user.findFirst({
      where: { role: "SUPER_ADMIN", accountStatus: "ACTIVE" },
      select: { id: true },
    });
    if (existingAdmin) throw new Error("An active super administrator already exists");

    // The unique AdminConfig key serializes concurrent bootstrap attempts and
    // permanently records this one-time operation without a schema change.
    await tx.adminConfig.create({
      data: {
        key: markerKey,
        value: { userId: target.id, completedAt: new Date().toISOString() },
        description: "One-time bootstrap marker for the first super administrator",
        updatedBy: target.id,
      },
    });
    await tx.user.update({ where: { id: target.id }, data: { role: "SUPER_ADMIN" } });
    await tx.adminAuditLog.create({
      data: {
        actorId: target.id,
        actorRole: "SYSTEM_BOOTSTRAP",
        action: "FIRST_SUPER_ADMIN_BOOTSTRAPPED",
        targetType: "User",
        targetId: target.id,
        reason: "One-time operator bootstrap of a verified account",
        requestId: randomUUID(),
        metadata: { actorSource: "operator_cli", nominatedAccountWasEmailVerified: true },
        before: { role: target.role },
        after: { role: "SUPER_ADMIN" },
      },
    });
    return { userId: target.id, alreadyComplete: false };
  });

  console.info(outcome.alreadyComplete ? "First super administrator bootstrap already completed" : "First super administrator bootstrapped", { userId: outcome.userId });
} catch (error) {
  if (error?.code === "P2002") {
    console.error("Bootstrap marker already exists or another bootstrap ran concurrently; verify the account role before retrying.");
  } else {
    console.error(error instanceof Error ? error.message : "Super-admin bootstrap failed");
  }
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
