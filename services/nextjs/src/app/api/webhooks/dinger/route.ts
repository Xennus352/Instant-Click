import { PaymentOrderStatus, PaymentProviderRecordType, PaymentRecordStatus, Prisma } from "@prisma/client";
import { errorResponse, readJson } from "@/lib/http/api-response";
import { prisma } from "@/lib/prisma";
import { postCreditBalanceChange } from "@/services/CreditWalletService";
import { dingerCallbackEnabled, dingerProviderMethodIsSupported, verifyDingerCallback } from "@/services/DingerPaymentService";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const envelopeSchema = z.object({
  paymentResult: z.string().min(16).max(16_384),
  checksum: z.string().regex(/^[a-f\d]{64}$/i),
}).strict();

function response(status: number, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  // The feature gate is intentionally off unless an operator configures both
  // the explicit enable flag and the provider's secret callback key.
  if (!dingerCallbackEnabled()) return response(503, "PAYMENTS_DISABLED", "Verified payment callbacks are not enabled");
  try {
    const envelope = envelopeSchema.parse(await readJson(request, 24 * 1024));
    const result = verifyDingerCallback({ ...envelope, callbackKey: process.env.DINGER_CALLBACK_KEY! });
    if (!dingerProviderMethodIsSupported(result.providerName, result.methodName)) {
      return response(400, "PAYMENT_METHOD_UNSUPPORTED", "The signed provider and method are not supported");
    }

    const order = await prisma.paymentOrder.findFirst({
      where: { id: result.merchantOrderId, provider: "DINGER" },
    });
    if (!order) return response(404, "PAYMENT_ORDER_NOT_FOUND", "The signed callback does not match an order");
    if (order.currency !== "MMK" || order.amountMinor !== BigInt(result.totalAmount)) {
      return response(409, "PAYMENT_AMOUNT_MISMATCH", "The signed amount does not match the order snapshot");
    }
    const creditableStatuses: PaymentOrderStatus[] = [PaymentOrderStatus.CREATED, PaymentOrderStatus.PENDING, PaymentOrderStatus.PAID];
    if (result.transactionStatus === "SUCCESS" && !creditableStatuses.includes(order.status)) {
      return response(409, "PAYMENT_ORDER_TERMINAL", "A terminal payment order cannot be credited");
    }

    const eventId = `${result.transactionId}:${result.transactionStatus}`;
    const existingEvent = await prisma.paymentWebhookEvent.findUnique({ where: { provider_providerEventId: { provider: "DINGER", providerEventId: eventId } } });
    if (existingEvent?.processedAt) return Response.json({ data: { received: true, duplicate: true } }, { headers: { "Cache-Control": "no-store" } });
    if (!existingEvent) {
      try {
        await prisma.paymentWebhookEvent.create({ data: {
          provider: "DINGER", providerEventId: eventId, paymentOrderId: order.id,
          eventType: result.transactionStatus, status: "RECEIVED", payloadHash: result.payloadHash,
          signatureVerifiedAt: new Date(),
        } });
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) throw error;
      }
    }

    const success = result.transactionStatus === "SUCCESS";
    const recordStatus = success ? PaymentRecordStatus.VERIFIED : PaymentRecordStatus.FAILED;
    const existingTransaction = await prisma.paymentProviderTransaction.findUnique({
      where: { provider_providerTransactionId: { provider: "DINGER", providerTransactionId: result.transactionId } },
    });
    if (existingTransaction && (existingTransaction.paymentOrderId !== order.id || existingTransaction.amountMinor !== order.amountMinor || existingTransaction.currency !== order.currency || existingTransaction.status !== recordStatus)) {
      return response(409, "PAYMENT_TRANSACTION_CONFLICT", "The provider transaction is already bound to a different payment");
    }
    if (!existingTransaction) {
      try {
        await prisma.paymentProviderTransaction.create({ data: {
          paymentOrderId: order.id, provider: "DINGER", providerTransactionId: result.transactionId,
          type: PaymentProviderRecordType.PAYMENT, status: recordStatus, amountMinor: order.amountMinor,
          currency: "MMK", ...(success ? { verifiedAt: new Date() } : {}),
        } });
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) throw error;
        const raced = await prisma.paymentProviderTransaction.findUnique({
          where: { provider_providerTransactionId: { provider: "DINGER", providerTransactionId: result.transactionId } },
        });
        if (!raced || raced.paymentOrderId !== order.id || raced.amountMinor !== order.amountMinor || raced.currency !== "MMK" || raced.status !== recordStatus) {
          return response(409, "PAYMENT_TRANSACTION_CONFLICT", "The provider transaction is already bound to a different payment");
        }
      }
    }

    if (!success) {
      await prisma.paymentOrder.updateMany({ where: { id: order.id, status: { in: [PaymentOrderStatus.CREATED, PaymentOrderStatus.PENDING] } }, data: { status: PaymentOrderStatus.FAILED } });
    } else if (!order.creditsGrantedAt) {
      const paidAt = order.paidAt ?? new Date();
      const claimed = await prisma.paymentOrder.updateMany({
        where: { id: order.id, status: { in: creditableStatuses }, creditsGrantedAt: null },
        data: { status: PaymentOrderStatus.PAID, paidAt, providerReference: result.transactionId },
      });
      if (claimed.count !== 1) {
        const latest = await prisma.paymentOrder.findUnique({ where: { id: order.id } });
        if (!latest?.creditsGrantedAt) return response(409, "PAYMENT_ORDER_TERMINAL", "The order changed before verified settlement");
      }
      await postCreditBalanceChange({
        userId: order.userId, paymentOrderId: order.id, sourceRecordId: order.id,
        type: "PURCHASE", amount: order.credits + order.bonusCredits,
        idempotencyKey: `purchase:${order.id}`, reason: "Dinger verified payment",
        metadata: { provider: "DINGER", providerTransactionId: result.transactionId, method: result.methodName, currency: "MMK", amountMinor: result.totalAmount },
      });
      await prisma.paymentOrder.updateMany({
        where: { id: order.id, status: PaymentOrderStatus.PAID, creditsGrantedAt: null },
        data: { creditsGrantedAt: new Date(), providerReference: result.transactionId },
      });
    }
    await prisma.paymentWebhookEvent.updateMany({
      where: { provider: "DINGER", providerEventId: eventId, processedAt: null },
      data: { status: PaymentRecordStatus.VERIFIED, processedAt: new Date() },
    });
    return Response.json({ data: { received: true, duplicate: false } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
