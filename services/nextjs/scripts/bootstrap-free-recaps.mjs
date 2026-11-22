import { PrismaClient } from "@prisma/client";

const args = new Set(process.argv.slice(2));
const key = "free-recaps";
const initialCount = 2;
for (const arg of args) if (!["--apply", "--confirm-production"].includes(arg)) throw new Error(`Unknown option: ${arg}`);
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required; no database operation was attempted");
const apply = args.has("--apply");
if (apply && process.env.NODE_ENV === "production" && !args.has("--confirm-production")) {
  throw new Error("Production writes require --confirm-production; no changes were made");
}

const prisma = new PrismaClient();
try {
  const existing = await prisma.promoCampaign.findUnique({ where: { key } });
  if (existing) {
    if (!Number.isSafeInteger(existing.freeRecapCount) || existing.freeRecapCount < 0 || existing.freeRecapCount > 20) {
      throw new Error(`Existing ${key} campaign has an invalid count; review it in the admin dashboard. No changes made.`);
    }
    console.log(`Promo campaign already exists (enabled=${existing.enabled}, count=${existing.freeRecapCount}); existing settings were preserved.`);
  } else if (!apply) {
    console.log(`Dry run: would create ${key} (enabled, ${initialCount} recaps). No changes made. Pass --apply to write.`);
  } else {
    try {
      const created = await prisma.promoCampaign.create({ data: { key, enabled: true, freeRecapCount: initialCount } });
      console.log(`Created ${created.key} (enabled=${created.enabled}, count=${created.freeRecapCount}).`);
    } catch (error) {
      // Make concurrent setup attempts idempotent: a unique-key winner is read
      // back, never overwritten with the bootstrap defaults.
      if (!(error && typeof error === "object" && "code" in error && error.code === "P2002")) throw error;
      const raced = await prisma.promoCampaign.findUnique({ where: { key } });
      if (!raced) throw error;
      console.log(`Promo campaign was created concurrently (enabled=${raced.enabled}, count=${raced.freeRecapCount}); existing settings were preserved.`);
    }
  }
} finally {
  await prisma.$disconnect();
}
