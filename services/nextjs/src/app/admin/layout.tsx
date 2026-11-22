import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/middleware/auth-session';

export const dynamic = 'force-dynamic';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession(headers());
  if (!session) redirect('/login?callbackURL=%2Fportal');
  if (!['ADMIN', 'SUPER_ADMIN', 'FINANCE'].includes(String(session.user.role ?? 'USER').toUpperCase())) redirect('/app');
  return children;
}
