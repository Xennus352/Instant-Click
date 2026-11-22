'use client';

import { AlertCircle, CheckCircle2, Coins, LoaderCircle } from 'lucide-react';
import { FormEvent, useState } from 'react';
import { z } from 'zod';
import { notify } from '@/components/notification-island';

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Enter a 24-character account or capture ID.');
const balanceMutationSchema = z.object({
  userId: objectId,
  type: z.enum(['GRANT', 'ADJUSTMENT', 'EXPIRY']),
  amount: z.number().int().safe().refine((amount) => amount !== 0, 'Enter a nonzero whole-credit amount.'),
  reason: z.string().trim().min(3).max(500),
  sourceRecordId: z.string().trim().max(128).optional(),
}).superRefine((input, ctx) => {
  if (input.type === 'GRANT' && input.amount <= 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['amount'], message: 'A grant amount must be positive.' });
});

const refundMutationSchema = z.object({
  userId: objectId,
  captureId: objectId,
  amount: z.number().int().positive().safe(),
  reason: z.string().trim().min(3).max(500),
});

const resultSchema = z.object({
  id: z.string(),
  type: z.string(),
  amount: z.number().int(),
  balanceAfter: z.number().int(),
  reservedAfter: z.number().int(),
  status: z.string(),
});

type Result = z.infer<typeof resultSchema>;
type MutationKind = 'balance' | 'refund';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function errorFrom(payload: unknown): string {
  if (!isRecord(payload)) return 'The request could not be completed.';
  const error = isRecord(payload.error) ? payload.error : payload;
  return typeof error.message === 'string' ? error.message : 'The request could not be completed.';
}

export function AdminCreditConsole() {
  const [mutationKind, setMutationKind] = useState<MutationKind>('balance');
  const [userId, setUserId] = useState('');
  const [captureId, setCaptureId] = useState('');
  const [type, setType] = useState<'GRANT' | 'ADJUSTMENT' | 'EXPIRY'>('GRANT');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [sourceRecordId, setSourceRecordId] = useState('');
  const [formError, setFormError] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [pendingPayload, setPendingPayload] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);

  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError('');
    setResult(null);
    const parsedAmount = Number(amount);
    const parsed = mutationKind === 'balance'
      ? balanceMutationSchema.safeParse({ userId: userId.trim(), type, amount: parsedAmount, reason, sourceRecordId: sourceRecordId.trim() || undefined })
      : refundMutationSchema.safeParse({ userId: userId.trim(), captureId: captureId.trim(), amount: parsedAmount, reason });
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? 'Check the values and try again.';
      setFormError(message);
      notify({ tone: 'error', title: 'Credit action needs attention', message });
      return;
    }
    setPendingPayload(parsed.data as Record<string, unknown>);
  }

  async function applyMutation() {
    if (!pendingPayload) return;
    setBusy(true);
    setFormError('');
    try {
      const response = await fetch(mutationKind === 'balance' ? '/api/v1/admin/credits/balance-changes' : '/api/v1/admin/credits/refunds', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify(pendingPayload),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(errorFrom(payload));
      const data = isRecord(payload) && isRecord(payload.data) ? payload.data : undefined;
      const parsed = resultSchema.safeParse(data);
      if (!parsed.success) throw new Error('The API response did not match the documented transaction result.');
      setResult(parsed.data);
      setPendingPayload(null);
      setAmount('');
      setReason('');
      setSourceRecordId('');
      setCaptureId('');
      notify({ tone: 'success', title: 'Credit transaction posted', message: `${parsed.data.type.replace(/_/g, ' ').toLowerCase()} · ${parsed.data.amount.toLocaleString()} credits · ${parsed.data.status.toLowerCase()}` });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The credit action could not be completed.';
      setFormError(message);
      notify({ tone: 'error', title: 'Credit transaction failed', message, durationMs: 8000 });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl">
        <section aria-labelledby="credit-actions-heading" className="rounded-2xl border border-border bg-card/85 p-5 shadow-sm backdrop-blur-xl sm:p-7">
          <h2 id="credit-actions-heading" className="text-lg font-semibold tracking-tight">Post a credit transaction</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">The API writes an audited balance change or captured-credit refund. It enforces admin role, idempotency, and refund limits.</p>
          <div role="tablist" aria-label="Credit action type" className="mt-5 grid grid-cols-2 gap-2 rounded-xl bg-muted/60 p-1">
            <button type="button" role="tab" aria-selected={mutationKind === 'balance'} onClick={() => { setMutationKind('balance'); setPendingPayload(null); setResult(null); }} className={`min-h-10 rounded-lg px-3 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${mutationKind === 'balance' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>Grant or adjust</button>
            <button type="button" role="tab" aria-selected={mutationKind === 'refund'} onClick={() => { setMutationKind('refund'); setPendingPayload(null); setResult(null); }} className={`min-h-10 rounded-lg px-3 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${mutationKind === 'refund' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>Refund capture</button>
          </div>

          <form className="mt-6 space-y-4" onSubmit={review} noValidate>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="User ID" id="admin-user-id" hint="MongoDB ObjectId from a verified admin record."><input id="admin-user-id" autoComplete="off" value={userId} onChange={(event) => setUserId(event.target.value)} className={inputClass} maxLength={24} /></Field>
              {mutationKind === 'balance' ? <Field label="Change type" id="admin-change-type"><select id="admin-change-type" value={type} onChange={(event) => setType(event.target.value as typeof type)} className={inputClass}><option value="GRANT">Grant</option><option value="ADJUSTMENT">Adjustment</option><option value="EXPIRY">Expiry</option></select></Field> : <Field label="Capture ID" id="admin-capture-id" hint="Only captured credits can be refunded."><input id="admin-capture-id" autoComplete="off" value={captureId} onChange={(event) => setCaptureId(event.target.value)} className={inputClass} maxLength={24} /></Field>}
              <Field label="Amount (credits)" id="admin-amount" hint={mutationKind === 'balance' && type !== 'GRANT' ? 'Use a negative amount for a debit or expiry.' : undefined}><input id="admin-amount" type="number" step="1" inputMode="numeric" value={amount} onChange={(event) => setAmount(event.target.value)} className={inputClass} /></Field>
              {mutationKind === 'balance' && <Field label="Source record ID (optional)" id="admin-source-id"><input id="admin-source-id" autoComplete="off" value={sourceRecordId} onChange={(event) => setSourceRecordId(event.target.value)} className={inputClass} maxLength={128} /></Field>}
            </div>
            <Field label="Reason" id="admin-reason" hint="This reason is stored with the ledger entry."><textarea id="admin-reason" value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} rows={3} className={`${inputClass} h-auto py-3`} /></Field>
            {formError && <p role="alert" className="flex items-start gap-2 rounded-xl border border-destructive/25 bg-destructive/5 p-3.5 text-sm leading-6 text-destructive"><AlertCircle aria-hidden="true" size={16} className="mt-0.5 shrink-0" />{formError}</p>}
            {!pendingPayload ? <button type="submit" className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground hover:-translate-y-0.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"><Coins aria-hidden="true" size={16} />Review transaction</button> : (
              <div className="rounded-xl border border-amber-600/25 bg-amber-500/5 p-4">
                <h3 className="text-sm font-semibold">Review before posting</h3>
                <p className="mt-2 break-words text-sm leading-6 text-muted-foreground">{mutationKind === 'balance' ? `${String(pendingPayload.type)} ${String(pendingPayload.amount)} credits for user ${String(pendingPayload.userId)}` : `Refund ${String(pendingPayload.amount)} credits from capture ${String(pendingPayload.captureId)} for user ${String(pendingPayload.userId)}`}. Reason: {String(pendingPayload.reason)}</p>
                <div className="mt-4 flex flex-wrap gap-3"><button type="button" onClick={() => setPendingPayload(null)} disabled={busy} className="inline-flex min-h-10 items-center rounded-xl border border-border bg-background px-4 text-sm font-medium hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">Edit details</button><button type="button" onClick={() => void applyMutation()} disabled={busy} className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground hover:-translate-y-0.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-60">{busy && <LoaderCircle aria-hidden="true" size={15} className="animate-spin" />}{busy ? 'Posting transaction' : 'Apply transaction'}</button></div>
              </div>
            )}
          </form>
          {result && <div role="status" className="mt-5 rounded-xl border border-emerald-700/25 bg-emerald-600/5 p-4"><p className="flex items-center gap-2 text-sm font-semibold"><CheckCircle2 aria-hidden="true" size={17} className="text-emerald-700 dark:text-emerald-300" />Transaction posted</p><p className="mt-2 text-sm leading-6 text-muted-foreground">{result.type.replace(/_/g, ' ').toLowerCase()} · {result.amount.toLocaleString()} credits · {result.status.toLowerCase()}</p><p className="mt-1 text-sm text-muted-foreground">Balance after: {result.balanceAfter.toLocaleString()} · Reserved after: {result.reservedAfter.toLocaleString()}</p><code className="mt-2 block break-all text-xs text-muted-foreground">{result.id}</code></div>}
        </section>
    </div>
  );
}

const inputClass = 'mt-1.5 min-h-11 w-full rounded-xl border border-input bg-background px-3.5 text-sm outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring';

function Field({ label, id, hint, children }: { label: string; id: string; hint?: string; children: React.ReactNode }) {
  return <div><label htmlFor={id} className="block text-sm font-medium">{label}</label>{children}{hint && <p className="mt-1 text-xs leading-5 text-muted-foreground">{hint}</p>}</div>;
}
