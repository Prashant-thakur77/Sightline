'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
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
  const startRef = useRef<HTMLButtonElement>(null);
  const resultRef = useRef<HTMLParagraphElement>(null);
  // Where focus goes once the control that had it is replaced.
  const focusNext = useRef<'preview' | 'start' | 'result' | null>(null);

  useEffect(() => {
    const next = focusNext.current;
    if (next === 'preview' && preview) headRef.current?.focus();
    else if (next === 'start' && !preview) startRef.current?.focus();
    else if (next === 'result' && result) resultRef.current?.focus();
    else return;
    focusNext.current = null;
  }, [preview, result]);

  const fail = (e: unknown) => {
    // A server refusal carries its own words; a network failure or an unreadable reply does not.
    const msg =
      e instanceof TypeError
        ? 'Could not reach the server. Nothing was sent. Try again.'
        : e instanceof Error && e.name === 'Error' && e.message
          ? e.message
          : 'Something went wrong. Nothing was sent. Try again.';
    setError(msg);
    cue('error');
    announce(msg, { politeness: 'assertive', source: 'money back' });
  };

  const prepare = async () => {
    if (!canStart || busy) return;
    setBusy(true);
    setError(null);
    announce('Building the evidence. Nothing is sent yet.', { source: 'money back' });
    try {
      const res = await fetch(`/api/orders/${orderId}/money-back`, { method: 'POST' });
      const data = (await res.json()) as Preview & { error?: string };
      if (!res.ok) throw new Error(data.error);
      focusNext.current = 'preview';
      setPreview(data);
      cue('attention');
      announce(
        `${data.summary} ${data.path === 'void' ? `To cancel the payment hold of ${data.amount}, press Send it.` : 'To send this to Demo Store, press Send it.'}`,
        { source: 'money back' },
      );
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    if (!preview || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/cases/${preview.caseId}/send`, { method: 'POST' });
      const data = (await res.json()) as { say?: string; error?: string };
      if (!res.ok) throw new Error(data.error);
      const said = data.say ?? 'Sent.';
      focusNext.current = 'result';
      setResult(said);
      cue('paid');
      // Focus moves to the result, which says the same thing: no live announcement on top of it.
      announce(said, { politeness: 'assertive', source: 'money back', live: false });
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  if (result)
    return (
      <p ref={resultRef} tabIndex={-1} className="mb-result">
        {result}
      </p>
    );

  return (
    <div className="grid gap-4">
      {error && <p className="card-refusal">{error}</p>}
      {!preview ? (
        <div className="grid gap-3">
          <p>I build a signed evidence pack first: your order, the readback you heard, the listing as it was, your photos and the check. Nothing is sent until you say so.</p>
          <button
            ref={startRef}
            type="button"
            className="btn btn-primary btn-xl"
            onClick={prepare}
            aria-disabled={!canStart || busy || undefined}
          >
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
            <Link className="link-target" href={`/evidence/${preview.evidencePackId}`}>
              Read the evidence pack
            </Link>
          </p>
          <div className="flex flex-col sm:flex-row gap-3">
            <button type="button" className="btn btn-primary btn-xl" onClick={send} aria-disabled={busy || undefined}>
              {busy ? 'Sending…' : preview.path === 'void' ? `Send it: cancel the ${preview.amount} hold` : 'Send it to Demo Store'}
            </button>
            <button
              type="button"
              className="btn btn-xl"
              onClick={() => {
                if (busy) return;
                focusNext.current = 'start';
                setPreview(null);
                announce('Not sent.', { source: 'money back' });
              }}
              aria-disabled={busy || undefined}
            >
              Not now
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
