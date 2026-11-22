import { prisma } from "@/lib/prisma";

export const CreditWalletRepository = {
  findWalletByUserId(userId: string) {
    return prisma.creditWallet.findUnique({ where: { userId } });
  },
  findUserBalances(userId: string) {
    return prisma.user.findUnique({ where: { id: userId }, select: { id: true, credits: true } });
  },
  findOwnedProject(projectId: string, userId: string) {
    return prisma.movieProject.findFirst({ where: { id: projectId, userId }, select: { id: true, status: true } });
  },
  listTransactions(userId: string, cursor: string | undefined, limit: number) {
    return prisma.creditTransaction.findMany({
      where: { userId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      take: limit + 1,
      select: {
        id: true,
        type: true,
        amount: true,
        reservedDelta: true,
        balanceAfter: true,
        reservedAfter: true,
        status: true,
        projectId: true,
        jobId: true,
        reason: true,
        createdAt: true,
      },
    });
  },
};
