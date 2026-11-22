import { timingSafeEqual } from "node:crypto";

export function isInternalServiceRequest(request: Request) {
  const expected = process.env.INTERNAL_API_KEY;
  const supplied = request.headers.get("x-internal-api-key");
  if (!expected || expected.length < 32 || !supplied || supplied.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

export function internalServiceAuthError(request: Request): Response | null {
  if (!process.env.INTERNAL_API_KEY || process.env.INTERNAL_API_KEY.length < 32) {
    return Response.json({ error: { code: "INTERNAL_AUTH_UNCONFIGURED", message: "Internal billing endpoint is unavailable" } }, { status: 503 });
  }
  if (!isInternalServiceRequest(request)) {
    return Response.json({ error: { code: "UNAUTHENTICATED_SERVICE", message: "Internal service authentication required" } }, { status: 401 });
  }
  return null;
}
