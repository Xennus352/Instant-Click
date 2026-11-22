import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { AdminDashboard } from '@/components/admin-dashboard';
import { AccountDisabledError, AuthenticationError, EmailVerificationRequiredError, requireSession, type AuthSession } from '@/lib/middleware/auth-session';

export const dynamic = 'force-dynamic';

const portalRoles = ['ADMIN', 'SUPER_ADMIN', 'FINANCE'] as const;

export default async function PortalPage() {
  let session: NonNullable<AuthSession>;
  try {
    session = await requireSession(headers());
  } catch (error) {
    if (error instanceof AuthenticationError) redirect('/login?callbackURL=%2Fportal');
    if (error instanceof EmailVerificationRequiredError) redirect('/verify-email?callbackURL=%2Fportal');
    if (error instanceof AccountDisabledError) redirect('/login?callbackURL=%2Fportal&error=account-disabled');
    throw error;
  }

  const role = String(session.user.role ?? 'USER').toUpperCase();
  if (!portalRoles.includes(role as (typeof portalRoles)[number])) redirect('/app');

  const actorRole = role === 'SUPER_ADMIN' || role === 'FINANCE' ? role : 'ADMIN';
  return <AdminDashboard actorRole={actorRole} actorUserId={String(session.user.id ?? '')} />;
}
