import type { Prisma } from "@prisma/client";
import {
  captureFreeRecapInTransaction,
  FreeRecapEntitlementUnavailableError,
  releaseFreeRecapInTransaction,
  reserveFreeRecapInTransaction,
} from "../../src/services/PromoEntitlementService";

function makeTransaction(initialCount = 2) {
  const campaign = {
    id: "campaign-id", key: "free-recaps", enabled: true, freeRecapCount: initialCount,
    startsAt: null, endsAt: null,
  };
  const wallets = new Map<string, any>();
  let reservationCounter = 0;
  const reservations: any[] = [];
  const events: any[] = [];
  const tx = {
    promoCampaign: { findUnique: async () => campaign },
    promoEntitlementWallet: {
      findUnique: async ({ where }: any) => where.id
        ? [...wallets.values()].find((item) => item.id === where.id) ?? null
        : wallets.get(where.userId_campaignId.userId) ?? null,
      create: async ({ data }: any) => {
        const wallet = { id: `wallet-${data.userId}`, version: 0, reserved: 0, consumed: 0, ...data };
        wallets.set(data.userId, wallet);
        return wallet;
      },
      updateMany: async ({ where, data }: any) => {
        const wallet = [...wallets.values()].find((item) => item.id === where.id);
        if (!wallet) return { count: 0 };
        if (wallet.id !== where.id || wallet.version !== where.version ||
            (where.reserved?.gte !== undefined && wallet.reserved < where.reserved.gte)) return { count: 0 };
        for (const [field, change] of Object.entries(data)) {
          if (typeof change === "object" && change && "increment" in change) wallet[field] += (change as any).increment;
          else if (typeof change === "object" && change && "decrement" in change) wallet[field] -= (change as any).decrement;
          else wallet[field] = change;
        }
        return { count: 1 };
      },
    },
    promoReservation: {
      findUnique: async ({ where }: any) => reservations.find((row) => row.userId === where.userId_campaignId_runId.userId &&
        row.campaignId === where.userId_campaignId_runId.campaignId && row.runId === where.userId_campaignId_runId.runId) ?? null,
      findFirst: async ({ where }: any) => reservations.find((row) => row.userId === where.userId && row.projectId === where.projectId && row.runId === where.runId) ?? null,
      create: async ({ data }: any) => {
        const row = { id: `reservation-${++reservationCounter}`, status: "OPEN", ...data };
        reservations.push(row);
        return row;
      },
      updateMany: async ({ where, data }: any) => {
        const row = reservations.find((item) => item.id === where.id && item.status === where.status);
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
    promoEntitlementEvent: { create: async ({ data }: any) => events.push(data) },
  } as unknown as Prisma.TransactionClient;
  return { tx, campaign, wallets, get wallet() { return wallets.get("owner") ?? null; }, reservations, events };
}

describe("promotional recap reservations", () => {
  it("grants two successful scripts, releases failed runs, and settles idempotently", async () => {
    const state = makeTransaction();
    const input = { userId: "owner", projectId: "project", runId: "run-1" };

    const first = await reserveFreeRecapInTransaction(state.tx, input);
    expect(await reserveFreeRecapInTransaction(state.tx, input)).toEqual(first);
    expect(state.wallet).toMatchObject({ granted: 2, reserved: 1, consumed: 0 });

    await captureFreeRecapInTransaction(state.tx, input);
    await captureFreeRecapInTransaction(state.tx, input);
    expect(state.wallet).toMatchObject({ granted: 2, reserved: 0, consumed: 1 });

    const failed = { ...input, runId: "run-2" };
    await reserveFreeRecapInTransaction(state.tx, failed);
    await releaseFreeRecapInTransaction(state.tx, failed);
    await releaseFreeRecapInTransaction(state.tx, failed);
    expect(state.wallet).toMatchObject({ granted: 2, reserved: 0, consumed: 1 });
    await expect(reserveFreeRecapInTransaction(state.tx, failed))
      .rejects.toThrow("retry with a new Idempotency-Key");

    // PipelineService derives a fresh runId from each new retry idempotency key.
    const secondSuccess = { ...input, runId: "run-3" };
    await reserveFreeRecapInTransaction(state.tx, secondSuccess);
    await captureFreeRecapInTransaction(state.tx, secondSuccess);
    expect(state.wallet).toMatchObject({ granted: 2, reserved: 0, consumed: 2 });

    await expect(reserveFreeRecapInTransaction(state.tx, { ...input, runId: "run-4" }))
      .rejects.toBeInstanceOf(FreeRecapEntitlementUnavailableError);
    expect(state.events.map((event) => event.type)).toEqual([
      "GRANT", "RESERVE", "CAPTURE", "RESERVE", "RELEASE", "RESERVE", "CAPTURE",
    ]);
  });

  it("uses the admin-configured count and preserves each user's grant snapshot after edits", async () => {
    const state = makeTransaction(5);
    const firstUser = { userId: "owner", projectId: "project", runId: "run-1" };
    await reserveFreeRecapInTransaction(state.tx, firstUser);
    expect(state.wallet).toMatchObject({ granted: 5, reserved: 1, consumed: 0 });

    // A campaign decrease does not claw back an existing user's snapshot.
    state.campaign.freeRecapCount = 1;
    await reserveFreeRecapInTransaction(state.tx, { ...firstUser, runId: "run-2" });
    expect(state.wallet).toMatchObject({ granted: 5, reserved: 2, consumed: 0 });

    // A user whose wallet is first created after the edit receives the new count.
    await reserveFreeRecapInTransaction(state.tx, { userId: "new-owner", projectId: "project-2", runId: "run-3" });
    expect(state.wallets.get("new-owner")).toMatchObject({ granted: 1, reserved: 1, consumed: 0 });
    expect(state.events.filter((event) => event.type === "GRANT").map((event) => event.amount)).toEqual([5, 1]);
  });

  it("does not reserve when the active campaign is configured with zero recaps", async () => {
    const state = makeTransaction(0);
    await expect(reserveFreeRecapInTransaction(state.tx, { userId: "owner", projectId: "project", runId: "run-1" }))
      .rejects.toThrow("currently grants zero recaps");
    expect(state.wallet).toBeNull();
  });
});
