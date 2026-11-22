import { ZodError } from "zod";
import { AuthConfigurationError } from "@/lib/auth";
import {
  AuthenticationError,
  AccountDisabledError,
  AuthorizationError,
  EmailVerificationRequiredError,
} from "@/lib/middleware/auth-session";
import {
  IdempotencyConflictError,
  InsufficientCreditsError,
  InvalidRefundError,
  InvalidReservationError,
  WalletBackfillRequiredError,
  WalletMutationConflictError,
} from "@/services/CreditWalletService";
import { CreditOperationNotAllowedError, CreditProjectNotFoundError, CreditUserNotFoundError } from "@/services/CreditQueryService";
import { PipelineError } from "@/services/PipelineService";
import {
  MovieUploadValidationError,
  MovieUploadSessionError,
  ObjectStorageConfigurationError,
  StoredObjectNotFoundError,
} from "@/lib/storage/errors";

export class RequestBodyTooLargeError extends Error {
  constructor() { super("Request body is too large"); this.name = "RequestBodyTooLargeError"; }
}

export function errorResponse(error: unknown) {
  if (error instanceof AuthConfigurationError) {
    return Response.json({ error: { code: error.code, message: error.message } }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  if (error instanceof AccountDisabledError) {
    return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status });
  }
  if (error instanceof AuthenticationError) {
    return Response.json({ error: { code: "UNAUTHENTICATED", message: error.message } }, { status: 401 });
  }
  if (error instanceof AuthorizationError) {
    return Response.json({ error: { code: "FORBIDDEN", message: error.message } }, { status: 403 });
  }
  if (error instanceof EmailVerificationRequiredError) {
    return Response.json({ error: { code: error.code, message: error.message } }, { status: 403 });
  }
  if (error instanceof CreditUserNotFoundError || error instanceof CreditProjectNotFoundError) {
    return Response.json({ error: { code: error.code, message: error.message } }, { status: 404 });
  }
  if (error instanceof CreditOperationNotAllowedError) {
    return Response.json({ error: { code: error.code, message: error.message } }, { status: 409 });
  }
  if (error instanceof PipelineError) {
    return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status });
  }
  if (error instanceof ZodError) {
    return Response.json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Request validation failed",
        details: error.issues.map(({ path, message }) => ({ path, message })),
      },
    }, { status: 400 });
  }
  if (error instanceof RequestBodyTooLargeError) {
    return Response.json({ error: { code: "BODY_TOO_LARGE", message: error.message } }, { status: 413 });
  }
  if (error instanceof ObjectStorageConfigurationError || error instanceof StoredObjectNotFoundError) {
    return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status });
  }
  if (error instanceof MovieUploadValidationError) {
    return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status });
  }
  if (error instanceof MovieUploadSessionError) {
    return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status });
  }
  if (error instanceof TypeError || error instanceof SyntaxError) {
    return Response.json({ error: { code: "INVALID_REQUEST", message: error.message } }, { status: 400 });
  }
  if (error instanceof InsufficientCreditsError) {
    return Response.json({ error: { code: error.code, message: error.message } }, { status: 409 });
  }
  if (
    error instanceof IdempotencyConflictError ||
    error instanceof InvalidReservationError ||
    error instanceof InvalidRefundError ||
    error instanceof WalletBackfillRequiredError ||
    error instanceof WalletMutationConflictError
  ) {
    return Response.json({ error: { code: error.code, message: error.message } }, { status: 409 });
  }
  console.error("API request failed", error);
  return Response.json({ error: { code: "INTERNAL_ERROR", message: "The request could not be completed" } }, { status: 500 });
}

export async function readJson(request: Request, maxBytes = 16 * 1024): Promise<unknown> {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > maxBytes) throw new RequestBodyTooLargeError();
  const reader = request.body?.getReader();
  if (!reader) throw new SyntaxError("Request body is required");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new RequestBodyTooLargeError();
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(body));
}
