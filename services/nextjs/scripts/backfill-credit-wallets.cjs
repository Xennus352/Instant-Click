const { PrismaClient, Prisma } = require("@prisma/client");

const prisma = new PrismaClient();
const apply = process.argv.includes("--apply");
const batchSize = 250;

async function main() {
  let cursor;
  let missingWallets = 0;
  let openingCredits = 0;

  while (true) {
    const users = await prisma.user.findMany({
      select: { id: true, credits: true },
      orderBy: { id: "asc" },
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      take: batchSize,
    });
    if (users.length === 0) break;

    for (const user of users) {
      cursor = user.id;
      const wallet = await prisma.creditWallet.findUnique({ where: { userId: user.id } });
      if (wallet) continue;
      if (!Number.isSafeInteger(user.credits) || user.credits < 0) {
        throw new Error(`User ${user.id} has an invalid legacy credit balance; no wallet created for that user`);
      }

      missingWallets += 1;
      openingCredits += user.credits;
      if (!apply) continue;

      await prisma.$transaction(async (tx) => {
        // Recheck inside the transaction so reruns and concurrent starts remain idempotent.
        const existing = await tx.creditWallet.findUnique({ where: { userId: user.id } });
        if (existing) return;

        const created = await tx.creditWallet.create({
          data: { userId: user.id, balance: user.credits, reserved: 0 },
        });
        if (user.credits > 0) {
          await tx.creditTransaction.create({
            data: {
              walletId: created.id,
              userId: user.id,
              type: "ADJUSTMENT",
              amount: user.credits,
              reservedDelta: 0,
              balanceAfter: user.credits,
              reservedAfter: 0,
              status: "POSTED",
              idempotencyKey: `wallet-opening-v1:${user.id}`,
              reason: "Opening balance migrated from legacy User.credits",
            },
          });
        }
      });
    }

    if (users.length < batchSize) break;
  }

  console.log(`${apply ? "Applied" : "Dry run"}: ${missingWallets} wallets, ${openingCredits} opening credits.`);
  if (!apply) console.log("No data was changed. Re-run with --apply to create wallets and opening ledger entries.");
}

main()
  .catch((error) => {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      console.error("A wallet was created concurrently. Stop the rollout, verify wallet and ledger totals, then rerun.");
    } else {
      console.error(error instanceof Error ? error.message : "Wallet backfill failed");
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
