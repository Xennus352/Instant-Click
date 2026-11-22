import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/middleware/auth-session';

export const dynamic = 'force-dynamic';

export default async function UserAppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession(headers());
  if (!session) redirect('/login?callbackURL=%2Fapp');
  if (!session.user.emailVerified) redirect('/verify-email');
  return children;
}
