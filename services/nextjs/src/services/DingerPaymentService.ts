import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const callbackPayloadSchema = z.object({
  totalAmount: z.union([z.number().int().positive(), z.string().regex(/^[1-9]\d{0,8}$/)]),
  transactionStatus: z.enum(["SUCCESS", "ERROR", "CANCELLED", "TIMEOUT", "DECLINED", "SYSTEM_ERROR"]),
  methodName: z.string().min(1).max(32),
  merchantOrderId: z.string().min(1).max(50),
  transactionId: z.string().min(1).max(160),
  providerName: z.string().min(1).max(64),
  customerName: z.string().max(160).optional(),
  createdAt: z.string().max(32).optional(),
}).strict();

export type DingerPaymentResult = z.infer<typeof callbackPayloadSchema> & { totalAmount: number; payloadHash: string };

export class DingerCallbackError extends Error {
  constructor(readonly code: "DINGER_CALLBACK_INVALID" | "DINGER_CALLBACK_UNVERIFIED", message: string) {
    super(message);
    this.name = "DingerCallbackError";
  }
}

/**
 * Dinger's production callback carries Base64 AES-256-ECB/PKCS7 ciphertext
 * plus SHA-256 of the exact decrypted JSON string. Never trust a browser redirect.
 */
export function verifyDingerCallback(input: { paymentResult: string; checksum: string; callbackKey: string }): DingerPaymentResult {
  if (!/^[A-Za-z0-9+/]{16,16384}={0,2}$/.test(input.paymentResult) || !/^[a-f\d]{64}$/i.test(input.checksum)) {
    throw new DingerCallbackError("DINGER_CALLBACK_INVALID", "Callback envelope is malformed");
  }
  if (Buffer.byteLength(input.callbackKey, "utf8") !== 32) {
    throw new DingerCallbackError("DINGER_CALLBACK_UNVERIFIED", "Dinger callback verification is not configured");
  }

  let plaintext: string;
  try {
    const cipherText = Buffer.from(input.paymentResult, "base64");
    if (cipherText.length === 0 || cipherText.length % 16 !== 0) throw new Error("invalid block length");
    const decipher = createDecipheriv("aes-256-ecb", Buffer.from(input.callbackKey, "utf8"), null);
    decipher.setAutoPadding(true);
    plaintext = Buffer.concat([decipher.update(cipherText), decipher.final()]).toString("utf8");
  } catch {
    throw new DingerCallbackError("DINGER_CALLBACK_UNVERIFIED", "Callback decryption failed");
  }

  const actual = createHash("sha256").update(plaintext, "utf8").digest();
  const expected = Buffer.from(input.checksum, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new DingerCallbackError("DINGER_CALLBACK_UNVERIFIED", "Callback checksum is invalid");
  }

  let parsed: unknown;
  try { parsed = JSON.parse(plaintext); } catch {
    throw new DingerCallbackError("DINGER_CALLBACK_INVALID", "Verified callback payload is not valid JSON");
  }
  const result = callbackPayloadSchema.safeParse(parsed);
  if (!result.success) throw new DingerCallbackError("DINGER_CALLBACK_INVALID", "Verified callback payload has an unsupported shape");
  const amount = Number(result.data.totalAmount);
  if (!Number.isSafeInteger(amount) || amount < 500 || amount > 999_999_999) {
    throw new DingerCallbackError("DINGER_CALLBACK_INVALID", "Dinger amount is outside the supported MMK range");
  }
  return { ...result.data, totalAmount: amount, payloadHash: actual.toString("hex") };
}

export function dingerProviderMethodIsSupported(providerName: string, methodName: string): boolean {
  const provider = providerName.trim().toLowerCase();
  const method = methodName.trim().toUpperCase();
  return (provider === "kbz pay" && ["QR", "PWA"].includes(method)) ||
    (provider === "wave pay" && method === "PIN") ||
    (provider === "uab pay" && method === "PIN");
}

export function dingerCallbackEnabled(): boolean {
  return process.env.DINGER_CALLBACKS_ENABLED === "true" && Boolean(process.env.DINGER_CALLBACK_KEY);
}
