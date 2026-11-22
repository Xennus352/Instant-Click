import { PrismaClient } from "@prisma/client";

const args = new Set(process.argv.slice(2));
for (const arg of args) if (!["--apply", "--confirm-production"].includes(arg)) throw new Error(`Unknown option: ${arg}`);
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required; no database operation was attempted");

const apply = args.has("--apply");
if (apply && process.env.NODE_ENV === "production" && !args.has("--confirm-production")) {
  throw new Error("Production writes require --confirm-production; no changes were made");
}

const prisma = new PrismaClient();
try {
  const where = { accountStatus: null };
  const beforeCount = await prisma.user.count({ where });
  if (!apply) {
    console.log(`Dry run: ${beforeCount} user(s) have a null/missing accountStatus. Would set only those records to ACTIVE. No changes made.`);
    console.log("Review this count and the selected DATABASE_URL, then pass --apply to write.");
  } else {
    const result = await prisma.user.updateMany({ where, data: { accountStatus: "ACTIVE" } });
    console.log(`Backfill complete: ${result.count} user(s) set to ACTIVE (dry-run count: ${beforeCount}). Reruns only match remaining null/missing values.`);
  }
} finally {
  await prisma.$disconnect();
}
