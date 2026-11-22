import { PipelineRepository } from "../../src/repositories/PipelineRepository";
import { prisma } from "../../src/lib/prisma";
import { captureFreeRecapInTransaction } from "../../src/services/PromoEntitlementService";

jest.mock("../../src/lib/prisma", () => ({ prisma: { jobRecord: { findUnique: jest.fn() }, $transaction: jest.fn() } }));
jest.mock("../../src/services/PromoEntitlementService", () => ({
  reserveFreeRecapInTransaction: jest.fn(), releaseFreeRecapInTransaction: jest.fn(),
  captureFreeRecapInTransaction: jest.fn(async () => undefined),
}));

describe("final render settlement", () => {
  it("persists render and private gallery before capturing, and duplicate callback is idempotent", async () => {
    const events: string[] = [];
    const data = {
      runId: "pipeline_aaaaaaaaaaaaaaaaaaaaaaaa_aabbccddeeff00112233445566778899",
      stage: "render", projectId: "aaaaaaaaaaaaaaaaaaaaaaaa", ownerId: "bbbbbbbbbbbbbbbbbbbbbbbb",
      assetId: "cccccccccccccccccccccccc", bucket: "instantcap", assetKey: "movie-assets/private.mp4",
      idempotencyDigest: "aabbccddeeff00112233445566778899",
    };
    let status = "ACTIVE";
    const current = () => ({ jobId: `${data.runId}_render`, name: "render", data, status, timestamp: new Date(), processedOn: new Date() });
    const tx = {
      jobRecord: {
        findUnique: jest.fn(async () => current()),
        update: jest.fn(async ({ data: update }) => { events.push("job-complete"); status = update.status; return current(); }),
      },
      movieProject: {
        findFirst: jest.fn(async () => ({ title: "Private recap" })),
        updateMany: jest.fn(async () => { events.push("project-complete"); return { count: 1 }; }),
      },
      narration: { findUnique: jest.fn(async () => ({ id: "dddddddddddddddddddddddd" })) },
      subtitle: { findFirst: jest.fn(async () => ({ id: "eeeeeeeeeeeeeeeeeeeeeeee" })) },
      videoRender: { create: jest.fn(async () => { events.push("render-persisted"); return { id: "ffffffffffffffffffffffff" }; }) },
      galleryEntry: { create: jest.fn(async () => { events.push("gallery-persisted"); return {}; }) },
    };
    (prisma.jobRecord.findUnique as jest.Mock).mockImplementation(async () => current());
    (prisma.$transaction as jest.Mock).mockImplementation(async (callback) => callback(tx));
    (captureFreeRecapInTransaction as jest.Mock).mockImplementation(async () => { events.push("reservation-captured"); });

    const result = {
      executionMode: "production" as const, outputKey: `${data.projectId}/renders/${data.runId}/final.mp4`,
      duration: 30, fileSize: 1024, resolution: "1080p", fps: 30, codec: "h264",
    };
    const completed = await PipelineRepository.completeStage(`${data.runId}_render`, result, { checksumSHA256: "verified-hash" });
    expect(completed?.status).toBe("COMPLETED");
    expect(events.indexOf("render-persisted")).toBeLessThan(events.indexOf("gallery-persisted"));
    expect(events.indexOf("gallery-persisted")).toBeLessThan(events.indexOf("project-complete"));
    expect(events.indexOf("project-complete")).toBeLessThan(events.indexOf("job-complete"));
    expect(events.indexOf("job-complete")).toBeLessThan(events.indexOf("reservation-captured"));
    expect(captureFreeRecapInTransaction).toHaveBeenCalledTimes(1);

    await PipelineRepository.completeStage(`${data.runId}_render`, result, { checksumSHA256: "verified-hash" });
    expect(captureFreeRecapInTransaction).toHaveBeenCalledTimes(1);
    expect(tx.videoRender.create).toHaveBeenCalledTimes(1);
  });
});
