'use client';

import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { AlertCircle, ArrowLeft, Coins, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { SignOutButton } from '@/components/sign-out-button';
import { notify } from '@/components/notification-island';

const walletSchema = z.object({
  balance: z.number().int(),
  reserved: z.number().int(),
  available: z.number().int(),
  legacy: z.boolean(),
}).passthrough();

const transactionSchema = z.object({
  id: z.string(),
  type: z.string(),
  amount: z.number().int(),
  reservedDelta: z.number().int(),
  balanceAfter: z.number().int(),
  reservedAfter: z.number().int(),
  status: z.string(),
  projectId: z.string().nullable().optional(),
  jobId: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
  createdAt: z.string(),
}).passthrough();

const transactionPageSchema = z.object({ items: z.array(transactionSchema), nextCursor: z.string().nullable() }).passthrough();
type Wallet = z.infer<typeof walletSchema>;
type Transaction = z.infer<typeof transactionSchema>;
type TransactionPage = z.infer<typeof transactionPageSchema>;

class WalletError extends Error {
  constructor(message: string) { super(message); this.name = 'WalletError'; }
}

async function fetchEnvelope<T>(path: string, schema: z.ZodType<T>, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, { credentials: 'include', headers: { Accept: 'application/json' }, signal });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const nested = typeof payload === 'object' && payload !== null && 'error' in payload ? (payload as { error?: { message?: unknown } }).error : undefined;
    throw new WalletError(typeof nested?.message === 'string' ? nested.message : `The request failed (${response.status}).`);
  }
  const data = typeof payload === 'object' && payload !== null && 'data' in payload ? payload.data : undefined;
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new WalletError('The server response did not match the credit API contract.');
  return parsed.data;
}

export function CreditWallet() {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 20_000, retry: 1 } } }));
  return <QueryClientProvider client={client}><CreditWalletContent /></QueryClientProvider>;
}

function CreditWalletContent() {
  const [cursor, setCursor] = useState<string | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const params = new URLSearchParams({ limit: '25' });
  if (cursor) params.set('cursor', cursor);
  const wallet = useQuery({ queryKey: ['credit-wallet'], queryFn: ({ signal }) => fetchEnvelope('/api/v1/credits/wallet', walletSchema, signal) });
  const page = useQuery({ queryKey: ['credit-transactions', cursor], queryFn: ({ signal }) => fetchEnvelope(`/api/v1/credits/transactions?${params.toString()}`, transactionPageSchema, signal) });

  useEffect(() => {
    if (!page.data) return;
    setTransactions((current) => {
      if (!cursor) return page.data.items;
      const existing = new Set(current.map((item) => item.id));
      return [...current, ...page.data.items.filter((item) => !existing.has(item.id))];
    });
  }, [page.data, cursor]);

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-card/85 backdrop-blur-xl"><div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-5 sm:px-8">
        <Link href="/app" className="font-semibold tracking-tight focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">instantcap</Link>
        <nav aria-label="Workspace" className="flex items-center gap-2 sm:gap-3"><Link href="/app/projects" className="rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">Projects</Link><Link href="/app/credits" aria-current="page" className="rounded-lg px-3 py-2 text-sm font-medium text-foreground hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">Credits</Link><SignOutButton /></nav>
      </div></header>
      <div className="mx-auto max-w-5xl px-5 pb-16 pt-10 sm:px-8 sm:pt-14">
        <Link href="/app" className="mb-5 inline-flex min-h-10 items-center gap-2 rounded-lg px-2 text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"><ArrowLeft aria-hidden="true" size={15} />Workspace</Link>
        <div>
          <p className="mb-2 text-sm font-medium text-primary">Account</p>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Credit wallet</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">Balances and ledger entries are read directly from your account.</p>
        </div>

        <section aria-labelledby="wallet-heading" className="mt-8 rounded-2xl border border-border bg-card/85 p-5 shadow-sm backdrop-blur-xl sm:p-7">
          <div className="flex items-center gap-3"><span className="grid h-10 w-10 place-items-center rounded-xl bg-primary/10 text-primary"><Coins aria-hidden="true" size={19} /></span><h2 id="wallet-heading" className="text-base font-semibold">Available balance</h2></div>
          {wallet.isPending ? <div role="status" aria-label="Loading wallet" className="mt-5 h-10 animate-pulse rounded-lg bg-muted" /> : wallet.isError ? <ErrorNotice message={wallet.error.message} onRetry={() => void wallet.refetch()} /> : (
            <div className="mt-5 grid gap-5 sm:grid-cols-3">
              <Balance label="Available" value={wallet.data.available} />
              <Balance label="Settled" value={wallet.data.balance} />
              <Balance label="Reserved" value={wallet.data.reserved} />
            </div>
          )}
          {wallet.data?.legacy && <p role="status" className="mt-5 rounded-xl border border-amber-600/25 bg-amber-500/5 p-4 text-sm leading-6 text-muted-foreground">This balance comes from legacy credit data. Wallet mutations are blocked until it is reconciled.</p>}
        </section>

        <section aria-labelledby="transactions-heading" className="mt-7 rounded-2xl border border-border bg-card/85 px-5 shadow-sm backdrop-blur-xl sm:px-7">
          <div className="border-b border-border py-5"><h2 id="transactions-heading" className="text-lg font-semibold tracking-tight">Credit transactions</h2><p className="mt-1 text-sm text-muted-foreground">Recent ledger entries for this account.</p></div>
          {page.isPending && transactions.length === 0 ? <div role="status" aria-label="Loading transactions" className="space-y-3 py-6">{[0, 1, 2].map((item) => <div key={item} className="h-16 animate-pulse rounded-xl bg-muted" />)}</div> : page.isError && transactions.length === 0 ? <ErrorNotice message={page.error.message} onRetry={() => void page.refetch()} /> : transactions.length === 0 ? (
            <div className="py-12 text-center"><h3 className="text-sm font-semibold">No credit transactions</h3><p className="mt-1 text-sm text-muted-foreground">Entries will appear here when your wallet changes.</p></div>
          ) : (
            <>
              <ul className="divide-y divide-border">{transactions.map((transaction) => <TransactionRow key={transaction.id} transaction={transaction} />)}</ul>
              {page.isError && <ErrorNotice message={page.error.message} onRetry={() => void page.refetch()} />}
              {page.data?.nextCursor && <div className="flex justify-center border-t border-border py-5"><button type="button" disabled={page.isFetching} onClick={() => setCursor(page.data?.nextCursor ?? null)} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-border bg-background px-4 text-sm font-medium hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-60"><RefreshCw aria-hidden="true" size={15} className={page.isFetching ? 'animate-spin' : ''} />{page.isFetching ? 'Loading transactions' : 'Load more transactions'}</button></div>}
            </>
          )}
        </section>
        <p className="mt-5 rounded-xl border border-border bg-muted/30 p-4 text-sm leading-6 text-muted-foreground">Package configuration is admin-only. The user API has no package listing, checkout, or payment creation endpoint, so purchases are unavailable here.</p>
      </div>
    </main>
  );
}

function Balance({ label, value }: { label: string; value: number }) {
  return <div><p className="text-sm text-muted-foreground">{label}</p><p className="mt-1 text-3xl font-semibold tabular-nums">{value.toLocaleString()}</p></div>;
}

function TransactionRow({ transaction }: { transaction: Transaction }) {
  const date = new Date(transaction.createdAt);
  const amount = transaction.amount !== 0
    ? `${transaction.amount > 0 ? '+' : ''}${transaction.amount.toLocaleString()}`
    : `${transaction.reservedDelta > 0 ? '+' : ''}${transaction.reservedDelta.toLocaleString()} reserved`;
  return <li className="flex flex-wrap items-center gap-x-4 gap-y-1 py-4">
    <div className="min-w-0 flex-1"><p className="text-sm font-semibold">{transaction.type.replace(/_/g, ' ').toLowerCase()}</p><p className="mt-1 text-sm text-muted-foreground">{transaction.reason || transaction.status.toLowerCase()}{!Number.isNaN(date.getTime()) ? ` · ${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)}` : ''}</p></div>
    <span className="text-sm font-semibold tabular-nums">{amount}</span>
  </li>;
}

function ErrorNotice({ message, onRetry }: { message: string; onRetry: () => void }) {
  useEffect(() => {
    notify({ tone: 'error', title: 'Credit data could not be loaded', message, durationMs: 8000 });
  }, [message]);
  return <div role="alert" className="my-4 rounded-xl border border-destructive/25 bg-destructive/5 p-4 text-sm"><p className="flex items-start gap-2 text-destructive"><AlertCircle aria-hidden="true" size={16} className="mt-0.5 shrink-0" />{message}</p><button type="button" onClick={onRetry} className="mt-3 inline-flex min-h-9 items-center gap-2 rounded-lg px-2 font-medium text-primary hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"><RefreshCw aria-hidden="true" size={14} />Try again</button></div>;
}
