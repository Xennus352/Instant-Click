import Link from 'next/link';
import { ArrowRight, AudioLines, Clapperboard, FileText, Film, ScanSearch } from 'lucide-react';

const workflow = [
  { icon: Film, title: 'Create a project', detail: 'Upload a supported source video to your account.' },
  { icon: ScanSearch, title: 'Track service status', detail: 'See the processing state returned by the backend.' },
  { icon: FileText, title: 'Review saved outputs', detail: 'Open only transcript or recap data the service has persisted.' },
];

export default function Home() {
  return (
    <main id="top" className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-background/95">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 sm:px-8">
          <Link href="/" className="inline-flex items-center gap-3 rounded-md font-semibold tracking-tight focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-primary text-primary-foreground"><Clapperboard aria-hidden="true" size={18} /></span>
            instantcap
          </Link>
          <nav aria-label="Account" className="flex items-center gap-4">
            <Link href="/login" className="rounded-md px-2 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">Sign in</Link>
            <Link href="/register" className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground transition-transform hover:-translate-y-0.5 active:translate-y-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
              Create an account <ArrowRight aria-hidden="true" size={15} />
            </Link>
          </nav>
        </div>
      </header>

      <section className="mx-auto grid min-h-[calc(100svh-4rem)] max-w-6xl content-center gap-12 px-5 py-16 sm:px-8 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16 lg:py-20">
        <div className="max-w-2xl self-center">
          <p className="mb-5 inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-sm font-medium text-muted-foreground">
            <AudioLines aria-hidden="true" size={15} className="text-primary" />
            Movie project workspace
          </p>
          <h1 className="text-4xl font-medium leading-[1.08] tracking-[-0.05em] sm:text-6xl">Movie projects with clear processing status</h1>
          <p className="mt-6 max-w-xl text-base leading-7 text-muted-foreground sm:text-lg sm:leading-8">
            Create a project, follow the status reported by the service, and review saved outputs when they are available. The workspace shows only data the backend has actually persisted.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Link href="/register" className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-primary px-5 text-sm font-semibold text-primary-foreground transition-transform hover:-translate-y-0.5 active:translate-y-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
              Create an account <ArrowRight aria-hidden="true" size={16} />
            </Link>
            <Link href="/login" className="inline-flex min-h-12 items-center justify-center rounded-xl border border-border bg-card px-5 text-sm font-semibold transition-colors hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">Sign in</Link>
          </div>
          <p className="mt-5 text-sm leading-6 text-muted-foreground">Email verification is required. Processing starts after the source is verified and scan-clean, and each stage waits for its required AI or media service.</p>
        </div>

        <div className="self-center rounded-[28px] border border-border bg-card/85 p-5 shadow-[0_24px_70px_rgba(25,48,54,0.08)] backdrop-blur-xl sm:p-7">
          <div className="flex items-center gap-3 border-b border-border pb-5">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-primary/10 text-primary"><Clapperboard aria-hidden="true" size={19} /></span>
            <div>
              <h2 className="text-base font-semibold tracking-tight">Project pipeline</h2>
              <p className="mt-1 text-sm text-muted-foreground">Seven server-defined stages; results appear only after the service saves them.</p>
            </div>
          </div>
          <ol className="mt-3">
            {[
              ['Audio extraction', 'Prepare audio from the verified source'],
              ['Burmese transcription', 'Nara SAR transcript appears when persisted'],
              ['Movie analysis', 'Waits for configured Gemini readiness'],
              ['Recap script', 'Gemini output appears only after it is saved'],
              ['Narration', 'Nara Mini voice output follows the saved script'],
              ['Subtitle timing', 'Built from measured narration'],
              ['Video rendering', 'The final video appears after render completes'],
            ].map(([title, detail], index) => (
              <li key={title} className="flex items-start gap-4 border-b border-border py-4 last:border-0 last:pb-1">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-border bg-background text-xs font-semibold text-muted-foreground">{String(index + 1).padStart(2, '0')}</span>
                <div>
                  <h3 className="text-sm font-semibold">{title}</h3>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">{detail}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section aria-labelledby="workflow-heading" className="border-t border-border bg-muted/30">
        <div className="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-20">
          <div className="max-w-2xl">
            <h2 id="workflow-heading" className="text-2xl font-medium tracking-tight sm:text-3xl">A workspace grounded in service data</h2>
            <p className="mt-3 text-base leading-7 text-muted-foreground">Project and pipeline screens use the current API. Processing starts only when the backend reports it is configured and eligible.</p>
          </div>
          <div className="mt-8 grid gap-4 md:grid-cols-3">
            {workflow.map(({ icon: Icon, title, detail }) => (
              <article key={title} className="rounded-2xl border border-border bg-card p-5 transition-transform hover:-translate-y-0.5 sm:p-6">
                <span className="mb-5 grid h-10 w-10 place-items-center rounded-xl bg-primary/10 text-primary"><Icon aria-hidden="true" size={19} /></span>
                <h3 className="text-base font-semibold">{title}</h3>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{detail}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-5 py-6 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <Link href="/" className="font-semibold text-foreground">instantcap</Link>
          <p>Movie project workspace.</p>
        </div>
      </footer>
    </main>
  );
}
