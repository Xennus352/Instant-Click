import { getAuth, type AuthSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export type { AuthSession };

export class AuthenticationError extends Error {
  readonly status = 401;
  constructor(message = "Authentication required") { super(message); this.name = "AuthenticationError"; }
}

export class AuthorizationError extends Error {
  readonly status = 403;
  constructor(message = "Insufficient permissions") { super(message); this.name = "AuthorizationError"; }
}

export class EmailVerificationRequiredError extends Error {
  readonly status = 403;
  readonly code = "EMAIL_VERIFICATION_REQUIRED";
  constructor() {
    super("Verify your email address before using the application");
    this.name = "EmailVerificationRequiredError";
  }
}

export class AccountDisabledError extends Error {
  readonly status = 403;
  readonly code = "ACCOUNT_DISABLED";
  constructor() { super("This account is not active"); this.name = "AccountDisabledError"; }
}

export async function getSession(headers: Headers): Promise<AuthSession | null> {
  return await getAuth().api.getSession({ headers }) as AuthSession | null;
}

export async function requireSession(headers: Headers): Promise<NonNullable<AuthSession>> {
  const session = await getSession(headers);
  if (!session) throw new AuthenticationError();
  if (!session.user.emailVerified) throw new EmailVerificationRequiredError();
  const account = await prisma.user.findUnique({ where: { id: session.user.id }, select: { accountStatus: true, role: true } });
  if (!account) throw new AuthenticationError();
  // Missing/null legacy status fails closed until the explicit backfill sets ACTIVE.
  if (account.accountStatus !== "ACTIVE") throw new AccountDisabledError();
  // Authorization must use the current database role, not a role copied into
  // a long-lived session before an administrator changed that user's access.
  return { ...session, user: { ...session.user, role: account.role } };
}

export type ApplicationRole = "USER" | "ADMIN" | "SUPER_ADMIN" | "SUPPORT" | "FINANCE";

export function requireRole(session: NonNullable<AuthSession>, ...roles: ApplicationRole[]) {
  const role = String(session.user.role ?? "USER").toUpperCase();
  if (!roles.includes(role as ApplicationRole)) throw new AuthorizationError();
  return session;
}

export function requireOwnership(session: NonNullable<AuthSession>, ownerId: string) {
  if (session.user.id !== ownerId && String(session.user.role ?? "").toUpperCase() !== "ADMIN") {
    throw new AuthorizationError("This resource does not belong to the current user");
  }
}
