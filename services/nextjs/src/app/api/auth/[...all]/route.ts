import { toNextJsHandler } from "better-auth/next-js";
import type { ZodType } from "zod";
import { AuthConfigurationError, getAuth } from "@/lib/auth";
import { isAuthEmailConfigured } from "@/lib/auth-email";
import {
  forgotPasswordSchema,
  resetPasswordSchema,
  sendVerificationSchema,
  signInSchema,
  signUpSchema,
  socialSignInSchema,
} from "@/lib/schemas/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
function authUnavailable(error: unknown) {
  if (error instanceof AuthConfigurationError) {
    return Response.json({ error: { code: error.code, message: error.message } }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  return Response.json({ error: { code: "AUTH_UNAVAILABLE", message: "Authentication is temporarily unavailable" } }, { status: 503, headers: { "Cache-Control": "no-store" } });
}
async function dispatch(method: "GET" | "POST", request: Request) {
  try {
    const handlers = toNextJsHandler(getAuth());
    return method === "GET" ? handlers.GET(request) : handlers.POST(request);
  } catch (error) { return authUnavailable(error); }
}
const schemas: Record<string, ZodType> = {
  "/api/auth/sign-up/email": signUpSchema,
  "/api/auth/sign-in/email": signInSchema,
  "/api/auth/forget-password": forgotPasswordSchema,
  "/api/auth/reset-password": resetPasswordSchema,
  "/api/auth/send-verification-email": sendVerificationSchema,
  "/api/auth/sign-in/social": socialSignInSchema,
};

const appOrigin = new URL(process.env.APP_URL ?? "http://localhost:3000").origin;
const maxAuthBodyBytes = 16 * 1024;

async function validatedPost(request: Request) {
  const url = new URL(request.url);
  const schema = schemas[url.pathname];
  if (!schema) return dispatch("POST", request);
  if (["/api/auth/sign-up/email", "/api/auth/forget-password", "/api/auth/send-verification-email"].includes(url.pathname) && !isAuthEmailConfigured()) {
    return Response.json({ error: { code: "AUTH_EMAIL_UNAVAILABLE", message: "Email verification and recovery are unavailable until the email sender is configured" } }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }

  let input: unknown;
  try {
    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (contentLength > maxAuthBodyBytes) {
      return Response.json({ error: { code: "BODY_TOO_LARGE", message: "Auth request body is too large" } }, { status: 413 });
    }
    const reader = request.body?.getReader();
    if (!reader) throw new Error("Missing request body");
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxAuthBodyBytes) {
        await reader.cancel();
        return Response.json({ error: { code: "BODY_TOO_LARGE", message: "Auth request body is too large" } }, { status: 413 });
      }
      chunks.push(value);
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    input = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return Response.json({ error: { code: "INVALID_JSON", message: "Request body must be valid JSON" } }, { status: 400 });
  }
  const result = schema.safeParse(input);
  if (!result.success) {
    return Response.json({ error: { code: "VALIDATION_ERROR", message: "Request validation failed", details: result.error.issues.map(({ path, message }) => ({ path, message })) } }, { status: 400 });
  }
  const callbackValues = [result.data.callbackURL, result.data.redirectTo, result.data.errorCallbackURL, result.data.newUserCallbackURL];
  if (callbackValues.some((callback) => typeof callback === "string" && new URL(callback).origin !== appOrigin)) {
    return Response.json({ error: { code: "INVALID_CALLBACK_URL", message: "Callback URLs must use the application origin" } }, { status: 400 });
  }
  const headers = new Headers(request.headers);
  headers.set("content-type", "application/json");
  const validatedRequest = new Request(request.url, { method: request.method, headers, body: JSON.stringify(result.data), redirect: request.redirect });
  return dispatch("POST", validatedRequest);
}

export async function GET(request: Request) { return dispatch("GET", request); }
export const POST = validatedPost;
