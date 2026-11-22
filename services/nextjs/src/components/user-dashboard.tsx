'use client';

import { useQuery, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AlertCircle, ArrowLeft, ArrowRight, Clapperboard, Coins, FolderOpen, Plus, RefreshCw } from 'lucide-react';
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

const projectSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
}).passthrough();

const projectPageSchema = z.object({
  items: z.array(projectSchema),
  nextCursor: z.string().nullable(),
}).passthrough();

type Wallet = z.infer<typeof walletSchema>;
type Project = z.infer<typeof projectSchema>;
type ProjectPage = z.infer<typeof projectPageSchema>;

class DashboardError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'DashboardError';
  }
}

async function fetchData<T>(url: string, schema: z.ZodType<T>, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' }, signal });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const issue = typeof payload === 'object' && payload !== null && 'error' in payload
      ? (payload as { error?: { message?: unknown } }).error?.message
      : undefined;
    throw new DashboardError(typeof issue === 'string' ? issue : `The request failed (${response.status}).`, response.status);
  }
  const data = typeof payload === 'object' && payload !== null && 'data' in payload ? payload.data : undefined;
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new DashboardError('The server response did not match the expected format.');
  return parsed.data;
}

function QueryBoundary({ children }: { children: React.ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 20_000, retry: 1 } } }));
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

export function UserDashboard() {
  return <QueryBoundary><DashboardContent /></QueryBoundary>;
}

export function ProjectLibrary() {
  return <QueryBoundary><ProjectLibraryContent /></QueryBoundary>;
}

function DashboardContent() {
  const wallet = useQuery({ queryKey: ['credit-wallet'], queryFn: ({ signal }) => fetchData('/api/v1/credits/wallet', walletSchema, signal) });
  const projects = useQuery({ queryKey: ['dashboard-projects'], queryFn: ({ signal }) => fetchData('/api/v1/projects?limit=5', projectPageSchema, signal) });

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-card/85 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-5 sm:px-8">
          <Link href="/app" className="inline-flex items-center gap-3 font-semibold tracking-tight focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-primary text-primary-foreground"><Clapperboard aria-hidden="true" size={18} /></span>
            instantcap
          </Link>
          <nav aria-label="Workspace" className="flex items-center gap-2 sm:gap-3">
            <Link href="/app/projects" className="rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">Projects</Link>
            <Link href="/app/credits" className="rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">Credits</Link>
            <Link href="/app/new" className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-primary px-3.5 text-sm font-semibold text-primary-foreground hover:-translate-y-0.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:px-4"><Plus aria-hidden="true" size={16} /><span className="hidden sm:inline">Create project</span><span className="sm:hidden">Create</span></Link>
            <SignOutButton />
          </nav>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-5 pb-16 pt-10 sm:px-8 sm:pt-14">
        <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="mb-2 text-sm font-medium text-primary">Your workspace</p>
            <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Movie projects</h1>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">Create a project and follow its server-reported processing status.</p>
          </div>
          <Link href="/app/new" className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground hover:-translate-y-0.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"><Plus aria-hidden="true" size={16} />Create a movie project</Link>
        </div>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(260px,0.7fr)]">
          <section aria-labelledby="recent-projects-heading" className="rounded-2xl border border-border bg-card/85 p-5 shadow-sm backdrop-blur-xl sm:p-7">
            <div className="mb-5 flex items-center justify-between gap-4">
              <div>
                <h2 id="recent-projects-heading" className="text-lg font-semibold tracking-tight">Recent projects</h2>
                <p className="mt-1 text-sm text-muted-foreground">The latest projects returned by your account.</p>
              </div>
              <Link href="/app/projects" className="inline-flex min-h-10 items-center gap-2 rounded-lg px-3 text-sm font-medium text-primary hover:bg-primary/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">View projects <ArrowRight aria-hidden="true" size={15} /></Link>
            </div>
            {projects.isPending ? <LoadingRows label="Loading projects" /> : projects.isError ? <LoadError message={projects.error.message} onRetry={() => void projects.refetch()} /> : projects.data.items.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border bg-background/70 px-5 py-9 text-center">
                <span className="mx-auto grid h-11 w-11 place-items-center rounded-xl bg-muted text-muted-foreground"><FolderOpen aria-hidden="true" size={19} /></span>
                <h3 className="mt-3 text-sm font-semibold">No movie projects yet</h3>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">Create a project to see its upload and processing status here.</p>
                <Link href="/app/new" className="mt-4 inline-flex min-h-10 items-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"><Plus aria-hidden="true" size={15} />Create a project</Link>
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {projects.data.items.map((project) => <ProjectRow key={project.id} project={project} />)}
              </ul>
            )}
          </section>

          <aside className="space-y-5">
            <section aria-labelledby="credit-balance-heading" className="rounded-2xl border border-border bg-card/85 p-5 shadow-sm backdrop-blur-xl sm:p-6">
              <div className="flex items-center gap-3">
                <span className="grid h-10 w-10 place-items-center rounded-xl bg-primary/10 text-primary"><Coins aria-hidden="true" size={19} /></span>
                <div>
                  <h2 id="credit-balance-heading" className="text-sm font-semibold">Available credits</h2>
                  <p className="mt-1 text-xs text-muted-foreground">From your current wallet.</p>
                </div>
              </div>
              {wallet.isPending ? <div role="status" aria-label="Loading credit balance" className="mt-5 h-10 animate-pulse rounded-lg bg-muted" /> : wallet.isError ? <LoadError message={wallet.error.message} onRetry={() => void wallet.refetch()} /> : (
                <div className="mt-5">
                  <p className="text-4xl font-semibold tracking-tight tabular-nums">{wallet.data.available.toLocaleString()}</p>
                  <p className="mt-2 text-sm text-muted-foreground">{wallet.data.reserved.toLocaleString()} reserved · {wallet.data.balance.toLocaleString()} settled</p>
                  {wallet.data.legacy && <p role="status" className="mt-4 rounded-xl border border-amber-600/25 bg-amber-500/5 p-3 text-sm leading-6 text-muted-foreground">This balance is legacy credit data. Wallet changes are unavailable until the account balance is reconciled.</p>}
                </div>
              )}
              <Link href="/app/credits" className="mt-5 inline-flex min-h-10 items-center gap-2 rounded-lg px-2 text-sm font-medium text-primary hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">View credit transactions <ArrowRight aria-hidden="true" size={15} /></Link>
            </section>
            <section className="rounded-2xl border border-border bg-muted/30 p-5 sm:p-6">
              <h2 className="text-base font-semibold">Processing status</h2>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">Project stages and saved outputs are shown from the processing API. Recap editing, narration, subtitles, and rendering depend on additional services.</p>
            </section>
          </aside>
        </div>
      </div>
    </main>
  );
}

function ProjectLibraryContent() {
  const [cursor, setCursor] = useState<string | null>(null);
  const [items, setItems] = useState<Project[]>([]);
  const params = new URLSearchParams({ limit: '25' });
  if (cursor) params.set('cursor', cursor);
  const page = useQuery({
    queryKey: ['project-library', cursor],
    queryFn: ({ signal }) => fetchData(`/api/v1/projects?${params.toString()}`, projectPageSchema, signal),
  });

  useEffect(() => {
    if (!page.data) return;
    setItems((current) => {
      if (!cursor) return page.data.items;
      const existing = new Set(current.map((item) => item.id));
      return [...current, ...page.data.items.filter((item) => !existing.has(item.id))];
    });
  }, [page.data, cursor]);

  return (
    <main className="min-h-screen bg-background text-foreground">
      <WorkspaceHeader />
      <div className="mx-auto max-w-6xl px-5 pb-16 pt-10 sm:px-8 sm:pt-14">
        <Link href="/app" className="mb-5 inline-flex min-h-10 items-center gap-2 rounded-lg px-2 text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"><ArrowLeft aria-hidden="true" size={15} />Workspace</Link>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="mb-2 text-sm font-medium text-primary">Your library</p>
            <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Movie projects</h1>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">Projects are shown from your account and link to their processing status.</p>
          </div>
          <Link href="/app/new" className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground hover:-translate-y-0.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"><Plus aria-hidden="true" size={16} />Create a project</Link>
        </div>
        <section aria-label="Project list" className="mt-8 rounded-2xl border border-border bg-card/85 px-5 shadow-sm backdrop-blur-xl sm:px-7">
          {page.isPending && items.length === 0 ? <div className="py-8"><LoadingRows label="Loading projects" /></div> : page.isError && items.length === 0 ? <LoadError message={page.error.message} onRetry={() => void page.refetch()} /> : items.length === 0 ? (
            <div className="py-14 text-center">
              <span className="mx-auto grid h-11 w-11 place-items-center rounded-xl bg-muted text-muted-foreground"><FolderOpen aria-hidden="true" size={19} /></span>
              <h2 className="mt-3 text-sm font-semibold">No movie projects yet</h2>
              <p className="mt-1 text-sm text-muted-foreground">Your projects will appear here after you create one.</p>
            </div>
          ) : (
            <>
              <ul className="divide-y divide-border">{items.map((project) => <ProjectRow key={project.id} project={project} />)}</ul>
              {page.isError && <LoadError message={page.error.message} onRetry={() => void page.refetch()} />}
              {page.data?.nextCursor && <div className="flex justify-center border-t border-border py-5"><button type="button" disabled={page.isFetching} onClick={() => setCursor(page.data?.nextCursor ?? null)} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-border bg-background px-4 text-sm font-medium hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-60"><RefreshCw aria-hidden="true" size={15} className={page.isFetching ? 'animate-spin' : ''} />{page.isFetching ? 'Loading projects' : 'Load more projects'}</button></div>}
            </>
          )}
        </section>
      </div>
    </main>
  );
}

function WorkspaceHeader() {
  return <header className="border-b border-border bg-card/85 backdrop-blur-xl"><div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-5 sm:px-8">
    <Link href="/app" className="inline-flex items-center gap-3 font-semibold tracking-tight focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"><span className="grid h-9 w-9 place-items-center rounded-xl bg-primary text-primary-foreground"><Clapperboard aria-hidden="true" size={18} /></span>instantcap</Link>
    <nav aria-label="Workspace" className="flex items-center gap-2 sm:gap-3"><Link href="/app/projects" aria-current="page" className="rounded-lg px-3 py-2 text-sm font-medium text-foreground hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">Projects</Link><Link href="/app/credits" className="rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">Credits</Link><SignOutButton /></nav>
  </div></header>;
}

function ProjectRow({ project }: { project: Project }) {
  const dateValue = project.updatedAt ?? project.createdAt;
  const date = dateValue && !Number.isNaN(new Date(dateValue).getTime())
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(dateValue))
    : null;
  return (
    <li>
      <Link href={`/app/projects/${encodeURIComponent(project.id)}/processing`} className="flex min-h-[72px] items-center gap-3 py-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:gap-4">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-muted text-muted-foreground"><Clapperboard aria-hidden="true" size={18} /></span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold">{project.title}</span>
          <span className="mt-1 block text-sm text-muted-foreground">{project.status.replace(/[_-]+/g, ' ').toLowerCase()}{date ? ` · ${date}` : ''}</span>
        </span>
        <ArrowRight aria-hidden="true" size={16} className="shrink-0 text-muted-foreground" />
      </Link>
    </li>
  );
}

function LoadingRows({ label }: { label: string }) {
  return <div role="status" aria-label={label} className="space-y-4">{[0, 1, 2].map((item) => <div key={item} className="h-[68px] animate-pulse rounded-xl bg-muted" />)}<span className="sr-only">{label}</span></div>;
}

function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  useEffect(() => {
    notify({ tone: 'error', title: 'Workspace data could not be loaded', message, durationMs: 8000 });
  }, [message]);
  return <div role="alert" className="mt-4 rounded-xl border border-destructive/25 bg-destructive/5 p-4 text-sm">
    <p className="flex items-start gap-2 text-destructive"><AlertCircle aria-hidden="true" size={16} className="mt-0.5 shrink-0" />{message}</p>
    <button type="button" onClick={onRetry} className="mt-3 inline-flex min-h-9 items-center gap-2 rounded-lg px-2 font-medium text-primary hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"><RefreshCw aria-hidden="true" size={14} />Try again</button>
  </div>;
}
