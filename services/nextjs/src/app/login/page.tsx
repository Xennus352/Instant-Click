import { AuthFlow } from '@/components/auth-flow';

export default function LoginPage() {
  return <AuthFlow mode="login" providers={{ google: Boolean(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET), github: Boolean(process.env.AUTH_GITHUB_ID && process.env.AUTH_GITHUB_SECRET) }} />;
}
