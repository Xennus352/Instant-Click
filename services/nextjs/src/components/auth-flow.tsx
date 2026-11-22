'use client';

import { ArrowLeft, ArrowRight, Clapperboard, Eye, EyeOff, LoaderCircle, MailCheck } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { notify } from '@/components/notification-island';

type AuthMode = 'login' | 'register' | 'verify' | 'forgot' | 'reset';
type ProviderSet = { google?: boolean; github?: boolean };

type AuthFlowProps = {
  mode: AuthMode;
  initialEmail?: string;
  resetToken?: string;
  resetError?: boolean;
  providers?: ProviderSet;
};

type AuthPayload = Record<string, unknown>;

const emailSchema = z.string().trim().max(254).email();
const passwordSchema = z.string().min(12).max(128);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function responseError(payload: unknown): { message: string; code: string } {
  if (!isRecord(payload)) return { message: '', code: '' };
  const nested = isRecord(payload.error) ? payload.error : payload;
  return {
    message: typeof nested.message === 'string' ? nested.message : '',
    code: typeof nested.code === 'string' ? nested.code.toUpperCase() : '',
  };
}

function callbackUrl(): string {
  const fallback = new URL('/app', window.location.origin);
  const requested = new URLSearchParams(window.location.search).get('callbackURL');
  if (!requested) return fallback.href;
  try {
    const candidate = new URL(requested, window.location.origin);
    const isAppPath = candidate.pathname === '/app' || candidate.pathname.startsWith('/app/');
    const isPortalPath = candidate.pathname === '/portal';
    return candidate.origin === window.location.origin && (isAppPath || isPortalPath) ? candidate.href : fallback.href;
  } catch {
    return fallback.href;
  }
}

function loginHrefForCallback(): string {
  const destination = new URL(callbackUrl());
  const path = `${destination.pathname}${destination.search}${destination.hash}`;
  return `/login?callbackURL=${encodeURIComponent(path)}`;
}

async function postAuth(path: string, body: AuthPayload): Promise<{ response: Response; payload: unknown }> {
  const response = await fetch(`/api/auth/${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  return { response, payload };
}

export function AuthFlow({ mode, initialEmail = '', resetToken = '', resetError = false, providers = {} }: AuthFlowProps) {
  const [activeMode, setActiveMode] = useState<AuthMode>(mode);
  const [email, setEmail] = useState(initialEmail);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(resetError ? 'This password reset link is invalid or expired. Request a new link to continue.' : '');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    if (error) notify({ tone: 'error', title: 'Account request needs attention', message: error, durationMs: 7000 });
  }, [error]);

  useEffect(() => {
    if (notice) notify({ tone: 'success', title: 'Account update', message: notice, durationMs: 6500 });
  }, [notice]);

  const titles: Record<AuthMode, string> = {
    login: 'Sign in to your account',
    register: 'Create your account',
    verify: 'Verify your email',
    forgot: 'Reset your password',
    reset: 'Choose a new password',
  };
  const descriptions: Record<AuthMode, string> = {
    login: 'Use the email address you verified for InstantCap.',
    register: 'We will email a verification link before the workspace opens.',
    verify: 'Request a new verification link if you need one.',
    forgot: 'We will send a reset link if this address has an account.',
    reset: 'Choose a password with at least 12 characters.',
  };

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setNotice('');

    const normalizedEmail = email.trim().toLowerCase();
    if (activeMode !== 'reset') {
      const parsedEmail = emailSchema.safeParse(normalizedEmail);
      if (!parsedEmail.success) {
        setError('Enter a valid email address.');
        return;
      }
    }
    if (activeMode === 'register') {
      if (!name.trim()) {
        setError('Enter your name.');
        return;
      }
      if (name.trim().length > 100) {
        setError('Your name must be 100 characters or fewer.');
        return;
      }
      if (!passwordSchema.safeParse(password).success) {
        setError('Use a password between 12 and 128 characters.');
        return;
      }
    }
    if (activeMode === 'login' && !password) {
      setError('Enter your password.');
      return;
    }
    if (activeMode === 'forgot') {
      setBusy(true);
      try {
        const { response, payload } = await postAuth('request-password-reset', {
          email: normalizedEmail,
          redirectTo: new URL('/reset-password', window.location.origin).href,
        });
        if (!response.ok) {
          const issue = responseError(payload);
          throw new Error(issue.message || 'We could not request a reset link. Try again.');
        }
        setNotice('If this email can receive account mail, a password reset link has been sent.');
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : 'We could not request a reset link. Try again.');
      } finally {
        setBusy(false);
      }
      return;
    }
    if (activeMode === 'verify') {
      setBusy(true);
      try {
        const { response, payload } = await postAuth('send-verification-email', {
          email: normalizedEmail,
          callbackURL: callbackUrl(),
        });
        if (!response.ok) {
          const issue = responseError(payload);
          throw new Error(issue.message || 'We could not send a verification link. Try again.');
        }
        setNotice('If this address needs verification, a new link has been sent. Check your inbox.');
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : 'We could not send a verification link. Try again.');
      } finally {
        setBusy(false);
      }
      return;
    }
    if (activeMode === 'reset') {
      if (!resetToken) {
        setError('Open the password reset link from your email to choose a new password.');
        return;
      }
      if (!passwordSchema.safeParse(password).success) {
        setError('Use a password between 12 and 128 characters.');
        return;
      }
      setBusy(true);
      try {
        const { response, payload } = await postAuth('reset-password', { token: resetToken, newPassword: password });
        if (!response.ok) {
          const issue = responseError(payload);
          throw new Error(issue.message || 'We could not reset your password. Request a new link and try again.');
        }
        setPassword('');
        setActiveMode('login');
        setNotice('Password updated. Sign in with your new password.');
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : 'We could not reset your password. Request a new link and try again.');
      } finally {
        setBusy(false);
      }
      return;
    }

    setBusy(true);
    try {
      const path = activeMode === 'register' ? 'sign-up/email' : 'sign-in/email';
      const body = activeMode === 'register'
        ? { name: name.trim(), email: normalizedEmail, password, callbackURL: callbackUrl() }
        : { email: normalizedEmail, password, rememberMe: true, callbackURL: callbackUrl() };
      const { response, payload } = await postAuth(path, body);
      if (!response.ok) {
        const issue = responseError(payload);
        if (issue.code.includes('EMAIL_NOT_VERIFIED')) {
          setActiveMode('verify');
          setNotice('Verify your email before signing in. You can request another link below.');
          return;
        }
        throw new Error(issue.message || (activeMode === 'register' ? 'We could not create the account. Try again.' : 'Email or password was not accepted.'));
      }
      if (activeMode === 'register') {
        setActiveMode('verify');
        setNotice('Check your inbox for a verification link before signing in.');
        setPassword('');
        return;
      }
      window.location.assign(callbackUrl());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The request could not be completed. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  async function signInWithProvider(provider: 'google' | 'github') {
    setError('');
    setNotice('');
    setBusy(true);
    try {
      const { response, payload } = await postAuth('sign-in/social', { provider, callbackURL: callbackUrl() });
      if (!response.ok || !isRecord(payload)) {
        const issue = responseError(payload);
        throw new Error(issue.message || `${provider} sign-in is unavailable.`);
      }
      const data = isRecord(payload.data) ? payload.data : payload;
      if (typeof data.url !== 'string') throw new Error('The sign-in provider did not return a redirect link.');
      window.location.assign(data.url);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The sign-in request could not be completed.');
      setBusy(false);
    }
  }

  const showName = activeMode === 'register';
  const showPasswordField = activeMode === 'login' || activeMode === 'register' || activeMode === 'reset';
  const showEmailField = activeMode !== 'reset';
  const isVerification = activeMode === 'verify';

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 sm:px-8">
        <Link href="/" className="inline-flex items-center gap-3 rounded-md font-semibold tracking-tight focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-primary text-primary-foreground"><Clapperboard aria-hidden="true" size={18} /></span>
          instantcap
        </Link>
        <Link href={activeMode === 'login' ? '/register' : '/login'} className="rounded-md px-2 py-2 text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
          {activeMode === 'login' ? 'Create an account' : 'Sign in'}
        </Link>
      </header>

      <div className="mx-auto grid min-h-[calc(100svh-4rem)] max-w-6xl items-center gap-10 px-5 pb-12 pt-4 sm:px-8 lg:grid-cols-[1fr_0.8fr] lg:gap-16">
        <section className="hidden max-w-xl lg:block">
          <p className="text-sm font-medium text-primary">Movie project workspace</p>
          <h1 className="mt-4 text-5xl font-medium leading-[1.08] tracking-[-0.05em]">Sign in to continue your movie projects</h1>
          <p className="mt-5 text-base leading-7 text-muted-foreground">Your workspace opens after email verification. Project status and saved processing results come from the server.</p>
          <div className="mt-8 rounded-2xl border border-border bg-card/80 p-5 shadow-sm backdrop-blur-xl">
            <ol className="space-y-4">
              {['Upload a source video', 'Track server-reported status', 'Review saved outputs'].map((step, index) => (
                <li key={step} className="flex items-center gap-3 text-sm font-medium">
                  <span className="grid h-8 w-8 place-items-center rounded-full border border-border bg-background text-xs text-muted-foreground">{index + 1}</span>
                  {step}
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section aria-labelledby="auth-heading" className="mx-auto w-full max-w-md rounded-[26px] border border-border bg-card/90 p-5 shadow-[0_24px_70px_rgba(25,48,54,0.09)] backdrop-blur-xl sm:p-8">
          <div className="mb-7">
            {isVerification && <span className="mb-4 grid h-11 w-11 place-items-center rounded-2xl bg-primary/10 text-primary"><MailCheck aria-hidden="true" size={21} /></span>}
            <h2 id="auth-heading" className="text-2xl font-semibold tracking-tight">{titles[activeMode]}</h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">{descriptions[activeMode]}</p>
          </div>

          {error && <p role="alert" className="mb-4 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm leading-6 text-destructive">{error}</p>}
          {notice && <p role="status" className="mb-4 rounded-xl border border-primary/25 bg-primary/5 px-4 py-3 text-sm leading-6">{notice}</p>}

          {activeMode === 'reset' && !resetToken ? (
            <div className="space-y-4">
              <p className="rounded-xl border border-border bg-muted/40 p-4 text-sm leading-6 text-muted-foreground">Open the reset link from your email to set a new password.</p>
              <Link href="/forgot-password" className="inline-flex items-center gap-2 text-sm font-medium text-primary underline-offset-4 hover:underline"><ArrowLeft aria-hidden="true" size={15} /> Request another link</Link>
            </div>
          ) : (
            <form onSubmit={submit} noValidate aria-busy={busy} className="space-y-4">
              {showName && (
                <div>
                  <label htmlFor="auth-name" className="mb-1.5 block text-sm font-medium">Name</label>
                  <input id="auth-name" autoComplete="name" maxLength={100} required value={name} onChange={(event) => setName(event.target.value)} disabled={busy} className="h-12 w-full rounded-xl border border-input bg-background px-3.5 text-sm outline-none transition-shadow placeholder:text-muted-foreground/70 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60" />
                </div>
              )}
              {showEmailField && (
                <div>
                  <label htmlFor="auth-email" className="mb-1.5 block text-sm font-medium">Email address</label>
                  <input id="auth-email" type="email" inputMode="email" autoComplete="email" maxLength={254} required value={email} onChange={(event) => setEmail(event.target.value)} disabled={busy} className="h-12 w-full rounded-xl border border-input bg-background px-3.5 text-sm outline-none transition-shadow placeholder:text-muted-foreground/70 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60" />
                </div>
              )}
              {showPasswordField && (
                <div>
                  <label htmlFor="auth-password" className="mb-1.5 block text-sm font-medium">{activeMode === 'reset' ? 'New password' : 'Password'}</label>
                  <div className="relative">
                    <input id="auth-password" type={showPassword ? 'text' : 'password'} autoComplete={activeMode === 'login' ? 'current-password' : 'new-password'} minLength={activeMode === 'login' ? 1 : 12} maxLength={128} required value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy} className="h-12 w-full rounded-xl border border-input bg-background px-3.5 pr-12 text-sm outline-none transition-shadow placeholder:text-muted-foreground/70 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60" />
                    <button type="button" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? 'Hide password' : 'Show password'} className="absolute inset-y-0 right-0 grid w-11 place-items-center rounded-r-xl text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-ring disabled:opacity-60" disabled={busy}>
                      {showPassword ? <EyeOff aria-hidden="true" size={17} /> : <Eye aria-hidden="true" size={17} />}
                    </button>
                  </div>
                  {activeMode !== 'login' && <p className="mt-1.5 text-sm text-muted-foreground">Use 12–128 characters.</p>}
                </div>
              )}

              <button type="submit" disabled={busy} className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary px-5 text-sm font-semibold text-primary-foreground transition-transform hover:-translate-y-0.5 active:translate-y-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60">
                {busy && <LoaderCircle aria-hidden="true" size={16} className="animate-spin" />}
                {activeMode === 'login' ? 'Sign in' : activeMode === 'register' ? 'Create account' : activeMode === 'verify' ? 'Send verification link' : activeMode === 'forgot' ? 'Send reset link' : 'Update password'}
                {!busy && <ArrowRight aria-hidden="true" size={16} />}
              </button>
            </form>
          )}

          {(activeMode === 'login' || activeMode === 'register') && (providers.google || providers.github) && (
            <div className="mt-5 space-y-3">
              <div className="relative py-2 text-center text-sm text-muted-foreground"><span className="bg-card px-3">Or continue with</span><span aria-hidden="true" className="absolute inset-x-0 top-1/2 -z-10 border-t border-border" /></div>
              <div className="grid gap-3 sm:grid-cols-2">
                {providers.google && <button type="button" onClick={() => void signInWithProvider('google')} disabled={busy} className="min-h-11 rounded-xl border border-border bg-background px-3 text-sm font-medium transition-colors hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-60">Continue with Google</button>}
                {providers.github && <button type="button" onClick={() => void signInWithProvider('github')} disabled={busy} className="min-h-11 rounded-xl border border-border bg-background px-3 text-sm font-medium transition-colors hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-60">Continue with GitHub</button>}
              </div>
            </div>
          )}

          <div className="mt-6 flex flex-col gap-3 border-t border-border pt-5 text-sm">
            {activeMode === 'login' && <Link href="/forgot-password" className="w-fit font-medium text-primary underline-offset-4 hover:underline">Forgot password?</Link>}
            {activeMode !== 'login' && activeMode !== 'register' && activeMode !== 'verify' && <Link href="/login" className="w-fit font-medium text-primary underline-offset-4 hover:underline">Back to sign in</Link>}
            {activeMode === 'verify' && <Link href={loginHrefForCallback()} className="w-fit font-medium text-primary underline-offset-4 hover:underline">I have verified my email</Link>}
            {activeMode === 'login' && <p className="text-muted-foreground">New to InstantCap? <Link href="/register" className="font-medium text-primary underline-offset-4 hover:underline">Create an account</Link></p>}
            {activeMode === 'register' && <p className="text-muted-foreground">Already registered? <Link href="/login" className="font-medium text-primary underline-offset-4 hover:underline">Sign in</Link></p>}
          </div>
        </section>
      </div>
    </main>
  );
}
