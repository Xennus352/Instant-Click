import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { prisma } from "@/lib/prisma";
import { escapeHtml, sendAuthEmail } from "@/lib/auth-email";

export class AuthConfigurationError extends Error {
  readonly code = "AUTH_CONFIGURATION_UNAVAILABLE";
  constructor(message: string) { super(message); this.name = "AuthConfigurationError"; }
}

let authInstance: ReturnType<typeof betterAuth> | undefined;

/** Build-time imports stay side-effect free; validate secrets when an auth request arrives. */
export function getAuth() {
  if (authInstance) return authInstance;
  const authSecret = process.env.AUTH_SECRET;
  if (!authSecret || authSecret.length < 32) {
    throw new AuthConfigurationError("AUTH_SECRET must be configured with at least 32 characters before authentication is available");
  }
  let appUrl: URL;
  try { appUrl = new URL(process.env.APP_URL ?? "http://localhost:3000"); }
  catch { throw new AuthConfigurationError("APP_URL must be a valid absolute URL before authentication is available"); }
  const google = process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET
    ? { clientId: process.env.AUTH_GOOGLE_ID, clientSecret: process.env.AUTH_GOOGLE_SECRET }
    : undefined;
  const github = process.env.AUTH_GITHUB_ID && process.env.AUTH_GITHUB_SECRET
    ? { clientId: process.env.AUTH_GITHUB_ID, clientSecret: process.env.AUTH_GITHUB_SECRET }
    : undefined;

  authInstance = betterAuth({
    appName: "InstantCap",
    baseURL: appUrl.origin,
    secret: authSecret,
    trustedOrigins: [appUrl.origin],
    database: prismaAdapter(prisma, { provider: "mongodb" }),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      sendResetPassword: async ({ user, url }) => {
        await sendAuthEmail({
          to: user.email,
          subject: "Reset your InstantCap password",
          text: `Use this link to reset your password. It expires shortly: ${url}`,
          html: `<p>Use this link to reset your password. It expires shortly:</p><p><a href="${escapeHtml(url)}">Reset password</a></p>`,
        });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      sendVerificationEmail: async ({ user, url }) => {
        await sendAuthEmail({
          to: user.email,
          subject: "Verify your InstantCap email",
          text: `Verify your email address: ${url}`,
          html: `<p>Verify your email address:</p><p><a href="${escapeHtml(url)}">Verify email</a></p>`,
        });
      },
      sendOnSignIn: true,
      autoSignInAfterVerification: true,
    },
    socialProviders: { ...(google ? { google } : {}), ...(github ? { github } : {}) },
    user: {
      modelName: "User",
      additionalFields: { role: { type: "string", required: false, defaultValue: "USER", input: false } },
    },
    session: {
      modelName: "Session",
      fields: { token: "sessionToken", expiresAt: "expires" },
      expiresIn: 60 * 60 * 24 * 14,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: false },
    },
    account: {
      modelName: "Account",
      fields: {
        providerId: "provider", accountId: "providerAccountId", accessToken: "access_token",
        refreshToken: "refresh_token", accessTokenExpiresAt: "expires_at",
        refreshTokenExpiresAt: "refresh_token_expires_at", idToken: "id_token",
        tokenType: "token_type", sessionState: "session_state",
      },
      additionalFields: { type: { type: "string", required: false, defaultValue: "credential", input: false } },
    },
    verification: { modelName: "VerificationToken", fields: { value: "token", expiresAt: "expires" } },
    advanced: {
      database: { generateId: false },
      useSecureCookies: appUrl.protocol === "https:",
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", secure: appUrl.protocol === "https:", path: "/" },
    },
  }) as unknown as ReturnType<typeof betterAuth>;
  return authInstance!;
}

export type AuthSession = {
  session: { id: string; expiresAt: Date; [key: string]: unknown };
  user: { id: string; email: string; emailVerified: boolean; name: string; role?: string; [key: string]: unknown };
};
