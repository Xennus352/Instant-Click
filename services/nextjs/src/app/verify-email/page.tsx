import { AuthFlow } from '@/components/auth-flow';

export default function VerifyEmailPage({ searchParams }: { searchParams?: { email?: string | string[] } }) {
  const email = typeof searchParams?.email === 'string' ? searchParams.email : '';
  return <AuthFlow mode="verify" initialEmail={email} />;
}
