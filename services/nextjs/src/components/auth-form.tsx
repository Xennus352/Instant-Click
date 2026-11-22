'use client';

import Link from 'next/link';
import { FormEvent, useState } from 'react';

type AuthMode = 'signin' | 'signup';

function errorMessage(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null || !('error' in payload)) return null;
  const error = (payload as { error?: unknown }).error;
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') return error.message;
  if ('message' in payload && typeof payload.message === 'string') return payload.message;
  return null;
}

export function AuthForm({ mode, verificationRequired = false }: { mode: AuthMode; verificationRequired?: boolean }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState(verificationRequired ? 'Verify your email before using your account. You can request a new link below.' : '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const isSignUp = mode === 'signup';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch(`/api/auth/${isSignUp ? 'sign-up' : 'sign-in'}/email`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          ...(isSignUp ? { name: name.trim() } : {}),
          email: email.trim().toLowerCase(),
          password,
          callbackURL: `${window.location.origin}/`,
        }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(errorMessage(payload) ?? 'The account request could not be completed.');
      if (isSignUp) {
        setPassword('');
        setMessage('Check your email for a verification link before signing in.');
      } else {
        window.location.assign('/');
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The account request could not be completed.');
    } finally {
      setBusy(false);
    }
  }

  async function resendVerification() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch('/api/auth/send-verification-email', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ email: email.trim().toLowerCase(), callbackURL: `${window.location.origin}/` }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(errorMessage(payload) ?? 'The verification email could not be sent.');
      setMessage('If the account needs verification, a new link has been sent.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The verification email could not be sent.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-lg items-center px-5 py-12">
      <section className="w-full rounded-3xl border border-slate-200 bg-white p-7 shadow-xl shadow-slate-900/5 sm:p-10">
        <Link href="/" className="text-sm font-semibold tracking-wide text-teal-700">InstantCap</Link>
        <h1 className="mt-7 text-3xl font-semibold tracking-tight text-slate-950">
          {isSignUp ? 'Create your account' : 'Sign in to InstantCap'}
        </h1>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          {isSignUp ? 'Create an account to start a movie recap.' : 'Sign in to access your projects and account.'}
        </p>

        <form className="mt-8 space-y-5" onSubmit={submit}>
          {isSignUp && (
            <label className="block text-sm font-medium text-slate-700">
              Display name
              <input autoComplete="name" required maxLength={100} value={name} onChange={(event) => setName(event.target.value)} className="mt-2 h-12 w-full rounded-xl border border-slate-300 px-4 outline-none focus:border-teal-600 focus:ring-4 focus:ring-teal-600/10" />
            </label>
          )}
          <label className="block text-sm font-medium text-slate-700">
            Email
            <input type="email" autoComplete="email" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} className="mt-2 h-12 w-full rounded-xl border border-slate-300 px-4 outline-none focus:border-teal-600 focus:ring-4 focus:ring-teal-600/10" />
          </label>
          <label className="block text-sm font-medium text-slate-700">
            Password
            <input type="password" autoComplete={isSignUp ? 'new-password' : 'current-password'} required minLength={isSignUp ? 12 : 1} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} className="mt-2 h-12 w-full rounded-xl border border-slate-300 px-4 outline-none focus:border-teal-600 focus:ring-4 focus:ring-teal-600/10" />
            {isSignUp && <span className="mt-1 block text-xs font-normal text-slate-500">Use at least 12 characters.</span>}
          </label>
          {error && <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-800">{error}</p>}
          {message && <p role="status" aria-live="polite" className="rounded-xl bg-teal-50 px-4 py-3 text-sm text-teal-900">{message}</p>}
          <button disabled={busy} className="h-12 w-full rounded-xl bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-wait disabled:opacity-60">
            {busy ? 'Please wait…' : isSignUp ? 'Create account' : 'Sign in'}
          </button>
        </form>

        {!isSignUp && (
          <button type="button" disabled={busy} onClick={resendVerification} className="mt-4 w-full text-sm font-medium text-teal-700 underline-offset-4 hover:underline disabled:opacity-60">
            Resend verification email
          </button>
        )}
        <p className="mt-6 text-center text-sm text-slate-600">
          {isSignUp ? 'Already have an account? ' : 'New to InstantCap? '}
          <Link href={isSignUp ? '/login' : '/signup'} className="font-semibold text-teal-700 hover:underline">
            {isSignUp ? 'Sign in' : 'Create an account'}
          </Link>
        </p>
      </section>
    </main>
  );
}
