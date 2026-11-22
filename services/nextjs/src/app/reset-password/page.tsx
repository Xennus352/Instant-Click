import { AuthFlow } from '@/components/auth-flow';

export default function ResetPasswordPage({ searchParams }: { searchParams?: { token?: string | string[]; error?: string | string[] } }) {
  const token = typeof searchParams?.token === 'string' ? searchParams.token : '';
  const resetError = typeof searchParams?.error === 'string' && searchParams.error.length > 0;
  return <AuthFlow mode="reset" resetToken={token} resetError={resetError} />;
}
