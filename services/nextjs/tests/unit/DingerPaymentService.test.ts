import { createCipheriv, createHash } from "node:crypto";
import { dingerCallbackEnabled, dingerProviderMethodIsSupported, verifyDingerCallback } from "../../src/services/DingerPaymentService";

const key = "0123456789abcdef0123456789abcdef";
const payload = JSON.stringify({
  totalAmount: 1200,
  transactionStatus: "SUCCESS",
  methodName: "QR",
  merchantOrderId: "012345678901234567890123",
  transactionId: "dinger-txn-1",
  providerName: "KBZ Pay",
  customerName: "Test",
});

function envelope(plainText = payload) {
  const cipher = createCipheriv("aes-256-ecb", Buffer.from(key), null);
  cipher.setAutoPadding(true);
  const paymentResult = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]).toString("base64");
  return { paymentResult, checksum: createHash("sha256").update(plainText).digest("hex"), callbackKey: key };
}

describe("Dinger callback verification", () => {
  it("decrypts, verifies and validates a signed callback", () => {
    const result = verifyDingerCallback(envelope());
    expect(result).toMatchObject({ totalAmount: 1200, transactionStatus: "SUCCESS", transactionId: "dinger-txn-1" });
    expect(result.payloadHash).toBe(envelope().checksum);
    expect(dingerProviderMethodIsSupported("KBZ Pay", "QR")).toBe(true);
    expect(dingerProviderMethodIsSupported("Wave Pay", "PIN")).toBe(true);
    expect(dingerProviderMethodIsSupported("UAB Pay", "PIN")).toBe(true);
    expect(dingerProviderMethodIsSupported("Wave Pay", "QR")).toBe(false);
  });

  it("rejects a bad checksum and an out-of-range payment", () => {
    expect(() => verifyDingerCallback({ ...envelope(), checksum: "0".repeat(64) })).toThrow("checksum is invalid");
    const low = JSON.stringify({ ...JSON.parse(payload), totalAmount: 499 });
    expect(() => verifyDingerCallback(envelope(low))).toThrow("outside the supported MMK range");
  });

  it("keeps callback processing disabled by default", () => {
    const previousFlag = process.env.DINGER_CALLBACKS_ENABLED;
    const previousKey = process.env.DINGER_CALLBACK_KEY;
    delete process.env.DINGER_CALLBACKS_ENABLED;
    delete process.env.DINGER_CALLBACK_KEY;
    try {
      expect(dingerCallbackEnabled()).toBe(false);
    } finally {
      if (previousFlag === undefined) delete process.env.DINGER_CALLBACKS_ENABLED;
      else process.env.DINGER_CALLBACKS_ENABLED = previousFlag;
      if (previousKey === undefined) delete process.env.DINGER_CALLBACK_KEY;
      else process.env.DINGER_CALLBACK_KEY = previousKey;
    }
  });
});
