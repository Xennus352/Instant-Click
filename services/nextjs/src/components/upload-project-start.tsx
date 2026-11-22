'use client';

import {
  ArrowRight,
  Check,
  CheckCircle2,
  CircleAlert,
  Clapperboard,
  Clock3,
  FileVideo2,
  Film,
  HardDrive,
  LoaderCircle,
  LogOut,
  RotateCcw,
  Sparkles,
  Upload,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { notify } from '@/components/notification-island';

const MAX_FILE_BYTES = 2_147_483_647;
const ACCEPTED_EXTENSIONS = ['mp4', 'mov', 'webm', 'mkv'] as const;
const ACCEPT_ATTRIBUTE = '.mp4,.mov,.webm,.mkv,video/mp4,video/quicktime,video/webm,video/x-matroska';

const uploadTicketSchema = z.object({
  uploadId: z.string().min(1),
  uploadUrl: z.string().url(),
  requiredHeaders: z.record(z.string()),
  expiresAt: z.string(),
});

const projectSchema = z.object({
  id: z.string().optional(),
  _id: z.string().optional(),
  title: z.string().optional(),
  name: z.string().optional(),
  status: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
}).passthrough();

type UploadTicket = z.infer<typeof uploadTicketSchema>;
type Project = {
  id: string;
  title: string;
  status: string;
  updatedAt?: string;
};

type UploadStage = 'idle' | 'creating' | 'uploading' | 'finalizing' | 'complete' | 'cancelled' | 'error';
type ProjectListState = 'loading' | 'ready' | 'error';

class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function apiMessage(payload: unknown): { message?: string; code?: string } {
  if (!isRecord(payload) || !isRecord(payload.error)) return {};
  return {
    message: typeof payload.error.message === 'string' ? payload.error.message : undefined,
    code: typeof payload.error.code === 'string' ? payload.error.code : undefined,
  };
}

async function readEnvelope<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiRequestError('The server returned an unreadable response.', response.status);
  }

  if (!response.ok) {
    const error = apiMessage(payload);
    throw new ApiRequestError(
      error.message || `The request failed (${response.status}).`,
      response.status,
      error.code,
    );
  }

  const data = isRecord(payload) ? payload.data : undefined;
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new ApiRequestError('The server response did not match the upload contract.', response.status);
  }
  return parsed.data;
}

function userFacingError(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.status === 401) return 'Your session has expired. Sign in again, then retry the upload.';
    if (error.status === 403) return 'Your account cannot start a project right now.';
    if (error.status === 413) return 'This file is larger than the server allows.';
    if (error.status === 429) return 'Uploads are busy right now. Wait a moment and try again.';
    return error.message;
  }
  if (error instanceof Error && error.name === 'AbortError') return 'The request was cancelled.';
  return 'We could not complete this upload. Check your connection and try again.';
}

function contentTypeFor(file: File): string {
  const extension = extensionFor(file);
  if (extension === 'mp4') return 'video/mp4';
  if (extension === 'mov') return 'video/quicktime';
  if (extension === 'webm') return 'video/webm';
  if (extension === 'mkv') return 'video/x-matroska';
  return file.type;
}

function extensionFor(file: File): string {
  return file.name.split('.').pop()?.toLowerCase() ?? '';
}

function validateFile(file: File): string | null {
  const extension = extensionFor(file);
  const hasAcceptedExtension = ACCEPTED_EXTENSIONS.includes(extension as (typeof ACCEPTED_EXTENSIONS)[number]);
  if (!hasAcceptedExtension) return 'Choose an MP4, MOV, WebM, or MKV video file.';
  if (file.size <= 0) return 'This file is empty. Choose a video with content.';
  if (file.size > MAX_FILE_BYTES) return 'This file is over the 2 GB upload limit.';
  return null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

function formatDate(value?: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
}

function toProject(value: unknown): Project | null {
  const parsed = projectSchema.safeParse(value);
  if (!parsed.success) return null;
  const item = parsed.data;
  const id = item.id ?? item._id;
  if (!id) return null;
  return {
    id,
    title: item.title ?? item.name ?? 'Untitled movie',
    status: item.status ?? 'Uploaded',
    updatedAt: item.updatedAt ?? item.createdAt,
  };
}

function listFromPayload(payload: unknown): Project[] {
  if (!isRecord(payload) || !('data' in payload)) {
    throw new ApiRequestError('The project list response did not match the expected format.');
  }
  const data = payload.data;
  const rows = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.items)
      ? data.items
      : isRecord(data) && Array.isArray(data.projects)
        ? data.projects
        : null;
  if (!rows) throw new ApiRequestError('The project list response did not match the expected format.');
  return rows.map(toProject).filter((project): project is Project => project !== null);
}

async function readProjects(signal?: AbortSignal): Promise<Project[]> {
  const response = await fetch('/api/v1/projects', {
    credentials: 'include',
    headers: { Accept: 'application/json' },
    signal,
  });
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiRequestError('The project list could not be read.', response.status);
  }
  if (!response.ok) {
    const error = apiMessage(payload);
    throw new ApiRequestError(error.message || `The request failed (${response.status}).`, response.status, error.code);
  }
  return listFromPayload(payload);
}

async function createUploadTicket(file: File, title: string, idempotencyKey: string, signal: AbortSignal): Promise<UploadTicket> {
  const response = await fetch('/api/v1/projects/uploads', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({
      title,
      fileName: file.name,
      contentType: contentTypeFor(file),
      fileSize: file.size,
    }),
    signal,
  });
  return readEnvelope(response, uploadTicketSchema);
}

function transferFile(
  ticket: UploadTicket,
  file: File,
  signal: AbortSignal,
  onProgress: (loaded: number, total: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', ticket.uploadUrl);
    xhr.withCredentials = false;
    Object.entries(ticket.requiredHeaders).forEach(([name, value]) => xhr.setRequestHeader(name, value));

    const abort = () => xhr.abort();
    signal.addEventListener('abort', abort, { once: true });

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded, event.total);
    };
    xhr.onload = () => {
      signal.removeEventListener('abort', abort);
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new ApiRequestError(`Storage rejected the upload (${xhr.status}).`, xhr.status));
    };
    xhr.onerror = () => {
      signal.removeEventListener('abort', abort);
      reject(new ApiRequestError('The connection to storage failed. Check your connection and retry.'));
    };
    xhr.onabort = () => {
      signal.removeEventListener('abort', abort);
      reject(new DOMException('Upload cancelled', 'AbortError'));
    };

    if (signal.aborted) {
      xhr.abort();
      return;
    }
    xhr.send(file);
  });
}

async function completeUpload(uploadId: string, signal: AbortSignal): Promise<Project> {
  const response = await fetch(`/api/v1/projects/uploads/${encodeURIComponent(uploadId)}/complete`, {
    method: 'POST',
    credentials: 'include',
    headers: { Accept: 'application/json' },
    signal,
  });
  const data = await readEnvelope(response, z.object({ project: projectSchema }));
  const project = toProject(data.project);
  if (!project) throw new ApiRequestError('The completed project response did not include a project ID.');
  return project;
}

async function cancelUploadSession(uploadId: string): Promise<void> {
  const response = await fetch(`/api/v1/projects/uploads/${encodeURIComponent(uploadId)}`, {
    method: 'DELETE',
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  if (response.ok || response.status === 404) return;
  const payload: unknown = await response.json().catch(() => null);
  const error = apiMessage(payload);
  throw new ApiRequestError(error.message || `Could not cancel this upload (${response.status}).`, response.status, error.code);
}

function statusLabel(status: string): string {
  return status.replace(/[_-]+/g, ' ').toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function UploadProjectStart() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const activeAttemptRef = useRef(0);
  const uploadIdRef = useRef<string | null>(null);
  const createControllerRef = useRef<AbortController | null>(null);
  const transferControllerRef = useRef<AbortController | null>(null);
  const completeControllerRef = useRef<AbortController | null>(null);
  const projectListControllerRef = useRef<AbortController | null>(null);

  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [stage, setStage] = useState<UploadStage>('idle');
  const [progress, setProgress] = useState<{ loaded: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelNotice, setCancelNotice] = useState<string | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [dragging, setDragging] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectListState, setProjectListState] = useState<ProjectListState>('loading');
  const [projectListError, setProjectListError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  async function signOut() {
    setSigningOut(true);
    setError(null);
    try {
      const response = await fetch('/api/auth/sign-out', {
        method: 'POST',
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        setError('We could not end this session. Try again.');
        notify({ tone: 'error', title: 'Sign out failed', message: 'We could not end this session. Try again.', durationMs: 8000 });
        setSigningOut(false);
        return;
      }
      window.location.assign('/login');
    } catch {
      setError('We could not end this session. Check your connection and try again.');
      notify({ tone: 'error', title: 'Sign out failed', message: 'We could not end this session. Check your connection and try again.', durationMs: 8000 });
      setSigningOut(false);
    }
  }

  const refreshProjects = useCallback(async () => {
    projectListControllerRef.current?.abort();
    const controller = new AbortController();
    projectListControllerRef.current = controller;
    setProjectListState('loading');
    setProjectListError(null);
    try {
      const result = await readProjects(controller.signal);
      if (!controller.signal.aborted) {
        setProjects(result);
        setProjectListState('ready');
      }
    } catch (reason) {
      if (!controller.signal.aborted) {
        setProjects([]);
        setProjectListError(userFacingError(reason));
        setProjectListState('error');
      }
    }
  }, []);

  useEffect(() => {
    void refreshProjects();
    return () => {
      activeAttemptRef.current += 1;
      if (uploadIdRef.current) void cancelUploadSession(uploadIdRef.current).catch(() => undefined);
      projectListControllerRef.current?.abort();
      createControllerRef.current?.abort();
      transferControllerRef.current?.abort();
      completeControllerRef.current?.abort();
    };
  }, [refreshProjects]);

  useEffect(() => {
    if (error && stage === 'idle') {
      notify({ tone: 'error', title: 'File cannot be selected', message: error, durationMs: 8000 });
    } else if (stage === 'complete' && project) {
      notify({ tone: 'success', title: 'Movie project created', message: 'The server accepted the upload. Open processing status to see the current verification state.' });
    } else if (stage === 'error' && error) {
      notify({ tone: 'error', title: 'Upload could not be completed', message: error, durationMs: 8000 });
    } else if (stage === 'cancelled') {
      notify({ tone: 'warning', title: 'Upload cancelled', message: cancelNotice ?? 'The upload was stopped.' });
    } else if (projectListState === 'error' && projectListError) {
      notify({ tone: 'error', title: 'Projects could not be loaded', message: projectListError, durationMs: 8000 });
    }
  }, [stage, project, error, cancelNotice, projectListState, projectListError]);

  function selectFile(candidate: File | undefined) {
    if (!candidate) return;
    const validationError = validateFile(candidate);
    setError(validationError);
    setCancelNotice(null);
    setProject(null);
    setProgress(null);
    setStage('idle');
    if (validationError) {
      setFile(null);
      setTitle('');
      return;
    }
    setFile(candidate);
    setTitle((previous) => previous.trim() || candidate.name.replace(/\.[^.]+$/, ''));
  }

  async function startUpload(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) {
      setError('Choose a video file to continue.');
      return;
    }
    const validationError = validateFile(file);
    if (validationError) {
      setError(validationError);
      return;
    }
    const normalizedTitle = title.trim();
    if (!normalizedTitle) {
      setError('Add a title for this project.');
      return;
    }
    if (normalizedTitle.length > 160) {
      setError('Project titles can be up to 160 characters.');
      return;
    }

    const attempt = activeAttemptRef.current + 1;
    activeAttemptRef.current = attempt;
    uploadIdRef.current = null;
    setError(null);
    setCancelNotice(null);
    setProject(null);
    setProgress(null);
    setStage('creating');

    const createController = new AbortController();
    createControllerRef.current = createController;
    try {
      const ticket = await createUploadTicket(file, normalizedTitle, crypto.randomUUID(), createController.signal);
      uploadIdRef.current = ticket.uploadId;
      if (attempt !== activeAttemptRef.current) {
        void cancelUploadSession(ticket.uploadId).catch(() => undefined);
        return;
      }

      setStage('uploading');
      const transferController = new AbortController();
      transferControllerRef.current = transferController;
      await transferFile(ticket, file, transferController.signal, (loaded, total) => {
        if (attempt === activeAttemptRef.current) setProgress({ loaded, total });
      });
      if (attempt !== activeAttemptRef.current) return;

      setStage('finalizing');
      const completeController = new AbortController();
      completeControllerRef.current = completeController;
      const result = await completeUpload(ticket.uploadId, completeController.signal);
      if (attempt !== activeAttemptRef.current) return;

      uploadIdRef.current = null;
      setProject(result);
      setStage('complete');
      void refreshProjects();
    } catch (reason) {
      if (attempt !== activeAttemptRef.current) return;
      if (reason instanceof Error && reason.name === 'AbortError') {
        setStage('cancelled');
        return;
      }
      const failedUploadId = uploadIdRef.current;
      uploadIdRef.current = null;
      if (failedUploadId) {
        void cancelUploadSession(failedUploadId).catch(() => {
          setCancelNotice('The failed upload session could not be cleared. It will expire automatically.');
        });
      }
      setError(userFacingError(reason));
      setStage('error');
    } finally {
      if (attempt === activeAttemptRef.current) {
        createControllerRef.current = null;
        transferControllerRef.current = null;
        completeControllerRef.current = null;
      }
    }
  }

  async function cancelCurrentUpload() {
    const uploadId = uploadIdRef.current;
    activeAttemptRef.current += 1;
    createControllerRef.current?.abort();
    transferControllerRef.current?.abort();
    completeControllerRef.current?.abort();
    createControllerRef.current = null;
    transferControllerRef.current = null;
    completeControllerRef.current = null;
    uploadIdRef.current = null;
    setStage('cancelled');
    setProgress(null);
    setError(null);
    setCancelNotice(null);

    if (uploadId) {
      try {
        await cancelUploadSession(uploadId);
      } catch {
        setCancelNotice('The transfer stopped, but the upload session could not be cleared. It will expire automatically.');
      }
    }
  }

  function resetFlow() {
    setFile(null);
    setTitle('');
    setProject(null);
    setError(null);
    setCancelNotice(null);
    setProgress(null);
    setStage('idle');
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  const busy = stage === 'creating' || stage === 'uploading' || stage === 'finalizing';
  const canSubmit = Boolean(file && title.trim()) && !busy;
  const progressPercent = progress ? Math.min(100, Math.round((progress.loaded / progress.total) * 100)) : null;

  return (
    <main className="min-h-screen overflow-hidden bg-[#f2f6f6] text-[#172329]">
      <div aria-hidden="true" className="pointer-events-none fixed inset-0 -z-0 overflow-hidden">
        <div className="absolute -right-32 -top-40 h-[34rem] w-[34rem] rounded-full bg-[#c9e9e7]/60 blur-[100px]" />
        <div className="absolute -left-40 top-[28rem] h-[28rem] w-[28rem] rounded-full bg-[#d9e8f2]/70 blur-[100px]" />
      </div>

      <div className="relative z-10 mx-auto max-w-[1440px] px-5 pb-16 sm:px-8 lg:px-12">
        <header className="flex h-[76px] items-center justify-between border-b border-[#dbe5e5]/80">
          <Link href="/app" className="inline-flex items-center gap-3 rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#287c89]" aria-label="InstantCap workspace">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-[#16343a] text-[#b9e3e1] shadow-[0_8px_24px_rgba(23,55,61,0.16)]">
              <Clapperboard aria-hidden="true" size={18} strokeWidth={1.8} />
            </span>
            <span className="text-[15px] font-semibold tracking-[-0.04em]">instantcap</span>
          </Link>

          <nav aria-label="Main navigation" className="hidden items-center gap-8 text-sm text-[#617176] md:flex">
            <Link className="font-medium text-[#263c40]" href="/app/projects">My projects</Link>
            <a className="transition-colors hover:text-[#16343a]" href="#how-it-works">How it works</a>
          </nav>

          <div className="flex items-center gap-3">
            <span className="hidden rounded-full border border-[#d7e3e3] bg-white/60 px-3 py-1.5 text-xs font-medium text-[#647478] sm:inline-flex">Project workspace</span>
            <span aria-label="Signed-in workspace" title="Signed-in workspace" className="grid h-9 w-9 place-items-center rounded-full border border-white/80 bg-[#d7e8e7] text-xs font-semibold text-[#1c525a] shadow-sm">IC</span>
            <button type="button" onClick={() => void signOut()} disabled={signingOut} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-[#d7e3e3] bg-white/70 px-3 text-xs font-semibold text-[#496166] transition-colors hover:bg-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#287c89] disabled:opacity-60" aria-label="Sign out of InstantCap">
              {signingOut ? <LoaderCircle aria-hidden="true" size={14} className="animate-spin" /> : <LogOut aria-hidden="true" size={14} />}
              <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </header>

        <section className="grid gap-8 pb-12 pt-10 sm:pt-14 lg:grid-cols-[minmax(0,1fr)_300px] lg:items-end lg:gap-14 lg:pb-14 lg:pt-[4.5rem]">
          <div className="max-w-[760px]">
            <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-[#d8e5e4] bg-white/65 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.13em] text-[#477078] shadow-[0_4px_18px_rgba(42,93,98,0.04)] backdrop-blur-md">
              <Sparkles aria-hidden="true" size={13} />
              Project workspace
            </div>
            <h1 className="max-w-[720px] text-[2.55rem] font-medium leading-[1.06] tracking-[-0.065em] text-[#15272c] sm:text-5xl lg:text-[3.75rem]">
              Start with a movie project.
            </h1>
            <p className="mt-5 max-w-[590px] text-[15px] leading-7 text-[#627277] sm:text-base">
              Upload a source video, follow server-reported processing status, and review outputs only when the service has saved them.
            </p>
          </div>
          <div id="how-it-works" className="grid grid-cols-3 gap-3 border-t border-[#d7e2e2] pt-5 lg:border-l lg:border-t-0 lg:pl-7 lg:pt-0">
            <div>
              <span className="mb-2 grid h-7 w-7 place-items-center rounded-full bg-[#dbeceb] text-[11px] font-semibold text-[#32656c]">01</span>
              <p className="text-xs font-medium text-[#375056]">Upload a file</p>
            </div>
            <div>
              <span className="mb-2 grid h-7 w-7 place-items-center rounded-full bg-white/75 text-[11px] font-semibold text-[#6d7b7f] ring-1 ring-[#e0e8e8]">02</span>
              <p className="text-xs font-medium text-[#6a787c]">Track status</p>
            </div>
            <div>
              <span className="mb-2 grid h-7 w-7 place-items-center rounded-full bg-white/75 text-[11px] font-semibold text-[#6d7b7f] ring-1 ring-[#e0e8e8]">03</span>
              <p className="text-xs font-medium text-[#6a787c]">View saved outputs</p>
            </div>
          </div>
        </section>

        <section className="grid gap-6 lg:grid-cols-[minmax(0,1.45fr)_minmax(300px,0.75fr)] lg:gap-7">
          <div className="rounded-[26px] border border-white/90 bg-white/80 p-5 shadow-[0_24px_70px_rgba(31,68,73,0.09)] backdrop-blur-xl sm:p-8 lg:p-9">
            <div className="mb-7 flex items-start justify-between gap-4">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#648087]">New project</p>
                <h2 className="mt-2 text-[1.4rem] font-medium tracking-[-0.045em] text-[#1c3035] sm:text-2xl">Bring your movie into the studio</h2>
                <p className="mt-2 text-sm leading-6 text-[#738186]">Choose a source file and give the project a title.</p>
              </div>
              <span className="hidden h-11 w-11 shrink-0 place-items-center rounded-2xl bg-[#edf5f4] text-[#3b777c] sm:grid">
                <Film aria-hidden="true" size={19} strokeWidth={1.7} />
              </span>
            </div>

            <form onSubmit={startUpload} noValidate>
              <label htmlFor="project-title" className="mb-2 block text-xs font-semibold text-[#40565b]">Project title</label>
              <input
                id="project-title"
                name="title"
                type="text"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={160}
                disabled={busy || stage === 'complete'}
                placeholder="Give this project a name"
                autoComplete="off"
                aria-describedby="title-help"
                className="h-12 w-full rounded-xl border border-[#dce5e5] bg-[#fbfdfd] px-4 text-sm text-[#203237] outline-none transition placeholder:text-[#9aa8aa] focus:border-[#559197] focus:ring-4 focus:ring-[#73b6b0]/15 disabled:cursor-not-allowed disabled:opacity-70"
              />
              <div id="title-help" className="mt-2 flex justify-between gap-3 text-[11px] text-[#899699]">
                <span>Keep it clear. You can rename it later.</span>
                <span>{title.length}/160</span>
              </div>

              <input
                ref={fileInputRef}
                type="file"
                accept={ACCEPT_ATTRIBUTE}
                aria-label="Choose a movie video file"
                className="sr-only"
                onChange={(event) => selectFile(event.currentTarget.files?.[0])}
              />

              {!file || stage === 'complete' ? (
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
                  onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
                  onDragLeave={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    setDragging(false);
                    selectFile(event.dataTransfer.files[0]);
                  }}
                  aria-describedby="upload-acceptance"
                  className={`mt-6 flex min-h-[220px] w-full flex-col items-center justify-center rounded-2xl border border-dashed px-5 text-center transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#287c89] ${dragging ? 'border-[#438a8d] bg-[#eaf6f4]' : 'border-[#cbdada] bg-[linear-gradient(145deg,rgba(245,250,249,0.92),rgba(250,252,252,0.82))] hover:border-[#8fb7b6] hover:bg-white'}`}
                >
                  <span className={`mb-4 grid h-14 w-14 place-items-center rounded-2xl shadow-[0_8px_24px_rgba(33,82,87,0.1)] transition-transform ${dragging ? 'scale-105 bg-[#234f55] text-white' : 'bg-white text-[#3a7c81]'}`}>
                    <Upload aria-hidden="true" size={22} strokeWidth={1.7} />
                  </span>
                  <span className="text-sm font-semibold text-[#2a4146]">{dragging ? 'Drop your movie here' : 'Drop your movie here or browse'}</span>
                  <span className="mt-2 text-xs text-[#849194]">MP4, MOV, WebM, or MKV · Up to 2 GB</span>
                  <span className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-[#dce6e5] bg-white px-3 py-2 text-xs font-semibold text-[#42656a] shadow-sm">
                    Browse files <Upload aria-hidden="true" size={13} />
                  </span>
                </button>
              ) : (
                <div className="mt-6 rounded-2xl border border-[#dce7e6] bg-[#f9fcfb] p-4 sm:p-5">
                  <div className="flex items-start gap-3">
                    <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-[#e6f1ef] text-[#3a7377]">
                      <FileVideo2 aria-hidden="true" size={20} strokeWidth={1.7} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-[#2b4145]">{file.name}</p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[#7a898c]">
                        <span>{formatBytes(file.size)}</span>
                        <span aria-hidden="true" className="h-1 w-1 rounded-full bg-[#bdcaca]" />
                        <span>{extensionFor(file).toUpperCase()} video</span>
                        <span aria-hidden="true" className="h-1 w-1 rounded-full bg-[#bdcaca]" />
                        <span>{contentTypeFor(file)}</span>
                      </div>
                    </div>
                    {!busy && (
                      <button
                        type="button"
                        onClick={() => { setFile(null); setProgress(null); setError(null); if (fileInputRef.current) fileInputRef.current.value = ''; }}
                        className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-[#7c8b8d] transition-colors hover:bg-[#e9f0ef] hover:text-[#314b50] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#287c89]"
                        aria-label="Remove selected movie"
                      >
                        <X aria-hidden="true" size={17} />
                      </button>
                    )}
                  </div>

                  {busy && (
                    <div className="mt-5 border-t border-[#e3ebea] pt-4" aria-live="polite">
                      <div className="mb-2 flex items-center justify-between gap-3 text-xs">
                        <span className="inline-flex items-center gap-2 font-medium text-[#426368]">
                          {stage === 'uploading' ? <Upload aria-hidden="true" size={14} /> : <LoaderCircle aria-hidden="true" size={14} className="animate-spin" />}
                          {stage === 'creating' && 'Preparing secure upload…'}
                          {stage === 'uploading' && 'Uploading movie…'}
                          {stage === 'finalizing' && 'Finishing your project…'}
                        </span>
                        {stage === 'uploading' && progressPercent !== null && <span className="font-semibold tabular-nums text-[#395c61]">{progressPercent}%</span>}
                      </div>
                      {stage === 'uploading' && progressPercent !== null ? (
                        <div
                          role="progressbar"
                          aria-label="Movie upload progress"
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={progressPercent}
                          className="h-2 overflow-hidden rounded-full bg-[#e5eeed]"
                        >
                          <div className="h-full rounded-full bg-[#4b9291] transition-[width] duration-150" style={{ width: `${progressPercent}%` }} />
                        </div>
                      ) : stage === 'uploading' ? (
                        <p role="status" className="text-[11px] text-[#879396]">Waiting for transfer progress from storage…</p>
                      ) : (
                        <div aria-hidden="true" className="h-2 rounded-full bg-[#e5eeed]" />
                      )}
                      {stage === 'uploading' && progress && (
                        <p className="mt-2 text-right text-[11px] text-[#879396]">{formatBytes(progress.loaded)} of {formatBytes(progress.total)}</p>
                      )}
                    </div>
                  )}
                </div>
              )}

              <p id="upload-acceptance" className="mt-3 flex items-start gap-2 text-[11px] leading-5 text-[#869396]">
                <HardDrive aria-hidden="true" size={13} className="mt-0.5 shrink-0" />
                Your original file is uploaded to private storage and linked to this project.
              </p>

              {error && (
                <div role="alert" className="mt-4 flex items-start gap-2.5 rounded-xl border border-[#efd0c8] bg-[#fff7f4] px-4 py-3 text-sm text-[#984c3e]">
                  <CircleAlert aria-hidden="true" size={17} className="mt-0.5 shrink-0" />
                  <p className="leading-5">{error}</p>
                </div>
              )}
              {cancelNotice && (
                <p role="status" className="mt-4 rounded-xl border border-[#eadfc9] bg-[#fffaf0] px-4 py-3 text-xs leading-5 text-[#81673c]">{cancelNotice}</p>
              )}
              {stage === 'cancelled' && !cancelNotice && !error && (
                <p role="status" className="mt-4 rounded-xl border border-[#dce7e6] bg-[#f7fbfa] px-4 py-3 text-xs text-[#607579]">Upload cancelled. Your selected file is ready if you want to try again.</p>
              )}

              {stage === 'complete' && project && (
                <div role="status" className="mt-5 flex items-start gap-3 rounded-xl border border-[#cfe5db] bg-[#f2faf5] p-4 text-[#315f4c]">
                  <CheckCircle2 aria-hidden="true" size={20} className="mt-0.5 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold">Project created.</p>
                    <p className="mt-1 truncate text-xs text-[#648273]">{project.title} · {statusLabel(project.status)}</p>
                    <Link href={`/app/projects/${encodeURIComponent(project.id)}/processing`} className="mt-3 inline-flex min-h-9 items-center gap-2 rounded-lg bg-[#315f4c] px-3 text-xs font-semibold text-white hover:-translate-y-0.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#287c89]">Open processing status <ArrowRight aria-hidden="true" size={14} /></Link>
                  </div>
                  <button type="button" onClick={resetFlow} className="shrink-0 rounded-lg px-2 py-1 text-xs font-semibold text-[#326b55] underline decoration-[#a6cdb9] underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#287c89]">
                    Start another
                  </button>
                </div>
              )}

              <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-[11px] text-[#929ea0]">Project status and saved processing results are available in the processing view.</p>
                {busy ? (
                  <button type="button" onClick={() => void cancelCurrentUpload()} className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-[#d9e4e3] bg-white px-5 text-sm font-semibold text-[#476167] transition-colors hover:bg-[#f6faf9] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#287c89]">
                    <X aria-hidden="true" size={15} /> Cancel upload
                  </button>
                ) : stage === 'complete' ? (
                  <span className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-[#e8f3ef] px-5 text-sm font-semibold text-[#3d725b]">
                    <Check aria-hidden="true" size={16} /> Project created
                  </span>
                ) : (
                  <button
                    type="submit"
                    disabled={!canSubmit}
                    className="inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-[#173b41] px-6 text-sm font-semibold text-white shadow-[0_10px_24px_rgba(23,59,65,0.16)] transition duration-150 hover:-translate-y-0.5 hover:bg-[#214e54] active:translate-y-0 disabled:cursor-not-allowed disabled:bg-[#a8b9b9] disabled:shadow-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-[#287c89]"
                  >
                    {stage === 'error' ? <RotateCcw aria-hidden="true" size={16} /> : <Upload aria-hidden="true" size={16} />}
                    {stage === 'error' ? 'Try upload again' : 'Create project'}
                    <ArrowRight aria-hidden="true" size={15} />
                  </button>
                )}
              </div>
            </form>
          </div>

          <aside className="flex flex-col gap-5">
            <div className="relative overflow-hidden rounded-[26px] bg-[#16343a] p-6 text-white shadow-[0_24px_60px_rgba(23,55,61,0.15)] sm:p-7">
              <div aria-hidden="true" className="absolute -right-16 -top-20 h-56 w-56 rounded-full bg-[#5fa7a0]/20 blur-3xl" />
              <div className="relative">
                <span className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.07] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.13em] text-[#b7d9d6]">
                  <Sparkles aria-hidden="true" size={12} /> Current project scope
                </span>
                <h2 className="mt-5 max-w-[270px] text-[1.55rem] font-medium leading-tight tracking-[-0.05em]">Status and saved data come from the service.</h2>
                <p className="mt-3 text-sm leading-6 text-[#c2d2d3]">Voice, subtitle, and video production tools are unavailable until their APIs and workers are implemented.</p>
                <div className="mt-6 flex items-center gap-3 border-t border-white/10 pt-5">
                  <span className="grid h-9 w-9 place-items-center rounded-xl bg-white/[0.08] text-[#bde1dd]"><Clock3 aria-hidden="true" size={17} /></span>
                  <p className="text-xs leading-5 text-[#c3d3d3]">Processing starts only when the backend confirms it is configured and eligible.</p>
                </div>
              </div>
            </div>

            <div id="projects" className="rounded-[24px] border border-white/85 bg-white/65 p-5 shadow-[0_12px_40px_rgba(31,68,73,0.06)] backdrop-blur-xl sm:p-6">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold tracking-[-0.02em] text-[#294045]">Recent projects</h2>
                  <p className="mt-1 text-[11px] text-[#8a989a]">Your latest uploads</p>
                </div>
                <span className="grid h-8 w-8 place-items-center rounded-lg bg-[#edf4f3] text-[#5b8083]"><Film aria-hidden="true" size={15} /></span>
              </div>

              {projectListState === 'loading' ? (
                <div aria-label="Loading projects" className="space-y-3" role="status">
                  {[0, 1].map((item) => <div key={item} className="h-[58px] animate-pulse rounded-xl bg-[#eaf0ef]" />)}
                </div>
              ) : projectListState === 'error' ? (
                <div className="rounded-xl border border-[#e7e9e7] bg-white/75 p-3.5">
                  <p className="text-xs leading-5 text-[#768487]">{projectListError}</p>
                  <button type="button" onClick={() => void refreshProjects()} className="mt-2 text-xs font-semibold text-[#3b7177] underline decoration-[#aac7c6] underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#287c89]">Try again</button>
                </div>
              ) : projects.length === 0 ? (
                <div className="rounded-xl border border-dashed border-[#d8e3e1] bg-white/55 px-4 py-5 text-center">
                  <span className="mx-auto grid h-9 w-9 place-items-center rounded-xl bg-[#eef5f3] text-[#6f9293]"><Clapperboard aria-hidden="true" size={16} /></span>
                  <p className="mt-3 text-xs font-medium text-[#52686b]">Your next story starts here.</p>
                  <p className="mt-1 text-[11px] leading-5 text-[#899698]">Create a project to see it in this list.</p>
                </div>
              ) : (
                <ul className="space-y-2">
                  {projects.slice(0, 4).map((item) => (
                    <li key={item.id}>
                      <Link href={`/app/projects/${encodeURIComponent(item.id)}/processing`} aria-label={`Open ${item.title} processing status`} className="flex min-h-[58px] min-w-0 items-center gap-3 rounded-xl border border-[#e5ebea] bg-white/75 px-3 py-3 transition-colors hover:bg-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#287c89]">
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[#edf4f3] text-[#598085]"><FileVideo2 aria-hidden="true" size={16} /></span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-semibold text-[#3d5559]">{item.title}</p>
                        <p className="mt-1 text-[10px] text-[#899698]">{statusLabel(item.status)}{formatDate(item.updatedAt) ? ` · ${formatDate(item.updatedAt)}` : ''}</p>
                      </div>
                      <ArrowRight aria-hidden="true" size={14} className="shrink-0 text-[#a3b0b0]" />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </aside>
        </section>

        <footer className="mt-10 flex flex-col gap-2 border-t border-[#dbe5e5]/80 pt-5 text-[11px] text-[#8c999b] sm:flex-row sm:items-center sm:justify-between">
          <p className="inline-flex items-center gap-2"><span className="h-1.5 w-1.5 rounded-full bg-[#6eaaa1]" /> Your upload is sent directly to secure storage.</p>
          <p>InstantCap · Made for stories worth sharing</p>
        </footer>
      </div>
    </main>
  );
}
