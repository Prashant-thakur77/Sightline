'use client';

import { useEffect, useRef, useState } from 'react';
import { useAnnouncer } from '@/components/a11y/announcer';

export function HelperAnswer({ token, answered, buyerName }: { token: string; answered: boolean; buyerName: string }) {
  const { announce } = useAnnouncer();
  const [done, setDone] = useState(answered);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const doneRef = useRef<HTMLParagraphElement>(null);
  // The answer buttons are replaced by the thank-you line: focus moves there, not on page load.
  const justSent = useRef(false);

  useEffect(() => {
    if (!done || !justSent.current) return;
    justSent.current = false;
    doneRef.current?.focus();
  }, [done]);

  const fail = (msg: string) => {
    setError(msg);
    announce(msg, { politeness: 'assertive', source: 'helper' });
  };

  const send = async (answer: 'matches' | 'different' | 'cant_tell') => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/helper/${encodeURIComponent(token)}/answer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ answer, note }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        fail(data.error ?? 'Something went wrong. Your answer was not sent. Try again.');
        return;
      }
      justSent.current = true;
      setDone(true);
      // Focus moves to the thank-you line, which says the same thing: no live announcement on top of it.
      announce(`Thank you. ${buyerName} has your answer.`, { source: 'helper', live: false });
    } catch {
      fail('Could not reach the server. Nothing changed. Try again.');
    } finally {
      setBusy(false);
    }
  };

  if (done)
    return (
      <p ref={doneRef} tabIndex={-1} className="mb-result">
        Thank you. {buyerName} has your answer. You can close this page.
      </p>
    );

  return (
    <section aria-labelledby="ans-h" className="grid gap-4">
      <h2 id="ans-h" className="text-[length:var(--step-2)]">
        Your answer
      </h2>
      {error && <p className="card-refusal">{error}</p>}
      <div className="field">
        <label htmlFor="note">Anything to add? Optional.</label>
        <textarea id="note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <button type="button" className="btn btn-primary btn-xl" onClick={() => send('matches')} aria-disabled={busy || undefined}>
          <span aria-hidden="true">✓</span> It matches
        </button>
        <button type="button" className="btn btn-xl" onClick={() => send('different')} aria-disabled={busy || undefined}>
          <span aria-hidden="true">✕</span> It’s different
        </button>
        <button type="button" className="btn btn-xl" onClick={() => send('cant_tell')} aria-disabled={busy || undefined}>
          <span aria-hidden="true">?</span> I can’t tell
        </button>
      </div>
    </section>
  );
}
