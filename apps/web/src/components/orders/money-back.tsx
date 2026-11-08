'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import { useAnnouncer } from '@/components/a11y/announcer';
import { cue } from '@/lib/feedback';

interface Preview {
  caseId: string;
  evidencePackId: string;
  summary: string;
  path: 'void' | 'refund-request';
  amount: string;
}

/** Two steps: build and hear the evidence summary, then confirm before anything is sent. */
export function MoneyBack({ orderId, canStart, done }: { orderId: string; canStart: boolean; done?: string | null }) {
  const { announce } = useAnnouncer();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<string | null>(done ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const headRef = useRef<HTMLHeadingElement>(null);

  const prepare = async () => {
    setBusy(true);
    setError(null);
    announce('Building the evidence. Nothing is sent yet.', { source: 'money back' });
    try {
      const res = await fetch(`/api/orders/${orderId}/money-back`, { method: 'POST' });
      const data = (await res.json()) as Preview & { error?: string };
      if (!res.ok) throw new Error(data.error);
      setPreview(data);
      cue('attention');
      announce(
        `${data.summary} ${data.path === 'void' ? `To cancel the payment hold of ${data.amount}, press Send it.` : 'To send this to Demo Store, press Send it.'}`,
        { source: 'money back' },
      );
      requestAnimationFrame(() => headRef.current?.focus());
    } catch (e) {
      setError((e as Error).message || 'Something went wrong. Nothing was sent.');
      cue('error');
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/cases/${preview.caseId}/send`, { method: 'POST' });
      const data = (await res.json()) as { say?: string; error?: string };
      if (!res.ok) throw new Error(data.error);
      setResult(data.say ?? 'Sent.');
      cue('paid');
      announce(data.say ?? 'Sent.', { politeness: 'assertive', source: 'money back' });
    } catch (e) {
      const msg = (e as Error).message || 'Something went wrong. Nothing was sent.';
      setError(msg);
      cue('error');
      announce(msg, { politeness: 'assertive', source: 'money back' });
    } finally {
      setBusy(false);
    }
  };

  if (result)
    return (
      <p className="mb-result" role="status">
        {result}
      </p>
    );

  return (
    <div className="grid gap-4">
      {error && (
        <p className="card-refusal" role="alert">
          {error}
        </p>
      )}
      {!preview ? (
        <div className="grid gap-3">
          <p>I build a signed evidence pack first: your order, the readback you heard, the listing as it was, your photos and the check. Nothing is sent until you say so.</p>
          <button type="button" className="btn btn-primary btn-xl" onClick={prepare} disabled={!canStart || busy}>
            {busy ? 'Building the evidence…' : 'Get my money back'}
          </button>
        </div>
      ) : (
        <div className="grid gap-4">
          <h3 ref={headRef} tabIndex={-1} className="text-[length:var(--step-2)]">
            Before I send it
          </h3>
          <p className="text-[length:var(--step-1)]">{preview.summary}</p>
          <p>
            <Link href={`/evidence/${preview.evidencePackId}`}>Read the evidence pack</Link>
          </p>
          <div className="flex flex-col sm:flex-row gap-3">
            <button type="button" className="btn btn-primary btn-xl" onClick={send} disabled={busy}>
              {busy ? 'Sending…' : preview.path === 'void' ? `Send it: cancel the ${preview.amount} hold` : 'Send it to Demo Store'}
            </button>
            <button
              type="button"
              className="btn btn-xl"
              onClick={() => {
                setPreview(null);
                announce('Not sent.', { source: 'money back' });
              }}
              disabled={busy}
            >
              Not now
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
