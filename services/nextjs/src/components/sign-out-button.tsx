'use client';

import { LoaderCircle, LogOut } from 'lucide-react';
import { useState } from 'react';
import { notify } from '@/components/notification-island';

export function SignOutButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function signOut() {
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/auth/sign-out', {
        method: 'POST',
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      if (response.ok || response.status === 401) {
        window.location.assign('/login');
        return;
      }
      const message = 'We could not end this session. Try again.';
      setError(message);
      notify({ tone: 'error', title: 'Sign out failed', message, durationMs: 8000 });
    } catch {
      const message = 'We could not end this session. Check your connection and try again.';
      setError(message);
      notify({ tone: 'error', title: 'Sign out failed', message, durationMs: 8000 });
    } finally {
      setBusy(false);
    }
  }

  return <span className="inline-flex flex-col items-end gap-1">
    <button type="button" onClick={() => void signOut()} disabled={busy} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-border bg-background px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-60">
      {busy ? <LoaderCircle aria-hidden="true" size={15} className="animate-spin" /> : <LogOut aria-hidden="true" size={15} />}
      <span className="hidden sm:inline">Sign out</span>
    </button>
    {error && <span role="alert" className="max-w-48 text-right text-xs text-destructive">{error}</span>}
  </span>;
}
