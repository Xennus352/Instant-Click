import { NextRequest, NextResponse } from "next/server";

const appOrigin = new URL(process.env.APP_URL ?? "http://localhost:3000").origin;
const methods = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
const allowedHeaders = "Content-Type, Authorization, Idempotency-Key, X-Requested-With";

export function middleware(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (origin && origin !== appOrigin) {
    return NextResponse.json({ error: { code: "ORIGIN_NOT_ALLOWED", message: "Request origin is not allowed" } }, { status: 403 });
  }

  if (request.method === "OPTIONS") {
    const response = new NextResponse(null, { status: 204 });
    if (origin === appOrigin) {
      response.headers.set("Access-Control-Allow-Origin", appOrigin);
      response.headers.set("Access-Control-Allow-Credentials", "true");
      response.headers.set("Access-Control-Allow-Methods", methods);
      response.headers.set("Access-Control-Allow-Headers", allowedHeaders);
      response.headers.set("Access-Control-Max-Age", "600");
      response.headers.append("Vary", "Origin");
    }
    return response;
  }

  if (request.nextUrl.pathname.startsWith("/api/auth/") && Number(request.headers.get("content-length") ?? 0) > 16 * 1024) {
    return NextResponse.json({ error: { code: "BODY_TOO_LARGE", message: "Auth request body is too large" } }, { status: 413 });
  }

  const response = NextResponse.next();
  if (origin === appOrigin) {
    response.headers.set("Access-Control-Allow-Origin", appOrigin);
    response.headers.set("Access-Control-Allow-Credentials", "true");
    response.headers.append("Vary", "Origin");
  }
  return response;
}

export const config = { matcher: ["/api/:path*"] };
