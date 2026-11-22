'use client';

import { gsap } from 'gsap';
import { AlertTriangle, CheckCircle2, CircleAlert, Coins, Info, LoaderCircle, X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

export type NotificationTone = 'success' | 'error' | 'warning' | 'info' | 'processing' | 'completed' | 'payment';

export type IslandNotification = {
  id?: string;
  tone: NotificationTone;
  title: string;
  message?: string;
  durationMs?: number;
  progress?: number;
  actionLabel?: string;
  onAction?: () => void;
};

type QueuedNotification = IslandNotification & { id: string };

const notificationEventName = 'instantcap:notification';

export function notify(input: IslandNotification) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<IslandNotification>(notificationEventName, { detail: input }));
}

export function NotificationIslandProvider({ children }: { children: React.ReactNode }) {
  const [queue, setQueue] = useState<QueuedNotification[]>([]);
  const [expanded, setExpanded] = useState(false);
  const islandRef = useRef<HTMLDivElement>(null);
  const active = queue[0];
  const activeId = active?.id;
  const activeDuration = active?.durationMs;
  const activeTone = active?.tone;

  useEffect(() => {
    function receive(event: Event) {
      const detail = (event as CustomEvent<IslandNotification>).detail;
      if (!detail?.title) return;
      const id = detail.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setQueue((current) => current.some((item) => item.id === id) ? current : [...current, { ...detail, id }]);
    }
    window.addEventListener(notificationEventName, receive);
    return () => window.removeEventListener(notificationEventName, receive);
  }, []);

  const dismiss = useCallback((id: string) => {
    const island = islandRef.current;
    const reduced = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (island && activeId === id && !reduced) {
      const content = island.querySelector<HTMLElement>('[data-island-content]');
      const timeline = gsap.timeline({
        onComplete: () => {
          setExpanded(false);
          setQueue((current) => current.filter((item) => item.id !== id));
        },
      });
      if (content) timeline.to(content, { opacity: 0, y: 6, duration: 0.12, ease: 'power1.in' });
      timeline
        .to(island, { width: 14, height: 14, borderRadius: '50%', scaleX: 1.16, scaleY: 0.72, duration: 0.26, ease: 'power3.inOut' })
        .to(island, { y: -window.innerHeight, opacity: 0, scaleX: 0.82, scaleY: 0.82, duration: 0.42, ease: 'power2.in' }, '-=0.04');
      return;
    }
    setExpanded(false);
    setQueue((current) => current.filter((item) => item.id !== id));
  }, [activeId]);

  const toggleExpanded = useCallback(() => {
    const island = islandRef.current;
    if (island) gsap.set(island, { height: island.getBoundingClientRect().height });
    setExpanded((value) => !value);
  }, []);

  useEffect(() => {
    if (!activeId) return;
    setExpanded(false);
    const timeout = activeDuration ?? (activeTone === 'error' || activeTone === 'payment' || activeTone === 'processing' ? 0 : 5200);
    if (!timeout) return;
    const timer = window.setTimeout(() => dismiss(activeId), timeout);
    return () => window.clearTimeout(timer);
  }, [activeId, activeDuration, activeTone, dismiss]);

  return <>
    {children}
    {active && <IslandNotice key={active.id} containerRef={islandRef} notice={active} count={queue.length} expanded={expanded} onToggle={toggleExpanded} onDismiss={() => dismiss(active.id)} />}
  </>;
}

function IslandNotice({ containerRef, notice, count, expanded, onToggle, onDismiss }: { containerRef: React.RefObject<HTMLDivElement>; notice: QueuedNotification; count: number; expanded: boolean; onToggle: () => void; onDismiss: () => void }) {
  const Icon = iconFor(notice.tone);
  const progress = typeof notice.progress === 'number' ? Math.max(0, Math.min(100, Math.round(notice.progress))) : null;
  const contentRef = useRef<HTMLDivElement>(null);
  const detailsRef = useRef<HTMLDivElement>(null);
  const enteredRef = useRef(false);

  useLayoutEffect(() => {
    const element = containerRef.current;
    const content = contentRef.current;
    if (!element || !content) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const expandedWidth = Math.min(560, window.innerWidth - 24);
    const targetWidth = expandedWidth;
    const targetHeight = expanded ? element.scrollHeight : 70;

    if (reduced) {
      gsap.set(element, { width: targetWidth, height: expanded ? 'auto' : targetHeight, borderRadius: 28, opacity: 1, x: 0, y: 0, scaleX: 1, scaleY: 1 });
      gsap.set(content, { opacity: 1, y: 0 });
      if (detailsRef.current) gsap.set(detailsRef.current, { opacity: 1, y: 0 });
      enteredRef.current = true;
      return;
    }

    if (!enteredRef.current) {
      gsap.set(element, { width: 14, height: 14, borderRadius: '50%', opacity: 1, x: 0, y: -window.innerHeight, scaleX: 0.82, scaleY: 0.82 });
      gsap.set(content, { opacity: 0, y: 6 });
      const timeline = gsap.timeline({ onComplete: () => { if (expanded) element.style.height = 'auto'; } });
      timeline
        .to(element, { y: 0, duration: 0.62, ease: 'bounce.out' })
        .to(element, { scaleX: 1.2, scaleY: 0.62, duration: 0.09, ease: 'power2.out' })
        .to(element, { scaleX: 0.92, scaleY: 1.1, duration: 0.11, ease: 'power1.out' })
        .to(element, { width: targetWidth, height: targetHeight, borderRadius: 28, scaleX: 1, scaleY: 1, duration: 0.34, ease: 'power3.inOut' })
        .to(content, { opacity: 1, y: 0, duration: 0.2, ease: 'power2.out' }, '-=0.1');
      enteredRef.current = true;
      return () => {
        const interrupted = timeline.progress() < 1;
        timeline.kill();
        if (interrupted) enteredRef.current = false;
      };
    }

    const currentHeight = element.getBoundingClientRect().height;
    gsap.set(element, { height: currentHeight });
    const timeline = gsap.timeline({ onComplete: () => { element.style.height = expanded ? 'auto' : `${targetHeight}px`; } });
    timeline.to(element, { width: targetWidth, height: targetHeight, borderRadius: 28, duration: 0.28, ease: 'power3.inOut' });
    if (expanded && detailsRef.current) {
      gsap.set(detailsRef.current, { opacity: 0, y: 6 });
      timeline.to(detailsRef.current, { opacity: 1, y: 0, duration: 0.18, ease: 'power2.out' }, '-=0.05');
    }
    return () => { timeline.kill(); };
  }, [containerRef, expanded, notice.id]);

  return <div className="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top)+12px)] z-[100] flex justify-center px-3">
    <div ref={containerRef} role={notice.tone === 'error' ? 'alert' : 'status'} aria-live={notice.tone === 'error' ? 'assertive' : 'polite'} aria-atomic="true" className={`pointer-events-auto w-full max-w-[560px] overflow-hidden rounded-[28px] border bg-background/95 text-foreground shadow-[0_18px_60px_rgba(14,28,33,0.24)] backdrop-blur-2xl ${borderFor(notice.tone)}`}>
      <div ref={contentRef} data-island-content>
      <div className="flex min-h-[68px] items-center gap-3 px-3.5 py-2.5 sm:px-4">
        <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-full ${iconSurfaceFor(notice.tone)}`}><Icon aria-hidden="true" size={17} className={notice.tone === 'processing' ? 'animate-spin' : ''} /></span>
        <button type="button" onClick={onToggle} aria-expanded={expanded} className="min-w-0 flex-1 rounded-md text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
          <span className="block truncate text-sm font-semibold">{notice.title}</span>
          {!expanded && notice.message && <span className="mt-0.5 block truncate text-xs text-muted-foreground">{notice.message}</span>}
        </button>
        {count > 1 && <span className="shrink-0 rounded-full bg-muted px-2 py-1 text-xs font-medium text-muted-foreground" aria-label={`${count - 1} more notifications`}>+{count - 1}</span>}
        <button type="button" onClick={onDismiss} aria-label="Dismiss notification" className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"><X aria-hidden="true" size={16} /></button>
      </div>
      {expanded && <div ref={detailsRef} className="px-4 pb-4 pl-[3.9rem] sm:pl-[4.25rem]">
        {notice.message && <p className="text-sm leading-6 text-muted-foreground">{notice.message}</p>}
        {progress !== null && <div className="mt-3">
          <div className="mb-1.5 flex items-center justify-between text-xs text-muted-foreground"><span>Progress</span><span>{progress}%</span></div>
          <div role="progressbar" aria-label={`${notice.title} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} className="h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${progress}%` }} /></div>
        </div>}
        {notice.actionLabel && notice.onAction && <button type="button" onClick={() => { notice.onAction?.(); onDismiss(); }} className="mt-3 inline-flex min-h-9 items-center rounded-lg bg-primary px-3 text-sm font-semibold text-primary-foreground hover:-translate-y-0.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">{notice.actionLabel}</button>}
        {count > 1 && <p className="mt-3 text-xs text-muted-foreground">{count - 1} more queued</p>}
      </div>}
      </div>
    </div>
  </div>;
}

function iconFor(tone: NotificationTone) {
  if (tone === 'success' || tone === 'completed') return CheckCircle2;
  if (tone === 'error') return CircleAlert;
  if (tone === 'warning') return AlertTriangle;
  if (tone === 'processing') return LoaderCircle;
  if (tone === 'payment') return Coins;
  return Info;
}

function borderFor(tone: NotificationTone) {
  if (tone === 'error') return 'border-destructive/40';
  if (tone === 'warning') return 'border-amber-600/35';
  if (tone === 'success' || tone === 'completed') return 'border-emerald-700/30';
  if (tone === 'payment') return 'border-primary/35';
  return 'border-border';
}

function iconSurfaceFor(tone: NotificationTone) {
  if (tone === 'error') return 'bg-destructive/10 text-destructive';
  if (tone === 'warning') return 'bg-amber-500/10 text-amber-800 dark:text-amber-300';
  if (tone === 'success' || tone === 'completed') return 'bg-emerald-600/10 text-emerald-800 dark:text-emerald-300';
  return 'bg-primary/10 text-primary';
}
