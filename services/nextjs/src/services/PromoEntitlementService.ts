import type { Prisma } from "@prisma/client";

export const FREE_RECAP_CAMPAIGN_KEY = "free-recaps";

export class FreeRecapEntitlementUnavailableError extends Error {
  readonly code = "FREE_RECAPS_UNAVAILABLE";

  constructor(message = "No free recap entitlements are available; paid checkout is not configured") {
    super(message);
    this.name = "FreeRecapEntitlementUnavailableError";
  }
}

function eventKey(kind: string, id: string) {
  return `free-recap:${kind}:${id}`;
}

async function appendEvent(
  tx: Prisma.TransactionClient,
  input: {
    walletId: string;
    userId: string;
    campaignId: string;
    reservationId?: string;
    runId?: string;
    eventKey: string;
    type: "GRANT" | "RESERVE" | "CAPTURE" | "RELEASE";
    amount: number;
    grantedAfter: number;
    reservedAfter: number;
    consumedAfter: number;
  },
) {
  await tx.promoEntitlementEvent.create({ data: input });
}

/** Reserve one allowance atomically with the pipeline's initial JobRecord. */
export async function reserveFreeRecapInTransaction(
  tx: Prisma.TransactionClient,
  input: { userId: string; projectId: string; runId: string },
) {
  const campaign = await tx.promoCampaign.findUnique({ where: { key: FREE_RECAP_CAMPAIGN_KEY } });
  const now = new Date();
  if (!campaign || !campaign.enabled || !Number.isSafeInteger(campaign.freeRecapCount) || campaign.freeRecapCount < 0 || campaign.freeRecapCount > 20 ||
      (campaign.startsAt && campaign.startsAt > now) || (campaign.endsAt && campaign.endsAt <= now)) {
    throw new FreeRecapEntitlementUnavailableError("The free-recap campaign is not configured and active; paid checkout is unavailable");
  }
  if (campaign.freeRecapCount === 0) throw new FreeRecapEntitlementUnavailableError("The active free-recap campaign currently grants zero recaps");

  const existing = await tx.promoReservation.findUnique({
    where: { userId_campaignId_runId: { userId: input.userId, campaignId: campaign.id, runId: input.runId } },
  });
  if (existing) {
    if (existing.projectId !== input.projectId) throw new FreeRecapEntitlementUnavailableError("This pipeline run cannot reuse another project's free recap reservation");
    if (existing.status === "RELEASED") throw new FreeRecapEntitlementUnavailableError("A released reservation is terminal; retry with a new Idempotency-Key to create a new run");
    if (existing.status !== "OPEN") throw new FreeRecapEntitlementUnavailableError("This pipeline run already consumed its free recap reservation");
    return existing;
  }

  let wallet = await tx.promoEntitlementWallet.findUnique({
    where: { userId_campaignId: { userId: input.userId, campaignId: campaign.id } },
  });
  if (!wallet) {
    wallet = await tx.promoEntitlementWallet.create({
      data: { userId: input.userId, campaignId: campaign.id, granted: campaign.freeRecapCount, grantedAt: now },
    });
    await appendEvent(tx, {
      walletId: wallet.id, userId: input.userId, campaignId: campaign.id,
      eventKey: eventKey("grant", `${input.userId}:${campaign.id}`), type: "GRANT", amount: campaign.freeRecapCount,
      grantedAfter: campaign.freeRecapCount, reservedAfter: 0, consumedAfter: 0,
    });
  }

  // `granted` is the user's campaign-count snapshot. Admin edits affect only
  // users whose promo wallet has not yet been created; existing grants are
  // neither revoked after a decrease nor silently increased after an edit.
  if (!Number.isSafeInteger(wallet.granted) || wallet.granted < 0 || wallet.granted > 20 ||
      wallet.granted - wallet.reserved - wallet.consumed < 1) {
    throw new FreeRecapEntitlementUnavailableError();
  }
  const changed = await tx.promoEntitlementWallet.updateMany({
    where: { id: wallet.id, version: wallet.version, granted: wallet.granted },
    data: { reserved: { increment: 1 }, version: { increment: 1 } },
  });
  if (changed.count !== 1) throw new FreeRecapEntitlementUnavailableError("The free recap allowance changed concurrently; retry this request");
  const reservation = await tx.promoReservation.create({
    data: {
      walletId: wallet.id, userId: input.userId, campaignId: campaign.id, projectId: input.projectId,
      runId: input.runId, idempotencyKey: `pipeline:${input.runId}`,
    },
  });
  await appendEvent(tx, {
    walletId: wallet.id, userId: input.userId, campaignId: campaign.id, reservationId: reservation.id,
    runId: input.runId, eventKey: eventKey("reserve", reservation.id), type: "RESERVE", amount: 1,
    grantedAfter: wallet.granted, reservedAfter: wallet.reserved + 1, consumedAfter: wallet.consumed,
  });
  return reservation;
}

/** Invoke only from the final-render completion transaction after its output is verified and persisted. */
export async function captureFreeRecapInTransaction(
  tx: Prisma.TransactionClient,
  input: { userId: string; projectId: string; runId: string },
) {
  const reservation = await tx.promoReservation.findFirst({
    where: { userId: input.userId, projectId: input.projectId, runId: input.runId },
  });
  if (!reservation) throw new FreeRecapEntitlementUnavailableError("Pipeline has no matching free recap reservation");
  if (reservation.status === "CAPTURED") return reservation;
  if (reservation.status !== "OPEN") throw new FreeRecapEntitlementUnavailableError("Pipeline free recap reservation is not open");
  const wallet = await tx.promoEntitlementWallet.findUnique({ where: { id: reservation.walletId } });
  if (!wallet || wallet.reserved < 1) throw new FreeRecapEntitlementUnavailableError("Pipeline free recap reservation is inconsistent");
  const changed = await tx.promoEntitlementWallet.updateMany({
    where: { id: wallet.id, version: wallet.version, reserved: { gte: 1 } },
    data: { reserved: { decrement: 1 }, consumed: { increment: 1 }, version: { increment: 1 } },
  });
  if (changed.count !== 1) throw new FreeRecapEntitlementUnavailableError("The free recap allowance changed concurrently; retry the callback");
  const captured = await tx.promoReservation.updateMany({
    where: { id: reservation.id, status: "OPEN" }, data: { status: "CAPTURED", capturedAt: new Date() },
  });
  if (captured.count !== 1) throw new FreeRecapEntitlementUnavailableError("The free recap reservation changed concurrently; retry the callback");
  await appendEvent(tx, {
    walletId: wallet.id, userId: input.userId, campaignId: reservation.campaignId,
    reservationId: reservation.id, runId: input.runId, eventKey: eventKey("capture", reservation.id),
    type: "CAPTURE", amount: 1, grantedAfter: wallet.granted, reservedAfter: wallet.reserved - 1,
    consumedAfter: wallet.consumed + 1,
  });
  return { ...reservation, status: "CAPTURED" as const, capturedAt: new Date() };
}

/** Release an unsuccessful run so failed attempts do not consume a free recap. */
export async function releaseFreeRecapInTransaction(
  tx: Prisma.TransactionClient,
  input: { userId: string; projectId: string; runId: string },
) {
  const reservation = await tx.promoReservation.findFirst({
    where: { userId: input.userId, projectId: input.projectId, runId: input.runId },
  });
  if (!reservation || reservation.status === "RELEASED" || reservation.status === "CAPTURED") return;
  const wallet = await tx.promoEntitlementWallet.findUnique({ where: { id: reservation.walletId } });
  if (!wallet || wallet.reserved < 1) throw new FreeRecapEntitlementUnavailableError("Pipeline free recap reservation is inconsistent");
  const changed = await tx.promoEntitlementWallet.updateMany({
    where: { id: wallet.id, version: wallet.version, reserved: { gte: 1 } },
    data: { reserved: { decrement: 1 }, version: { increment: 1 } },
  });
  if (changed.count !== 1) throw new FreeRecapEntitlementUnavailableError("The free recap allowance changed concurrently; retry the callback");
  const released = await tx.promoReservation.updateMany({
    where: { id: reservation.id, status: "OPEN" }, data: { status: "RELEASED", releasedAt: new Date() },
  });
  if (released.count !== 1) throw new FreeRecapEntitlementUnavailableError("The free recap reservation changed concurrently; retry the callback");
  await appendEvent(tx, {
    walletId: wallet.id, userId: input.userId, campaignId: reservation.campaignId,
    reservationId: reservation.id, runId: input.runId, eventKey: eventKey("release", reservation.id),
    type: "RELEASE", amount: 1, grantedAfter: wallet.granted, reservedAfter: wallet.reserved - 1,
    consumedAfter: wallet.consumed,
  });
}
