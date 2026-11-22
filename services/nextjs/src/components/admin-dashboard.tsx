'use client';

import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, AlertCircle, ArrowLeft, ChevronLeft, ChevronRight, CircleDollarSign, ClipboardList, Coins, CreditCard, LoaderCircle, Package, RefreshCw, Search, ShieldCheck, Tag, Users, X } from 'lucide-react';
import Link from 'next/link';
import { FormEvent, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { AdminCreditConsole } from '@/components/admin-credit-console';
import { notify } from '@/components/notification-island';
import { SignOutButton } from '@/components/sign-out-button';

const roleSchema = z.enum(['USER', 'ADMIN', 'SUPER_ADMIN', 'SUPPORT', 'FINANCE']);
const accountStatusSchema = z.enum(['ACTIVE', 'SUSPENDED', 'BANNED']).nullable();
const userSchema = z.object({
  id: z.string(), email: z.string(), emailVerified: z.boolean(), name: z.string(), role: roleSchema,
  accountStatus: accountStatusSchema, createdAt: z.string(), updatedAt: z.string(),
}).passthrough();
const overviewSchema = z.object({
  users: z.number().int(), projects: z.number().int(), assets: z.number().int(), jobs: z.number().int(),
  failedJobs: z.number().int(), paidOrders: z.number().int(), openPayments: z.number().int(), auditEvents: z.number().int(), asOf: z.string(),
});
const usersPageSchema = z.object({ users: z.array(userSchema), page: z.number().int(), limit: z.number().int(), total: z.number().int() });
const jobStatusSchema = z.enum(['WAITING', 'ACTIVE', 'COMPLETED', 'FAILED', 'DELAYED', 'PAUSED']);
const jobSchema = z.object({
  id: z.string(), projectId: z.string().nullable(), queueName: z.string(), name: z.string(), stage: z.string().nullable(),
  status: jobStatusSchema, progress: z.number().int(), attemptsMade: z.number().int(), timestamp: z.string(),
  processedOn: z.string().nullable(), finishedOn: z.string().nullable(), runId: z.string().nullable(), updatedAt: z.string(),
}).passthrough();
const jobsSchema = z.object({ jobs: z.array(jobSchema), total: z.number().int(), limit: z.number().int() });
const auditSchema = z.object({
  id: z.string(), actorId: z.string(), actorRole: z.string(), action: z.string(), targetType: z.string(), targetId: z.string().nullable(),
  reason: z.string(), requestId: z.string(), before: z.unknown().nullable(), after: z.unknown().nullable(), createdAt: z.string(),
}).passthrough();
const auditPageSchema = z.object({ entries: z.array(auditSchema), total: z.number().int(), limit: z.number().int() });
const creditPackageSchema = z.object({
  id: z.string(), key: z.string(), name: z.string(), credits: z.number().int(), bonusCredits: z.number().int(),
  amountMinor: z.string(), currency: z.string(), enabled: z.boolean(), displayOrder: z.number().int(), createdAt: z.string(), updatedAt: z.string(),
}).passthrough();
const creditPackagesSchema = z.array(creditPackageSchema);
const creditPackageInputSchema = z.object({
  key: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{1,63}$/), name: z.string().trim().min(2).max(100),
  credits: z.number().int().min(1).max(100_000_000), bonusCredits: z.number().int().min(0).max(100_000_000),
  amountMinor: z.string().regex(/^[1-9]\d{0,8}$/, 'Enter a whole MMK amount from 500 to 999,999,999; decimals are not accepted.')
    .refine((amount) => Number(amount) >= 500, 'The package API requires a minimum price of 500 MMK.'),
  currency: z.literal('MMK'), enabled: z.boolean(),
  displayOrder: z.number().int().min(0).max(100_000), reason: z.string().trim().min(8).max(500),
}).strict();
const paymentStatusSchema = z.enum(['CREATED', 'PENDING', 'PAID', 'FAILED', 'CANCELLED', 'PARTIALLY_REFUNDED', 'REFUNDED']);
const paymentSchema = z.object({
  id: z.string(), userId: z.string(), packageId: z.string().nullable(), provider: z.string(), status: paymentStatusSchema,
  amountMinor: z.string(), currency: z.string(), credits: z.number().int(), bonusCredits: z.number().int(), refundedMinor: z.string(),
  paidAt: z.string().nullable(), createdAt: z.string(), updatedAt: z.string(),
}).passthrough();
const paymentsPageSchema = z.object({ orders: z.array(paymentSchema), total: z.number().int(), limit: z.number().int() });
const promoCampaignSchema = z.object({
  id: z.string(), key: z.string(), enabled: z.boolean(), freeRecapCount: z.number().int(), startsAt: z.string().nullable(), endsAt: z.string().nullable(),
  createdAt: z.string(), updatedAt: z.string(),
}).passthrough();
const promoCampaignsSchema = z.array(promoCampaignSchema);
const promoCampaignInputSchema = z.object({
  key: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{1,63}$/), enabled: z.boolean(), freeRecapCount: z.number().int().min(0).max(20),
  startsAt: z.string().datetime().optional(), endsAt: z.string().datetime().optional(), reason: z.string().trim().min(8).max(500),
}).strict().refine((value) => !value.startsAt || !value.endsAt || new Date(value.endsAt) > new Date(value.startsAt), { path: ['endsAt'], message: 'End time must follow start time.' });
const userUpdateInputSchema = z.object({
  accountStatus: z.enum(['ACTIVE', 'SUSPENDED', 'BANNED']).optional(),
  role: roleSchema.optional(),
  reason: z.string().trim().min(8).max(500),
}).strict().refine((input) => input.accountStatus !== undefined || input.role !== undefined, 'Select an account status or role change.');

type Role = z.infer<typeof roleSchema>;
type User = z.infer<typeof userSchema>;
type UserUpdateInput = z.infer<typeof userUpdateInputSchema>;
type Panel = 'overview' | 'users' | 'jobs' | 'audit' | 'credits' | 'packages' | 'payments' | 'promotions';

class AdminApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'AdminApiError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function apiErrorMessage(payload: unknown, status: number): string {
  if (isRecord(payload)) {
    const error = isRecord(payload.error) ? payload.error : payload;
    if (typeof error.message === 'string') return error.message;
  }
  return `The admin request failed (${status}).`;
}

async function readAdminData<T>(url: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' }, signal });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new AdminApiError(apiErrorMessage(payload, response.status), response.status);
  const data = isRecord(payload) ? payload.data : undefined;
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new AdminApiError('The admin API returned data in an unexpected format.');
  return parsed.data;
}

async function sendUserUpdate(userId: string, input: UserUpdateInput): Promise<User> {
  const response = await fetch(`/api/v1/admin/users/${encodeURIComponent(userId)}`, {
    method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(input),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new AdminApiError(apiErrorMessage(payload, response.status), response.status);
  const parsed = userSchema.safeParse(isRecord(payload) ? payload.data : undefined);
  if (!parsed.success) throw new AdminApiError('The user update response did not match the documented shape.');
  return parsed.data;
}

function QueryBoundary({ children }: { children: React.ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 15_000, retry: 1 } } }));
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

export function AdminDashboard({ actorRole, actorUserId }: { actorRole: Role; actorUserId: string }) {
  return <QueryBoundary><AdminDashboardContent actorRole={actorRole} actorUserId={actorUserId} /></QueryBoundary>;
}

function AdminDashboardContent({ actorRole, actorUserId }: { actorRole: Role; actorUserId: string }) {
  const [panel, setPanel] = useState<Panel>(actorRole === 'FINANCE' ? 'packages' : 'overview');
  const basePanels: Array<{ id: Panel; label: string; icon: typeof Activity }> = [
    { id: 'overview', label: 'Overview', icon: Activity }, { id: 'users', label: 'Users', icon: Users },
    { id: 'jobs', label: 'Jobs', icon: LoaderCircle }, { id: 'audit', label: 'Audit log', icon: ClipboardList },
    { id: 'credits', label: 'Credit ledger', icon: Coins }, { id: 'packages', label: 'Credit packages', icon: Package },
    { id: 'payments', label: 'Payments', icon: CreditCard }, { id: 'promotions', label: 'Promotions', icon: Tag },
  ];
  const panels = actorRole === 'FINANCE' ? basePanels.filter(({ id }) => id === 'packages' || id === 'payments') : basePanels;

  return <main className="min-h-screen bg-background text-foreground">
    <header className="border-b border-border bg-card/85 backdrop-blur-xl">
      <div className="mx-auto flex min-h-16 max-w-7xl items-center justify-between gap-4 px-5 sm:px-8">
        <Link href="/portal" className="inline-flex items-center gap-3 font-semibold tracking-tight focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-primary text-primary-foreground"><ShieldCheck aria-hidden="true" size={18} /></span>InstantCap admin
        </Link>
        <div className="flex items-center gap-2"><Link href="/app" className="inline-flex min-h-10 items-center gap-2 rounded-lg px-3 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"><ArrowLeft aria-hidden="true" size={15} />Workspace</Link><SignOutButton /></div>
      </div>
    </header>
    <div className="mx-auto max-w-7xl px-5 pb-16 pt-9 sm:px-8 sm:pt-12">
      <div className="mb-7 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div><p className="text-sm font-medium text-primary">Operations</p><h1 className="mt-1 text-3xl font-semibold tracking-tight sm:text-4xl">Admin dashboard</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">Read persisted account, job, payment, and audit data. Controls run only against documented admin APIs.</p></div>
        <p className="text-xs text-muted-foreground">Signed in as <span className="font-semibold text-foreground">{actorRole.replace('_', ' ')}</span></p>
      </div>

      <nav aria-label="Admin sections" className="mb-7 overflow-x-auto border-b border-border">
        <div className="flex min-w-max gap-1" role="tablist" aria-label="Admin dashboard sections">
          {panels.map(({ id, label, icon: Icon }) => <button key={id} type="button" role="tab" id={`admin-tab-${id}`} aria-controls={`admin-panel-${id}`} aria-selected={panel === id} tabIndex={panel === id ? 0 : -1} onClick={() => setPanel(id)} onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();
            const current = panels.findIndex((item) => item.id === panel);
            const next = (current + (event.key === 'ArrowRight' ? 1 : panels.length - 1)) % panels.length;
            setPanel(panels[next].id);
            document.getElementById(`admin-tab-${panels[next].id}`)?.focus();
          }} className={`inline-flex min-h-11 items-center gap-2 border-b-2 px-3 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring ${panel === id ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}><Icon aria-hidden="true" size={15} />{label}</button>)}
        </div>
      </nav>

      <section role="tabpanel" id={`admin-panel-${panel}`} aria-labelledby={`admin-tab-${panel}`} tabIndex={0} className="min-h-[360px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">
        {panel === 'overview' && <AdminOverview />}
        {panel === 'users' && <UserManagement actorRole={actorRole} actorUserId={actorUserId} />}
        {panel === 'jobs' && <JobMonitor />}
        {panel === 'audit' && <AuditLog />}
        {panel === 'credits' && <AdminCreditConsole />}
        {panel === 'packages' && <CreditPackages />}
        {panel === 'payments' && <Payments />}
        {panel === 'promotions' && <PromoCampaigns />}
      </section>

      <section aria-labelledby="admin-api-limits" className="mt-9 rounded-2xl border border-border bg-muted/25 p-5 sm:p-6">
        <h2 id="admin-api-limits" className="text-base font-semibold">Controls not available through the current API</h2>
        <p className="mt-2 max-w-5xl text-sm leading-6 text-muted-foreground">Project-level management, payment settlement/provider-refund actions, model configuration, worker controls, detailed usage analytics, persisted notification feeds/preferences, and system settings have no matching admin operations here. Payment records are read-only; separate credit-ledger adjustments/refunds, package settings, and promo campaign settings are backed by audited APIs. No demo figures or placeholder controls are shown.</p>
      </section>
    </div>
  </main>;
}

function AdminOverview() {
  const query = useQuery({ queryKey: ['admin-overview'], queryFn: ({ signal }) => readAdminData('/api/v1/admin/overview', overviewSchema, signal) });
  useQueryNotice(query.error, 'Admin overview could not be loaded');
  if (query.isPending) return <LoadingPanel label="Loading admin overview" />;
  if (query.isError) return <LoadError message={query.error.message} onRetry={() => void query.refetch()} />;
  const data = query.data;
  const metrics = [
    ['Users', data.users, Users], ['Projects', data.projects, ClipboardList], ['Assets', data.assets, ClipboardList],
    ['Persisted jobs', data.jobs, LoaderCircle], ['Failed jobs', data.failedJobs, AlertCircle], ['Paid orders', data.paidOrders, CircleDollarSign],
    ['Open payment orders', data.openPayments, CircleDollarSign], ['Audit events', data.auditEvents, ShieldCheck],
  ] as const;
  return <div>
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3"><div><h2 className="text-xl font-semibold tracking-tight">Service overview</h2><p className="mt-1 text-sm text-muted-foreground">Counts from persisted database records; no estimates.</p></div><div className="text-xs text-muted-foreground">As of {formatDate(data.asOf)}</div></div>
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{metrics.map(([label, value, Icon]) => <article key={label} className="rounded-2xl border border-border bg-card/80 p-4 shadow-sm sm:p-5"><div className="flex items-center justify-between gap-3"><h3 className="text-sm font-medium text-muted-foreground">{label}</h3><span className="grid h-9 w-9 place-items-center rounded-xl bg-primary/10 text-primary"><Icon aria-hidden="true" size={17} /></span></div><p className="mt-5 text-3xl font-semibold tracking-tight tabular-nums">{value.toLocaleString()}</p></article>)}</div>
    <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-muted/20 p-4"><p className="text-sm text-muted-foreground">These are totals only. Payment rows, usage breakdowns, and worker health are not returned by the overview endpoint.</p><button type="button" onClick={() => void query.refetch()} disabled={query.isFetching} className="inline-flex min-h-9 items-center gap-2 rounded-lg px-3 text-sm font-medium text-primary hover:bg-primary/5 disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"><RefreshCw aria-hidden="true" size={14} className={query.isFetching ? 'animate-spin' : ''} />Refresh</button></div>
  </div>;
}

function UserManagement({ actorRole, actorUserId }: { actorRole: Role; actorUserId: string }) {
  const [term, setTerm] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<User | null>(null);
  const queryClient = useQueryClient();
  const params = new URLSearchParams({ limit: '25', page: String(page) });
  if (search) params.set('q', search);
  const query = useQuery({ queryKey: ['admin-users', page, search], queryFn: ({ signal }) => readAdminData(`/api/v1/admin/users?${params.toString()}`, usersPageSchema, signal) });
  useQueryNotice(query.error, 'User directory could not be loaded');
  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPage(1);
    setSearch(term.trim().slice(0, 120));
  }
  const totalPages = query.data ? Math.max(1, Math.ceil(query.data.total / query.data.limit)) : 1;

  return <div>
    <div className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between"><div><h2 className="text-xl font-semibold tracking-tight">User management</h2><p className="mt-1 text-sm text-muted-foreground">Search persisted accounts, update status, and (as super admin) change roles.</p></div><form onSubmit={submitSearch} className="flex w-full gap-2 sm:max-w-md"><label className="sr-only" htmlFor="admin-user-search">Search users by name or email</label><div className="relative min-w-0 flex-1"><Search aria-hidden="true" size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" /><input id="admin-user-search" value={term} onChange={(event) => setTerm(event.target.value)} maxLength={120} placeholder="Name or email" className={inputClass + ' pl-9'} /></div><button type="submit" className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-primary px-3.5 text-sm font-semibold text-primary-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"><Search aria-hidden="true" size={15} /><span className="hidden sm:inline">Search</span></button></form></div>
    {query.isPending ? <LoadingPanel label="Loading users" /> : query.isError ? <LoadError message={query.error.message} onRetry={() => void query.refetch()} /> : query.data.users.length === 0 ? <EmptyPanel title="No matching users" detail={search ? 'Try a different name or email search.' : 'No account records were returned.'} /> : <>
      <div className="overflow-x-auto rounded-2xl border border-border bg-card/80 shadow-sm"><table className="w-full min-w-[800px] border-collapse text-left text-sm"><thead className="bg-muted/40 text-xs text-muted-foreground"><tr><th className="px-4 py-3 font-medium">Account</th><th className="px-4 py-3 font-medium">Verification</th><th className="px-4 py-3 font-medium">Role</th><th className="px-4 py-3 font-medium">Status</th><th className="px-4 py-3 font-medium">Created</th><th className="px-4 py-3 text-right font-medium">Action</th></tr></thead><tbody className="divide-y divide-border">{query.data.users.map((user) => <tr key={user.id} className="align-top"><td className="px-4 py-3"><p className="font-medium">{user.name}</p><p className="mt-1 text-xs text-muted-foreground">{user.email}</p><code className="mt-1 block text-[10px] text-muted-foreground">{user.id}</code></td><td className="px-4 py-3 text-xs">{user.emailVerified ? 'Verified' : 'Unverified'}</td><td className="px-4 py-3 text-xs font-medium">{user.role.replace('_', ' ')}</td><td className="px-4 py-3 text-xs">{user.accountStatus ?? 'Unspecified'}</td><td className="px-4 py-3 text-xs text-muted-foreground">{formatDate(user.createdAt)}</td><td className="px-4 py-3 text-right">{user.id === actorUserId ? <span className="text-xs text-muted-foreground">Your account</span> : <button type="button" onClick={() => setEditing(user)} className="min-h-9 rounded-lg border border-border px-3 text-xs font-semibold hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">Manage</button>}</td></tr>)}</tbody></table></div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-muted-foreground">{query.data.total.toLocaleString()} accounts · page {query.data.page} of {totalPages}</p><div className="flex gap-2"><button type="button" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={page <= 1 || query.isFetching} className={pagerButton}><ChevronLeft aria-hidden="true" size={15} />Previous</button><button type="button" onClick={() => setPage((value) => Math.min(totalPages, value + 1))} disabled={page >= totalPages || query.isFetching} className={pagerButton}>Next<ChevronRight aria-hidden="true" size={15} /></button></div></div>
    </>}
    {editing && <UserAccountEditor key={editing.id} user={editing} actorRole={actorRole} actorUserId={actorUserId} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await Promise.all([queryClient.invalidateQueries({ queryKey: ['admin-users'] }), queryClient.invalidateQueries({ queryKey: ['admin-overview'] }), queryClient.invalidateQueries({ queryKey: ['admin-audit'] })]); }} />}
  </div>;
}

function UserAccountEditor({ user, actorRole, actorUserId, onClose, onSaved }: { user: User; actorRole: Role; actorUserId: string; onClose: () => void; onSaved: () => Promise<void> }) {
  const dialogRef = useRef<HTMLElement>(null);
  const [status, setStatus] = useState(user.accountStatus ?? '');
  const [role, setRole] = useState<Role>(user.role);
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState<UserUpdateInput | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const mayChangeRole = actorRole === 'SUPER_ADMIN';
  const roleChanged = mayChangeRole && role !== user.role;
  const statusChanged = status !== (user.accountStatus ?? '');

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.querySelector<HTMLElement>('select, input, textarea, button:not([disabled])')?.focus();
    return () => previousFocus?.focus();
  }, []);

  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    const input = userUpdateInputSchema.safeParse({ ...(statusChanged ? { accountStatus: status } : {}), ...(roleChanged ? { role } : {}), reason });
    if (!input.success) {
      const message = input.error.issues[0]?.message ?? 'Check the account changes and try again.';
      setError(message);
      notify({ tone: 'error', title: 'Account update needs attention', message, durationMs: 8000 });
      return;
    }
    setPending(input.data);
  }

  async function apply() {
    if (!pending) return;
    setBusy(true);
    setError('');
    try {
      const updated = await sendUserUpdate(user.id, pending);
      notify({ tone: 'success', title: 'Account updated', message: `${updated.email} · ${updated.role.replace('_', ' ')} · ${updated.accountStatus ?? 'unspecified'}` });
      await onSaved();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'The account update could not be completed.';
      setError(message);
      notify({ tone: 'error', title: 'Account update failed', message, durationMs: 8000 });
      setPending(null);
    } finally {
      setBusy(false);
    }
  }

  return <div className="fixed inset-0 z-[90] flex items-end justify-center bg-black/35 p-0 backdrop-blur-sm sm:items-center sm:p-5" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="user-editor-title" onKeyDown={(event) => {
      if (event.key === 'Escape' && !busy) { onClose(); return; }
      if (event.key !== 'Tab') return;
      const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'));
      if (items.length === 0) { event.preventDefault(); return; }
      const first = items[0]; const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }} className="max-h-[92svh] w-full max-w-xl overflow-y-auto rounded-t-2xl border border-border bg-card p-5 shadow-2xl sm:rounded-2xl sm:p-7">
      <div className="flex items-start justify-between gap-3"><div><p className="text-xs font-medium uppercase tracking-wide text-primary">User account</p><h3 id="user-editor-title" className="mt-1 text-xl font-semibold">Manage account</h3><p className="mt-1 text-sm text-muted-foreground">{user.name} · {user.email}</p></div><button type="button" onClick={onClose} disabled={busy} aria-label="Close account editor" className="grid h-9 w-9 place-items-center rounded-full text-muted-foreground hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"><X aria-hidden="true" size={17} /></button></div>
      {!pending ? <form onSubmit={review} className="mt-6 space-y-4">
        <div><label htmlFor="account-status" className="block text-sm font-medium">Account status</label><select id="account-status" value={status} onChange={(event) => setStatus(event.target.value)} className={inputClass}><option value="">No change{user.accountStatus ? '' : ' (currently unspecified)'}</option><option value="ACTIVE">Active</option><option value="SUSPENDED">Suspended</option><option value="BANNED">Banned</option></select></div>
        {mayChangeRole ? <div><label htmlFor="account-role" className="block text-sm font-medium">Role <span className="text-xs text-muted-foreground">(super administrator)</span></label><select id="account-role" value={role} onChange={(event) => setRole(event.target.value as Role)} className={inputClass}>{roleSchema.options.map((item) => <option key={item} value={item}>{item.replace('_', ' ')}</option>)}</select></div> : <p className="rounded-xl border border-border bg-muted/30 p-3 text-sm text-muted-foreground">Role changes are restricted to super administrators. Current role: {user.role.replace('_', ' ')}.</p>}
        <div><label htmlFor="account-reason" className="block text-sm font-medium">Reason (required)</label><textarea id="account-reason" value={reason} onChange={(event) => setReason(event.target.value)} rows={3} maxLength={500} className={inputClass + ' h-auto py-3'} placeholder="Explain why this account change is needed." /></div>
        {error && <p role="alert" className="rounded-xl border border-destructive/25 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2"><button type="button" onClick={onClose} className="min-h-10 rounded-xl border border-border px-4 text-sm font-medium hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">Cancel</button><button type="submit" className="min-h-10 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">Review changes</button></div>
      </form> : <div className="mt-6 space-y-4"><div className="rounded-xl border border-amber-600/25 bg-amber-500/5 p-4"><h4 className="text-sm font-semibold">Confirm this audited change</h4><p className="mt-2 text-sm leading-6 text-muted-foreground">{pending.accountStatus ? `Status: ${user.accountStatus ?? 'unspecified'} → ${pending.accountStatus}. ` : ''}{pending.role ? `Role: ${user.role.replace('_', ' ')} → ${pending.role.replace('_', ' ')}. ` : ''}Reason: {pending.reason}</p><p className="mt-2 text-xs text-muted-foreground">The API writes an audit record. You cannot change your own account, and only a super administrator can change roles.</p></div>{error && <p role="alert" className="rounded-xl border border-destructive/25 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}<div className="flex flex-wrap justify-end gap-2"><button type="button" onClick={() => setPending(null)} disabled={busy} className="min-h-10 rounded-xl border border-border px-4 text-sm font-medium hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">Edit</button><button type="button" onClick={() => void apply()} disabled={busy} className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">{busy && <LoaderCircle aria-hidden="true" size={15} className="animate-spin" />}{busy ? 'Applying change' : 'Confirm account update'}</button></div></div>}
    </section>
  </div>;
}

function JobMonitor() {
  const [status, setStatus] = useState('');
  const query = useQuery({ queryKey: ['admin-jobs', status], queryFn: ({ signal }) => {
    const params = new URLSearchParams({ limit: '50' });
    if (status) params.set('status', status);
    return readAdminData(`/api/v1/admin/jobs?${params.toString()}`, jobsSchema, signal);
  } });
  useQueryNotice(query.error, 'Processing jobs could not be loaded');
  return <div>
    <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between"><div><h2 className="text-xl font-semibold tracking-tight">Processing jobs</h2><p className="mt-1 text-sm text-muted-foreground">Read-only persisted job records. The API does not expose retry or cancel controls here.</p></div><div><label htmlFor="job-status-filter" className="mb-1 block text-xs font-medium text-muted-foreground">Filter status</label><select id="job-status-filter" value={status} onChange={(event) => setStatus(event.target.value)} className={inputClass + ' mt-0 min-w-44'}><option value="">All statuses</option>{jobStatusSchema.options.map((value) => <option key={value} value={value}>{value}</option>)}</select></div></div>
    {query.isPending ? <LoadingPanel label="Loading processing jobs" /> : query.isError ? <LoadError message={query.error.message} onRetry={() => void query.refetch()} /> : query.data.jobs.length === 0 ? <EmptyPanel title="No matching jobs" detail="The API returned no persisted job records for this filter." /> : <div className="overflow-x-auto rounded-2xl border border-border bg-card/80 shadow-sm"><table className="w-full min-w-[900px] border-collapse text-left text-sm"><thead className="bg-muted/40 text-xs text-muted-foreground"><tr><th className="px-4 py-3 font-medium">Job</th><th className="px-4 py-3 font-medium">Queue / stage</th><th className="px-4 py-3 font-medium">Status</th><th className="px-4 py-3 font-medium">Progress</th><th className="px-4 py-3 font-medium">Attempts</th><th className="px-4 py-3 font-medium">Started / updated</th></tr></thead><tbody className="divide-y divide-border">{query.data.jobs.map((job) => <tr key={job.id}><td className="px-4 py-3"><p className="font-medium">{job.name}</p><code className="mt-1 block max-w-52 truncate text-[10px] text-muted-foreground">{job.id}</code>{job.projectId && <p className="mt-1 text-[10px] text-muted-foreground">Project {job.projectId}</p>}</td><td className="px-4 py-3 text-xs">{job.queueName}<p className="mt-1 text-muted-foreground">{job.stage ?? 'No stage'}</p></td><td className="px-4 py-3"><StatusBadge status={job.status} /></td><td className="px-4 py-3 tabular-nums">{Math.max(0, Math.min(100, job.progress))}%</td><td className="px-4 py-3 tabular-nums">{job.attemptsMade}</td><td className="px-4 py-3 text-xs text-muted-foreground">{formatDate(job.processedOn ?? job.timestamp)}{job.finishedOn ? <span className="mt-1 block">Finished {formatDate(job.finishedOn)}</span> : null}</td></tr>)}</tbody></table><p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">Showing {query.data.jobs.length} of {query.data.total.toLocaleString()} jobs (limit {query.data.limit}).</p></div>}
  </div>;
}

function AuditLog() {
  const [targetType, setTargetType] = useState('');
  const [action, setAction] = useState('');
  const [filters, setFilters] = useState({ targetType: '', action: '' });
  const params = new URLSearchParams({ limit: '50' });
  if (filters.targetType) params.set('targetType', filters.targetType);
  if (filters.action) params.set('action', filters.action);
  const query = useQuery({ queryKey: ['admin-audit', filters], queryFn: ({ signal }) => readAdminData(`/api/v1/admin/audit-logs?${params.toString()}`, auditPageSchema, signal) });
  useQueryNotice(query.error, 'Audit log could not be loaded');
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setFilters({ targetType: targetType.trim().slice(0, 80), action: action.trim().slice(0, 100) }); }
  return <div>
    <div className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between"><div><h2 className="text-xl font-semibold tracking-tight">Admin audit log</h2><p className="mt-1 text-sm text-muted-foreground">Persisted privileged actions with actor, reason, and before/after snapshots.</p></div><form onSubmit={submit} className="grid w-full gap-2 sm:max-w-xl sm:grid-cols-[1fr_1fr_auto]"><div><label htmlFor="audit-target-filter" className="mb-1 block text-xs font-medium text-muted-foreground">Target type</label><input id="audit-target-filter" value={targetType} onChange={(event) => setTargetType(event.target.value)} maxLength={80} placeholder="User" className={inputClass + ' mt-0'} /></div><div><label htmlFor="audit-action-filter" className="mb-1 block text-xs font-medium text-muted-foreground">Action</label><input id="audit-action-filter" value={action} onChange={(event) => setAction(event.target.value)} maxLength={100} placeholder="USER_ACCOUNT_UPDATED" className={inputClass + ' mt-0'} /></div><button type="submit" className="mt-auto inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-primary px-3.5 text-sm font-semibold text-primary-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"><Search aria-hidden="true" size={15} />Filter</button></form></div>
    {query.isPending ? <LoadingPanel label="Loading audit log" /> : query.isError ? <LoadError message={query.error.message} onRetry={() => void query.refetch()} /> : query.data.entries.length === 0 ? <EmptyPanel title="No audit entries" detail="The API returned no records for these filters." /> : <div className="space-y-3">{query.data.entries.map((entry) => <details key={entry.id} className="rounded-2xl border border-border bg-card/80 p-4 shadow-sm"><summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-3 rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"><div className="min-w-0"><p className="font-semibold">{entry.action.replaceAll('_', ' ')}</p><p className="mt-1 text-xs text-muted-foreground">{entry.targetType}{entry.targetId ? ` · ${entry.targetId}` : ''} · actor {entry.actorRole.replace('_', ' ')}</p></div><time className="text-xs text-muted-foreground">{formatDate(entry.createdAt)}</time></summary><div className="mt-4 grid gap-3 border-t border-border pt-4 md:grid-cols-2"><AuditValue label="Reason" value={entry.reason} /><AuditValue label="Actor / request" value={`${entry.actorId}\n${entry.requestId}`} /><AuditValue label="Before" value={safeJson(entry.before)} /><AuditValue label="After" value={safeJson(entry.after)} /></div></details>)}<p className="text-xs text-muted-foreground">Showing {query.data.entries.length} of {query.data.total.toLocaleString()} entries (limit {query.data.limit}).</p></div>}
  </div>;
}

type CreditPackageInput = z.infer<typeof creditPackageInputSchema>;
type PromoCampaignInput = z.infer<typeof promoCampaignInputSchema>;

function CreditPackages() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['admin-packages'], queryFn: ({ signal }) => readAdminData('/api/v1/admin/credit-packages', creditPackagesSchema, signal) });
  useQueryNotice(query.error, 'Credit packages could not be loaded');
  const [key, setKey] = useState('');
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [credits, setCredits] = useState('');
  const [bonusCredits, setBonusCredits] = useState('0');
  const [amountMinor, setAmountMinor] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [displayOrder, setDisplayOrder] = useState('0');
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState<CreditPackageInput | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function reset() {
    setKey(''); setEditingKey(null); setName(''); setCredits(''); setBonusCredits('0'); setAmountMinor(''); setEnabled(false); setDisplayOrder('0'); setReason(''); setPending(null); setError('');
  }
  function edit(item: z.infer<typeof creditPackageSchema>) {
    if (item.currency !== 'MMK') return;
    setKey(item.key); setEditingKey(item.key); setName(item.name); setCredits(String(item.credits)); setBonusCredits(String(item.bonusCredits));
    setAmountMinor(item.amountMinor); setEnabled(item.enabled); setDisplayOrder(String(item.displayOrder)); setReason(''); setPending(null); setError('');
  }
  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError('');
    const parsed = creditPackageInputSchema.safeParse({ key, name, credits: Number(credits), bonusCredits: Number(bonusCredits), amountMinor, currency: 'MMK', enabled, displayOrder: Number(displayOrder), reason });
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? 'Review the package values.';
      setError(message); notify({ tone: 'error', title: 'Package settings need attention', message, durationMs: 8000 }); return;
    }
    setPending(parsed.data);
  }
  async function apply() {
    if (!pending) return;
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/v1/admin/credit-packages', { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(pending) });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new AdminApiError(apiErrorMessage(payload, response.status), response.status);
      const item = creditPackageSchema.safeParse(isRecord(payload) ? payload.data : undefined);
      if (!item.success) throw new AdminApiError('The package update response did not match the documented shape.');
      notify({ tone: 'success', title: 'Credit package saved', message: `${item.data.name} · ${item.data.enabled ? 'enabled' : 'disabled'} · ${item.data.credits.toLocaleString()} credits` });
      reset();
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['admin-packages'] }), queryClient.invalidateQueries({ queryKey: ['admin-audit'] })]);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'The package could not be saved.';
      setError(message); setPending(null); notify({ tone: 'error', title: 'Credit package update failed', message, durationMs: 8000 });
    } finally { setBusy(false); }
  }

  return <div>
    <div className="mb-5"><h2 className="text-xl font-semibold tracking-tight">Credit packages</h2><p className="mt-1 text-sm text-muted-foreground">Create or update packages through the audited admin API. Prices are whole MMK integers from 500 to 999,999,999 and are sent unchanged as `amountMinor`; editing a package does not initiate a payment.</p></div>
    {query.isPending ? <LoadingPanel label="Loading credit packages" /> : query.isError ? <LoadError message={query.error.message} onRetry={() => void query.refetch()} /> : <>
      {query.data.length === 0 ? <EmptyPanel title="No packages configured" detail="The package API returned no records. Create a package below if one is approved for sale." /> : <div className="mb-5 overflow-x-auto rounded-2xl border border-border bg-card/80 shadow-sm"><table className="w-full min-w-[760px] border-collapse text-left text-sm"><thead className="bg-muted/40 text-xs text-muted-foreground"><tr><th className="px-4 py-3 font-medium">Package</th><th className="px-4 py-3 font-medium">Credits</th><th className="px-4 py-3 font-medium">Price</th><th className="px-4 py-3 font-medium">State</th><th className="px-4 py-3 font-medium">Order</th><th className="px-4 py-3 text-right font-medium">Edit</th></tr></thead><tbody className="divide-y divide-border">{query.data.map((item) => <tr key={item.id}><td className="px-4 py-3"><p className="font-medium">{item.name}</p><code className="text-[10px] text-muted-foreground">{item.key}</code></td><td className="px-4 py-3 tabular-nums">{item.credits.toLocaleString()} + {item.bonusCredits.toLocaleString()} bonus</td><td className="px-4 py-3 tabular-nums">{formatCurrencyAmount(item.amountMinor, item.currency)}</td><td className="px-4 py-3"><StatusBadge status={item.enabled ? 'ENABLED' : 'DISABLED'} /></td><td className="px-4 py-3 tabular-nums">{item.displayOrder}</td><td className="px-4 py-3 text-right">{item.currency === "MMK" ? <button type="button" onClick={() => edit(item)} className="min-h-9 rounded-lg border border-border px-3 text-xs font-semibold hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">Edit</button> : <span className="text-xs text-muted-foreground" title="The package API only supports MMK edits.">MMK only</span>}</td></tr>)}</tbody></table></div>}
    </>}

    {query.isSuccess && <section aria-labelledby="package-form-heading" className="rounded-2xl border border-border bg-card/80 p-5 shadow-sm sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 id="package-form-heading" className="text-base font-semibold">{key ? `Edit package: ${key}` : 'Add a package'}</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">PUT upserts by key. Disabling a package removes it from enabled package listings.</p></div><button type="button" onClick={reset} className="min-h-9 rounded-lg px-3 text-xs font-semibold text-muted-foreground hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">New package</button></div>
      {!pending ? <form onSubmit={review} className="mt-5 space-y-4">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Package key" id="package-key" hint={editingKey ? 'The API updates by key, so this value stays fixed during edits.' : 'This key identifies the package in the admin API.'}><input id="package-key" value={key} readOnly={editingKey !== null} onChange={(event) => setKey(event.target.value)} maxLength={64} placeholder="starter" className={`${inputClass} read-only:bg-muted/50`} /></Field>
          <Field label="Display name" id="package-name"><input id="package-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={100} className={inputClass} /></Field>
          <Field label="Credits" id="package-credits"><input id="package-credits" type="number" min={1} max={100000000} step={1} value={credits} onChange={(event) => setCredits(event.target.value)} className={inputClass} /></Field>
          <Field label="Bonus credits" id="package-bonus"><input id="package-bonus" type="number" min={0} max={100000000} step={1} value={bonusCredits} onChange={(event) => setBonusCredits(event.target.value)} className={inputClass} /></Field>
          <Field label="Price (MMK, whole kyat)" id="package-price" hint="Enter a whole amount from 500 to 999,999,999 MMK. The integer is sent unchanged as amountMinor."><input id="package-price" aria-describedby="package-price-hint" inputMode="numeric" maxLength={9} value={amountMinor} onChange={(event) => setAmountMinor(event.target.value)} className={inputClass} /></Field>
          <Field label="Display order" id="package-order"><input id="package-order" type="number" min={0} max={100000} step={1} value={displayOrder} onChange={(event) => setDisplayOrder(event.target.value)} className={inputClass} /></Field>
          <label className="mt-6 inline-flex min-h-11 items-center gap-2 text-sm font-medium"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} className="h-4 w-4 rounded border-input accent-primary" />Package enabled</label>
        </div>
          <Field label="Reason (required for audit)" id="package-reason"><textarea id="package-reason" value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} rows={2} className={inputClass + ' h-auto py-3'} /></Field>
        {error && <p role="alert" className="rounded-xl border border-destructive/25 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}
        <button type="submit" className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">Review package</button>
      </form> : <div className="mt-5 rounded-xl border border-amber-600/25 bg-amber-500/5 p-4"><h4 className="text-sm font-semibold">Review package change</h4><p className="mt-2 text-sm leading-6 text-muted-foreground">{pending.name} ({pending.key}) · {pending.credits.toLocaleString()} credits + {pending.bonusCredits.toLocaleString()} bonus · {formatCurrencyAmount(pending.amountMinor, pending.currency)} · {pending.enabled ? 'enabled' : 'disabled'} · order {pending.displayOrder}. Reason: {pending.reason}</p>{error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}<div className="mt-4 flex justify-end gap-2"><button type="button" onClick={() => setPending(null)} disabled={busy} className="min-h-10 rounded-xl border border-border px-4 text-sm font-medium">Edit</button><button type="button" onClick={() => void apply()} disabled={busy} className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-60">{busy && <LoaderCircle aria-hidden="true" size={15} className="animate-spin" />}{busy ? 'Saving' : 'Confirm package update'}</button></div></div>}
    </section>}
  </div>;
}

function Payments() {
  const [status, setStatus] = useState('');
  const query = useQuery({ queryKey: ['admin-payments', status], queryFn: ({ signal }) => {
    const params = new URLSearchParams({ limit: '50' }); if (status) params.set('status', status);
    return readAdminData(`/api/v1/admin/payments?${params.toString()}`, paymentsPageSchema, signal);
  } });
  useQueryNotice(query.error, 'Payment records could not be loaded');
  return <div>
    {query.isPending ? <LoadingPanel label="Loading payment orders" /> : query.isError ? <LoadError message={query.error.message} onRetry={() => void query.refetch()} /> : query.data.orders.length === 0 ? <EmptyPanel title="No payment orders" detail="The payment API returned no orders for this filter." /> : <div className="overflow-x-auto rounded-2xl border border-border bg-card/80 shadow-sm"><table className="w-full min-w-[1050px] border-collapse text-left text-sm"><thead className="bg-muted/40 text-xs text-muted-foreground"><tr><th className="px-4 py-3 font-medium">Order</th><th className="px-4 py-3 font-medium">User / package</th><th className="px-4 py-3 font-medium">Provider / status</th><th className="px-4 py-3 font-medium">Amount</th><th className="px-4 py-3 font-medium">Credits</th><th className="px-4 py-3 font-medium">Refunded</th><th className="px-4 py-3 font-medium">Created / paid</th></tr></thead><tbody className="divide-y divide-border">{query.data.orders.map((order) => <tr key={order.id}><td className="px-4 py-3"><code className="block max-w-48 truncate text-xs">{order.id}</code><p className="mt-1 text-[10px] text-muted-foreground">{order.packageId ?? 'No package ID'}</p></td><td className="px-4 py-3 text-xs"><code>{order.userId}</code></td><td className="px-4 py-3 text-xs">{order.provider}<p className="mt-1"><StatusBadge status={order.status} /></p></td><td className="px-4 py-3 tabular-nums">{formatCurrencyAmount(order.amountMinor, order.currency)}</td><td className="px-4 py-3 tabular-nums">{order.credits.toLocaleString()} + {order.bonusCredits.toLocaleString()} bonus</td><td className="px-4 py-3 tabular-nums">{formatCurrencyAmount(order.refundedMinor, order.currency)}</td><td className="px-4 py-3 text-xs text-muted-foreground">{formatDate(order.createdAt)}{order.paidAt ? <span className="mt-1 block">Paid {formatDate(order.paidAt)}</span> : null}</td></tr>)}</tbody></table><p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">Showing {query.data.orders.length} of {query.data.total.toLocaleString()} orders (limit {query.data.limit}). No payment mutations are available.</p></div>}
  </div>;
}

function PromoCampaigns() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['admin-promo-campaigns'], queryFn: ({ signal }) => readAdminData('/api/v1/admin/promo-campaigns', promoCampaignsSchema, signal) });
  useQueryNotice(query.error, 'Promotion campaigns could not be loaded');
  const [key, setKey] = useState('');
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [freeRecapCount, setFreeRecapCount] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState<PromoCampaignInput | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  function reset() { setKey(''); setEditingKey(null); setEnabled(false); setFreeRecapCount(''); setStartsAt(''); setEndsAt(''); setReason(''); setPending(null); setError(''); }
  function edit(item: z.infer<typeof promoCampaignSchema>) { setKey(item.key); setEditingKey(item.key); setEnabled(item.enabled); setFreeRecapCount(String(item.freeRecapCount)); setStartsAt(toLocalDateTime(item.startsAt)); setEndsAt(toLocalDateTime(item.endsAt)); setReason(''); setPending(null); setError(''); }
  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError('');
    const input = { key, enabled, freeRecapCount: freeRecapCount.trim() ? Number(freeRecapCount) : Number.NaN, ...(startsAt ? { startsAt: new Date(startsAt).toISOString() } : {}), ...(endsAt ? { endsAt: new Date(endsAt).toISOString() } : {}), reason };
    const parsed = promoCampaignInputSchema.safeParse(input);
    if (!parsed.success) { const message = parsed.error.issues[0]?.message ?? 'Review the promotion values.'; setError(message); notify({ tone: 'error', title: 'Promotion settings need attention', message, durationMs: 8000 }); return; }
    setPending(parsed.data);
  }
  async function apply() {
    if (!pending) return;
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/v1/admin/promo-campaigns', { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(pending) });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new AdminApiError(apiErrorMessage(payload, response.status), response.status);
      const campaign = promoCampaignSchema.safeParse(isRecord(payload) ? payload.data : undefined);
      if (!campaign.success) throw new AdminApiError('The promotion response did not match the documented shape.');
      notify({ tone: 'success', title: 'Promotion campaign saved', message: `${campaign.data.key} · ${campaign.data.enabled ? 'enabled' : 'disabled'} · ${campaign.data.freeRecapCount} free recaps` });
      reset();
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['admin-promo-campaigns'] }), queryClient.invalidateQueries({ queryKey: ['admin-audit'] })]);
    } catch (cause) { const message = cause instanceof Error ? cause.message : 'The campaign could not be saved.'; setError(message); setPending(null); notify({ tone: 'error', title: 'Promotion update failed', message, durationMs: 8000 }); }
    finally { setBusy(false); }
  }

  return <div>
    <div className="mb-5"><h2 className="text-xl font-semibold tracking-tight">Promotion campaigns</h2><p className="mt-1 text-sm text-muted-foreground">Manage supported promo campaign settings through the audited upsert API.</p></div>
    {query.isPending ? <LoadingPanel label="Loading promotion campaigns" /> : query.isError ? <LoadError message={query.error.message} onRetry={() => void query.refetch()} /> : query.data.length === 0 ? <EmptyPanel title="No campaigns configured" detail="The campaign API returned no records. Configure a campaign only when its terms have been approved." /> : <div className="mb-5 overflow-x-auto rounded-2xl border border-border bg-card/80 shadow-sm"><table className="w-full min-w-[760px] border-collapse text-left text-sm"><thead className="bg-muted/40 text-xs text-muted-foreground"><tr><th className="px-4 py-3 font-medium">Campaign</th><th className="px-4 py-3 font-medium">Free recaps</th><th className="px-4 py-3 font-medium">Window</th><th className="px-4 py-3 font-medium">State</th><th className="px-4 py-3 text-right font-medium">Edit</th></tr></thead><tbody className="divide-y divide-border">{query.data.map((item) => <tr key={item.id}><td className="px-4 py-3"><p className="font-medium">{item.key}</p><code className="text-[10px] text-muted-foreground">{item.id}</code></td><td className="px-4 py-3 tabular-nums">{item.freeRecapCount}</td><td className="px-4 py-3 text-xs text-muted-foreground">{formatDate(item.startsAt)} → {formatDate(item.endsAt)}</td><td className="px-4 py-3"><StatusBadge status={item.enabled ? 'ENABLED' : 'DISABLED'} /></td><td className="px-4 py-3 text-right"><button type="button" onClick={() => edit(item)} className="min-h-9 rounded-lg border border-border px-3 text-xs font-semibold hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">Edit</button></td></tr>)}</tbody></table></div>}
    {query.isSuccess && <section className="rounded-2xl border border-border bg-card/80 p-5 shadow-sm sm:p-6"><div className="flex items-start justify-between gap-3"><div><h3 className="text-base font-semibold">{key ? `Edit campaign: ${key}` : 'Add a campaign'}</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">PUT upserts by key and writes an audit record. The API does not expose eligibility-rule editing.</p></div><button type="button" onClick={reset} className="min-h-9 rounded-lg px-3 text-xs font-semibold text-muted-foreground hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">New campaign</button></div>
      {!pending ? <form onSubmit={review} className="mt-5 space-y-4"><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"><Field label="Campaign key" id="promo-key" hint={editingKey ? 'The API updates by key, so this value stays fixed while editing.' : 'Use a unique lowercase key for the campaign.'}><input id="promo-key" value={key} readOnly={editingKey !== null} onChange={(event) => setKey(event.target.value)} maxLength={64} placeholder="campaign-key" className={`${inputClass} read-only:bg-muted/50`} /></Field><Field label="Free recap count" id="promo-count" hint="Choose a whole number from 0 to 20; no default offer is assumed."><input id="promo-count" type="number" min={0} max={20} step={1} required value={freeRecapCount} onChange={(event) => setFreeRecapCount(event.target.value)} className={inputClass} /></Field><Field label="Starts at (optional)" id="promo-start"><input id="promo-start" type="datetime-local" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} className={inputClass} /></Field><Field label="Ends at (optional)" id="promo-end"><input id="promo-end" type="datetime-local" value={endsAt} onChange={(event) => setEndsAt(event.target.value)} className={inputClass} /></Field><label className="inline-flex min-h-11 items-center gap-2 text-sm font-medium"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} className="h-4 w-4 rounded border-input accent-primary" />Campaign enabled</label></div><Field label="Reason (required for audit)" id="promo-reason"><textarea id="promo-reason" value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} rows={2} className={inputClass + ' h-auto py-3'} /></Field>{error && <p role="alert" className="rounded-xl border border-destructive/25 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}<button type="submit" className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">Review campaign</button></form> : <div className="mt-5 rounded-xl border border-amber-600/25 bg-amber-500/5 p-4"><h4 className="text-sm font-semibold">Review campaign change</h4><p className="mt-2 text-sm leading-6 text-muted-foreground">{pending.key} · {pending.enabled ? 'enabled' : 'disabled'} · {pending.freeRecapCount} free recaps · {pending.startsAt ? formatDate(pending.startsAt) : 'no start limit'} → {pending.endsAt ? formatDate(pending.endsAt) : 'no end limit'}. Reason: {pending.reason}</p>{error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}<div className="mt-4 flex justify-end gap-2"><button type="button" onClick={() => setPending(null)} disabled={busy} className="min-h-10 rounded-xl border border-border px-4 text-sm font-medium">Edit</button><button type="button" onClick={() => void apply()} disabled={busy} className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-60">{busy && <LoaderCircle aria-hidden="true" size={15} className="animate-spin" />}{busy ? 'Saving' : 'Confirm campaign update'}</button></div></div>}</section>}
  </div>;
}

function toLocalDateTime(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function Field({ label, id, hint, children }: { label: string; id: string; hint?: string; children: React.ReactNode }) {
  return <div><label htmlFor={id} className="block text-sm font-medium">{label}</label>{children}{hint && <p id={`${id}-hint`} className="mt-1 text-xs leading-5 text-muted-foreground">{hint}</p>}</div>;
}

function useQueryNotice(error: Error | null, title: string) {
  useEffect(() => { if (error) notify({ tone: 'error', title, message: error.message, durationMs: 8000 }); }, [error, title]);
}

function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <div role="alert" className="rounded-2xl border border-destructive/25 bg-destructive/5 p-5"><p className="flex items-start gap-2 text-sm text-destructive"><AlertCircle aria-hidden="true" size={16} className="mt-0.5 shrink-0" />{message}</p><button type="button" onClick={onRetry} className="mt-3 inline-flex min-h-9 items-center gap-2 rounded-lg px-2 text-sm font-semibold text-primary hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"><RefreshCw aria-hidden="true" size={14} />Try again</button></div>;
}

function LoadingPanel({ label }: { label: string }) {
  return <div role="status" aria-label={label} className="space-y-3 rounded-2xl border border-border bg-card/70 p-5"><div className="h-5 w-40 animate-pulse rounded bg-muted" /><div className="h-20 animate-pulse rounded-xl bg-muted/70" /><span className="sr-only">{label}…</span></div>;
}

function EmptyPanel({ title, detail }: { title: string; detail: string }) {
  return <div className="rounded-2xl border border-dashed border-border bg-card/50 px-5 py-12 text-center"><p className="font-semibold">{title}</p><p className="mt-2 text-sm text-muted-foreground">{detail}</p></div>;
}

function StatusBadge({ status }: { status: string }) {
  const classes = status === 'FAILED' || status === 'BANNED' ? 'bg-destructive/10 text-destructive' : status === 'ACTIVE' || status === 'COMPLETED' || status === 'ENABLED' ? 'bg-emerald-600/10 text-emerald-800 dark:text-emerald-300' : 'bg-muted text-muted-foreground';
  return <span className={`inline-flex rounded-full px-2.5 py-1 text-[10px] font-semibold ${classes}`}>{status.replaceAll('_', ' ')}</span>;
}

function AuditValue({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0 rounded-xl bg-muted/30 p-3"><p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p><pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-5 text-foreground">{value}</pre></div>;
}

function safeJson(value: unknown): string {
  if (value === null || value === undefined) return 'No snapshot recorded';
  try { return JSON.stringify(value, null, 2); } catch { return 'Snapshot unavailable'; }
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function formatCurrencyAmount(amountMinor: string, currency: string): string {
  if (currency !== 'MMK') return `${amountMinor} ${currency} (minor units)`;
  if (!/^\d+$/.test(amountMinor)) return `${amountMinor} MMK`;
  return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(BigInt(amountMinor))} MMK`;
}

const inputClass = 'mt-1 min-h-11 w-full rounded-xl border border-input bg-background px-3.5 text-sm outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring';
const pagerButton = 'inline-flex min-h-9 items-center gap-1 rounded-lg border border-border px-3 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
