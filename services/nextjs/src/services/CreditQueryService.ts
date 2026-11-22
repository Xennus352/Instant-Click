import { CreditWalletRepository } from "@/repositories/CreditWalletRepository";
import { prisma } from "@/lib/prisma";
import { FREE_RECAP_CAMPAIGN_KEY } from "@/services/PromoEntitlementService";

export class CreditUserNotFoundError extends Error {
  readonly code = "USER_NOT_FOUND";
  constructor() { super("User was not found"); this.name = "CreditUserNotFoundError"; }
}

export class CreditProjectNotFoundError extends Error {
  readonly code = "PROJECT_NOT_FOUND";
  constructor() { super("Project was not found"); this.name = "CreditProjectNotFoundError"; }
}

export class CreditOperationNotAllowedError extends Error {
  readonly code = "CREDIT_OPERATION_NOT_ALLOWED";
  constructor(message: string) { super(message); this.name = "CreditOperationNotAllowedError"; }
}

export async function getCreditWallet(userId: string) {
  const [wallet, user, campaign] = await Promise.all([
    CreditWalletRepository.findWalletByUserId(userId),
    CreditWalletRepository.findUserBalances(userId),
    prisma.promoCampaign.findUnique({ where: { key: FREE_RECAP_CAMPAIGN_KEY } }),
  ]);
  if (!user) throw new CreditUserNotFoundError();
  const campaignActive = Boolean(campaign?.enabled && Number.isSafeInteger(campaign.freeRecapCount) && campaign.freeRecapCount >= 0 && campaign.freeRecapCount <= 20 &&
    (!campaign.startsAt || campaign.startsAt <= new Date()) && (!campaign.endsAt || campaign.endsAt > new Date()));
  const promoWallet = campaignActive && campaign
    ? await prisma.promoEntitlementWallet.findUnique({
      where: { userId_campaignId: { userId, campaignId: campaign.id } },
      select: { granted: true, reserved: true, consumed: true, updatedAt: true },
    })
    : null;
  const promotional = campaignActive && campaign ? {
    campaignKey: FREE_RECAP_CAMPAIGN_KEY,
    granted: promoWallet?.granted ?? campaign.freeRecapCount,
    reserved: promoWallet?.reserved ?? 0,
    consumed: promoWallet?.consumed ?? 0,
    available: promoWallet ? Math.max(0, promoWallet.granted - promoWallet.reserved - promoWallet.consumed) : campaign.freeRecapCount,
    updatedAt: promoWallet?.updatedAt ?? null,
  } : null;
  if (wallet) {
    return {
      balance: wallet.balance,
      reserved: wallet.reserved,
      available: wallet.balance - wallet.reserved,
      version: wallet.version,
      legacy: false,
      updatedAt: wallet.updatedAt,
      promotional,
    };
  }
  return {
    balance: user.credits,
    reserved: 0,
    available: user.credits,
    version: 0,
    legacy: user.credits !== 0,
    updatedAt: null,
    promotional,
  };
}

export async function requireOwnedProject(projectId: string, userId: string) {
  const project = await CreditWalletRepository.findOwnedProject(projectId, userId);
  if (!project) throw new CreditProjectNotFoundError();
  if (["COMPLETED", "FAILED"].includes(project.status)) {
    throw new CreditOperationNotAllowedError("Credits cannot be reserved for a completed or failed project");
  }
  return project;
}

export async function getCreditTransactions(userId: string, cursor: string | undefined, limit: number) {
  const rows = await CreditWalletRepository.listTransactions(userId, cursor, limit);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    items: page,
    nextCursor: hasMore ? page[page.length - 1]?.id ?? null : null,
  };
}
