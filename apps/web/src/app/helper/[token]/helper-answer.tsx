'use client';

import { useEffect, useRef, useState } from 'react';
import { useAnnouncer } from '@/components/a11y/announcer';

const sentLine = (name: string) => `Thank you. ${name} has your answer. You can close this page.`;
const alreadyLine = (name: string) => `${name} already has an answer from this link, and it can’t be changed. You can close this page.`;

export function HelperAnswer({ token, answered, buyerName }: { token: string; answered: boolean; buyerName: string }) {
  const { announce } = useAnnouncer();
  const [done, setDone] = useState<'sent' | 'already' | null>(answered ? 'already' : null);
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
      const data = (await res.json().catch(() => ({}))) as { error?: string; already?: boolean };
      if (!res.ok) {
        fail(data.error ?? 'Something went wrong. Your answer was not sent. Try again.');
        return;
      }
      justSent.current = true;
      // An answer sent earlier (another tab, a double tap) stands; this one was not recorded.
      setDone(data.already ? 'already' : 'sent');
      // Focus moves to the thank-you line, which says the same thing: no live announcement on top of it.
      announce(data.already ? alreadyLine(buyerName) : `Thank you. ${buyerName} has your answer.`, { source: 'helper', live: false });
    } catch {
      fail('Could not reach the server. Nothing changed. Try again.');
    } finally {
      setBusy(false);
    }
  };

  if (done)
    return (
      <p ref={doneRef} tabIndex={-1} className="mb-result">
        {done === 'already' ? alreadyLine(buyerName) : sentLine(buyerName)}
      </p>
    );

  return (
    <section aria-labelledby="ans-h" className="grid gap-4">
      <h2 id="ans-h" className="text-[length:var(--step-2)]">
        Your answer
      </h2>
      <p className="max-w-[var(--measure)]">
        Your answer goes straight to {buyerName}, with your note if you add one. You can’t change it once it’s sent. {buyerName} decides what
        happens next; nothing about the payment changes.
      </p>
      {error && <p className="card-refusal">{error}</p>}
      <div className="field">
        <label htmlFor="note">Anything to add? Optional.</label>
        <textarea id="note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
      </div>
      {/* Three answers of equal weight, so the page never nudges toward one. */}
      <div className="helper-answers">
        <button type="button" className="btn btn-xl" onClick={() => send('matches')} aria-disabled={busy || undefined}>
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
