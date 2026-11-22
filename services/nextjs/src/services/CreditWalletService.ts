import {
  Prisma,
  type CreditReservation,
  type CreditTransaction,
  type CreditTransactionType,
  type UsageFeature,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";

const MAX_TRANSACTION_ATTEMPTS = 3;

type UsageInput = {
  feature: UsageFeature;
  metric: string;
  quantity: number;
  unit: string;
  sourceRecordId?: string;
  metadata?: Prisma.InputJsonValue;
};

type AdminAuditInput = {
  actorId: string;
  actorRole: string;
  requestId: string;
};

type MutationInput = {
  userId: string;
  idempotencyKey: string;
  type: CreditTransactionType;
  amount: number;
  reservedDelta: number;
  projectId?: string;
  jobId?: string;
  sourceRecordId?: string;
  paymentOrderId?: string;
  reservationId?: string;
  reservationAmount?: number;
  reversalOfId?: string;
  usage?: UsageInput;
  reason?: string;
  metadata?: Prisma.InputJsonValue;
  adminAudit?: AdminAuditInput;
};

type CreditTransactionWithDetails = Prisma.CreditTransactionGetPayload<{
  include: { usageRecords: true; reservation: true };
}>;

export class InsufficientCreditsError extends Error {
  readonly code = "INSUFFICIENT_CREDITS";

  constructor(message = "The wallet does not have enough available credits") {
    super(message);
    this.name = "InsufficientCreditsError";
  }
}

export class WalletMutationConflictError extends Error {
  readonly code = "WALLET_MUTATION_CONFLICT";

  constructor(message = "The wallet changed concurrently; retry the operation") {
    super(message);
    this.name = "WalletMutationConflictError";
  }
}

export class IdempotencyConflictError extends Error {
  readonly code = "IDEMPOTENCY_KEY_REUSED";

  constructor() {
    super("idempotencyKey was already used for a different wallet mutation");
    this.name = "IdempotencyConflictError";
  }
}

export class WalletBackfillRequiredError extends Error {
  readonly code = "WALLET_BACKFILL_REQUIRED";

  constructor() {
    super("Legacy credits exist; run the wallet backfill before processing billing mutations");
    this.name = "WalletBackfillRequiredError";
  }
}

export class InvalidReservationError extends Error {
  readonly code = "INVALID_CREDIT_RESERVATION";

  constructor(message = "The reservation is missing, settled, or has insufficient remaining credits") {
    super(message);
    this.name = "InvalidReservationError";
  }
}

export class InvalidRefundError extends Error {
  readonly code = "INVALID_CREDIT_REFUND";

  constructor(message = "The capture is missing or the requested refund exceeds its captured amount") {
    super(message);
    this.name = "InvalidRefundError";
  }
}

function requirePositiveInteger(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new TypeError("Credit amount must be a positive safe integer");
  }
}

function requireId(value: string, field: string): void {
  if (!/^[a-f\d]{24}$/i.test(value)) {
    throw new TypeError(`${field} must be a 24-character MongoDB ObjectId`);
  }
}

function validateInput(input: MutationInput): void {
  requireId(input.userId, "userId");
  if (!input.idempotencyKey.trim()) throw new TypeError("idempotencyKey is required");
  if (input.projectId) requireId(input.projectId, "projectId");
  if (input.jobId) requireId(input.jobId, "jobId");
  if (input.paymentOrderId) requireId(input.paymentOrderId, "paymentOrderId");
  if (input.reservationId) requireId(input.reservationId, "reservationId");
  if (input.reversalOfId) requireId(input.reversalOfId, "reversalOfId");
  if ((input.type === "CAPTURE" || input.type === "RELEASE") && !input.reservationId) {
    throw new TypeError("reservationId is required to capture or release credits");
  }
  if (input.type === "RESERVE") requirePositiveInteger(input.reservationAmount ?? 0);
  if (input.type === "REFUND" && !input.reversalOfId) {
    throw new TypeError("reversalOfId must identify the captured ledger entry being refunded");
  }
  if (input.usage) {
    if (input.type !== "CAPTURE") {
      throw new TypeError("Usage can only be recorded alongside a captured credit reservation");
    }
    if (
      !input.usage.metric.trim() ||
      !input.usage.unit.trim() ||
      !Number.isFinite(input.usage.quantity) ||
      input.usage.quantity < 0
    ) {
      throw new TypeError("Usage metric, unit, and a non-negative finite quantity are required");
    }
  }
}

function isKnownPrismaError(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

function idempotencyWhere(userId: string, idempotencyKey: string) {
  return { userId_idempotencyKey: { userId, idempotencyKey } };
}

function assertSameIdempotentMutation(
  existing: CreditTransactionWithDetails,
  input: MutationInput,
): CreditTransaction {
  const usageMatches = input.usage
    ? existing.usageRecords.length === 1 &&
      existing.usageRecords[0].feature === input.usage.feature &&
      existing.usageRecords[0].metric === input.usage.metric &&
      existing.usageRecords[0].quantity === input.usage.quantity &&
      existing.usageRecords[0].unit === input.usage.unit &&
      (existing.usageRecords[0].sourceRecordId ?? undefined) ===
        (input.usage.sourceRecordId ?? input.sourceRecordId)
    : existing.usageRecords.length === 0;
  const reservationMatches =
    input.type === "RESERVE"
      ? existing.reservation?.amount === input.reservationAmount &&
        existing.reservation?.idempotencyKey === input.idempotencyKey
      : (existing.reservationId ?? undefined) === input.reservationId;

  if (
    existing.userId !== input.userId ||
    existing.type !== input.type ||
    existing.amount !== input.amount ||
    existing.reservedDelta !== input.reservedDelta ||
    (existing.projectId ?? undefined) !== input.projectId ||
    (existing.jobId ?? undefined) !== input.jobId ||
    (existing.sourceRecordId ?? undefined) !== input.sourceRecordId ||
    (existing.paymentOrderId ?? undefined) !== input.paymentOrderId ||
    (existing.reversalOfId ?? undefined) !== input.reversalOfId ||
    !reservationMatches ||
    !usageMatches
  ) {
    throw new IdempotencyConflictError();
  }
  return existing;
}

async function applyMutation(input: MutationInput): Promise<CreditTransaction> {
  validateInput(input);

  for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const existing = await tx.creditTransaction.findUnique({
          where: idempotencyWhere(input.userId, input.idempotencyKey),
          include: { usageRecords: true, reservation: true },
        });
        if (existing) return assertSameIdempotentMutation(existing, input);

        let wallet = await tx.creditWallet.findUnique({ where: { userId: input.userId } });
        if (!wallet) {
          const user = await tx.user.findUnique({ where: { id: input.userId }, select: { credits: true } });
          if (!user) throw new Error("Cannot change credits for a user that does not exist");
          if (user.credits !== 0) throw new WalletBackfillRequiredError();
          wallet = await tx.creditWallet.create({ data: { userId: input.userId } });
        }

        let reservation: CreditReservation | undefined;
        if (input.type === "RESERVE") {
          const existingReservation = await tx.creditReservation.findUnique({
            where: { userId_idempotencyKey: { userId: input.userId, idempotencyKey: input.idempotencyKey } },
          });
          if (existingReservation) throw new IdempotencyConflictError();
        } else if (input.type === "CAPTURE" || input.type === "RELEASE") {
          const current = await tx.creditReservation.findUnique({ where: { id: input.reservationId } });
          if (!current || current.userId !== input.userId || current.walletId !== wallet.id || current.status !== "OPEN") {
            throw new InvalidReservationError();
          }
          if ((current.projectId ?? undefined) !== input.projectId) {
            throw new InvalidReservationError("The credit event must belong to the project that created the reservation");
          }
          if (current.jobId && current.jobId !== input.jobId) {
            throw new InvalidReservationError("The credit event must belong to the job that created the reservation");
          }
          const remaining = current.amount - current.capturedAmount - current.releasedAmount;
          if (-input.reservedDelta > remaining) throw new InvalidReservationError();

          const nextCaptured = current.capturedAmount + (input.type === "CAPTURE" ? -input.amount : 0);
          const nextReleased = current.releasedAmount + (input.type === "RELEASE" ? -input.reservedDelta : 0);
          const settled = nextCaptured + nextReleased === current.amount;
          const updated = await tx.creditReservation.updateMany({
            where: { id: current.id, version: current.version, status: "OPEN" },
            data: {
              capturedAmount: { increment: input.type === "CAPTURE" ? -input.amount : 0 },
              releasedAmount: { increment: input.type === "RELEASE" ? -input.reservedDelta : 0 },
              status: settled ? "SETTLED" : "OPEN",
              version: { increment: 1 },
            },
          });
          if (updated.count !== 1) throw new WalletMutationConflictError("The reservation changed concurrently; retry the operation");
          reservation = current;
        }

        if (input.type === "REFUND") {
          const capture = await tx.creditTransaction.findUnique({ where: { id: input.reversalOfId } });
          if (!capture || capture.userId !== input.userId || capture.type !== "CAPTURE" || capture.amount >= 0) {
            throw new InvalidRefundError("reversalOfId must identify a capture by the same user");
          }
          const priorRefunds = await tx.creditTransaction.aggregate({
            where: { reversalOfId: capture.id, type: "REFUND", userId: input.userId },
            _sum: { amount: true },
          });
          const alreadyRefunded = priorRefunds._sum.amount ?? 0;
          if (alreadyRefunded + input.amount > -capture.amount) throw new InvalidRefundError();
        }

        const nextBalance = wallet.balance + input.amount;
        const nextReserved = wallet.reserved + input.reservedDelta;
        if (!Number.isSafeInteger(nextBalance) || !Number.isSafeInteger(nextReserved)) {
          throw new RangeError("Wallet balance exceeds the supported integer range");
        }
        if (nextBalance < 0 || nextReserved < 0 || nextReserved > nextBalance) {
          throw new InsufficientCreditsError();
        }

        const updatedWallet = await tx.creditWallet.updateMany({
          where: { id: wallet.id, version: wallet.version },
          data: {
            balance: { increment: input.amount },
            reserved: { increment: input.reservedDelta },
            version: { increment: 1 },
          },
        });
        if (updatedWallet.count !== 1) throw new WalletMutationConflictError();

        if (input.type === "RESERVE") {
          reservation = await tx.creditReservation.create({
            data: {
              walletId: wallet.id,
              userId: input.userId,
              projectId: input.projectId,
              jobId: input.jobId,
              idempotencyKey: input.idempotencyKey,
              amount: input.reservationAmount!,
            },
          });
        }

        const transaction = await tx.creditTransaction.create({
          data: {
            walletId: wallet.id,
            userId: input.userId,
            projectId: input.projectId,
            jobId: input.jobId,
            reservationId: reservation?.id,
            reversalOfId: input.reversalOfId,
            sourceRecordId: input.sourceRecordId,
            paymentOrderId: input.paymentOrderId,
            type: input.type,
            amount: input.amount,
            reservedDelta: input.reservedDelta,
            balanceAfter: nextBalance,
            reservedAfter: nextReserved,
            status: "POSTED",
            idempotencyKey: input.idempotencyKey,
            reason: input.reason,
            ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
          },
        });

        if (input.adminAudit) {
          await tx.adminAuditLog.create({ data: {
            actorId: input.adminAudit.actorId,
            actorRole: input.adminAudit.actorRole,
            action: input.type === "REFUND" ? "CREDIT_REFUNDED" : "CREDIT_BALANCE_CHANGED",
            targetType: "User",
            targetId: input.userId,
            reason: input.reason ?? "Administrative credit mutation",
            requestId: input.adminAudit.requestId,
            before: { balance: wallet.balance, reserved: wallet.reserved },
            after: { balance: nextBalance, reserved: nextReserved, transactionId: transaction.id, type: input.type, amount: input.amount },
          } });
        }

        if (input.usage) {
          await tx.usageRecord.create({
            data: {
              userId: input.userId,
              projectId: input.projectId,
              jobId: input.jobId,
              sourceRecordId: input.usage.sourceRecordId ?? input.sourceRecordId,
              creditTransactionId: transaction.id,
              feature: input.usage.feature,
              metric: input.usage.metric,
              quantity: input.usage.quantity,
              unit: input.usage.unit,
              creditsUsed: -input.amount,
              ...(input.usage.metadata === undefined ? {} : { metadata: input.usage.metadata }),
            },
          });
        }
        return transaction;
      });
    } catch (error) {
      if (isKnownPrismaError(error, "P2002")) {
        const existing = await prisma.creditTransaction.findUnique({
          where: idempotencyWhere(input.userId, input.idempotencyKey),
          include: { usageRecords: true, reservation: true },
        });
        if (existing) return assertSameIdempotentMutation(existing, input);
      }

      const retryable = error instanceof WalletMutationConflictError || isKnownPrismaError(error, "P2034") || isKnownPrismaError(error, "P2002");
      if (!retryable || attempt === MAX_TRANSACTION_ATTEMPTS) throw error;
    }
  }

  throw new WalletMutationConflictError();
}

/** Hold credits. Spendable balance is wallet.balance - wallet.reserved. */
export async function reserveCredits(input: {
  userId: string;
  amount: number;
  idempotencyKey: string;
  projectId?: string;
  jobId?: string;
  reason?: string;
  metadata?: Prisma.InputJsonValue;
}): Promise<CreditTransaction> {
  requirePositiveInteger(input.amount);
  return applyMutation({
    ...input,
    type: "RESERVE",
    amount: 0,
    reservedDelta: input.amount,
    reservationAmount: input.amount,
  });
}

/** Settle a reservation partially or fully; optional usage is written in the same transaction. */
export async function captureReservedCredits(input: {
  userId: string;
  reservationId: string;
  amount: number;
  idempotencyKey: string;
  projectId?: string;
  jobId?: string;
  sourceRecordId?: string;
  usage?: UsageInput;
  reason?: string;
  metadata?: Prisma.InputJsonValue;
}): Promise<CreditTransaction> {
  requirePositiveInteger(input.amount);
  return applyMutation({ ...input, type: "CAPTURE", amount: -input.amount, reservedDelta: -input.amount });
}

/** Release unused reserved credits. */
export async function releaseReservedCredits(input: {
  userId: string;
  reservationId: string;
  amount: number;
  idempotencyKey: string;
  projectId?: string;
  jobId?: string;
  reason?: string;
  metadata?: Prisma.InputJsonValue;
}): Promise<CreditTransaction> {
  requirePositiveInteger(input.amount);
  return applyMutation({ ...input, type: "RELEASE", amount: 0, reservedDelta: -input.amount });
}

/** Refund previously captured credits, capped by the original capture amount. */
export async function refundCapturedCredits(input: {
  userId: string;
  captureId: string;
  amount: number;
  idempotencyKey: string;
  projectId?: string;
  jobId?: string;
  reason?: string;
  metadata?: Prisma.InputJsonValue;
  adminAudit?: AdminAuditInput;
}): Promise<CreditTransaction> {
  requirePositiveInteger(input.amount);
  requireId(input.captureId, "captureId");
  return applyMutation({
    ...input,
    type: "REFUND",
    amount: input.amount,
    reservedDelta: 0,
    reversalOfId: input.captureId,
  });
}

/** Add a grant/purchase or post an explicitly signed adjustment/expiry. */
export async function postCreditBalanceChange(input: {
  userId: string;
  type: "GRANT" | "PURCHASE" | "ADJUSTMENT" | "EXPIRY";
  amount: number;
  idempotencyKey: string;
  projectId?: string;
  jobId?: string;
  sourceRecordId?: string;
  paymentOrderId?: string;
  reason?: string;
  metadata?: Prisma.InputJsonValue;
  adminAudit?: AdminAuditInput;
}): Promise<CreditTransaction> {
  if (!Number.isSafeInteger(input.amount) || input.amount === 0) {
    throw new TypeError("Balance change must be a non-zero safe integer");
  }
  if (input.amount < 0 && input.type !== "ADJUSTMENT" && input.type !== "EXPIRY") {
    throw new TypeError(`${input.type} balance changes must be positive`);
  }
  return applyMutation({ ...input, reservedDelta: 0 });
}
