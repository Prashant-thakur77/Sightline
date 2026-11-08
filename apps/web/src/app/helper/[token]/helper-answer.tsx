'use client';

import { useRef, useState } from 'react';
import { useAnnouncer } from '@/components/a11y/announcer';

export function HelperAnswer({ token, answered, buyerName }: { token: string; answered: boolean; buyerName: string }) {
  const { announce } = useAnnouncer();
  const [done, setDone] = useState(answered);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const doneRef = useRef<HTMLParagraphElement>(null);

  const send = async (answer: 'matches' | 'different' | 'cant_tell') => {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/helper/${encodeURIComponent(token)}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answer, note }),
    });
    const data = (await res.json()) as { error?: string };
    setBusy(false);
    if (!res.ok) {
      setError(data.error ?? 'Something went wrong.');
      return;
    }
    setDone(true);
    announce(`Thank you. ${buyerName} has your answer.`, { source: 'helper' });
    requestAnimationFrame(() => doneRef.current?.focus());
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
      {error && (
        <p role="alert" className="card-refusal">
          {error}
        </p>
      )}
      <div className="field">
        <label htmlFor="note">Anything to add? Optional.</label>
        <textarea id="note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <button type="button" className="btn btn-primary btn-xl" onClick={() => send('matches')} disabled={busy}>
          ✓ It matches
        </button>
        <button type="button" className="btn btn-xl" onClick={() => send('different')} disabled={busy}>
          ✕ It’s different
        </button>
        <button type="button" className="btn btn-xl" onClick={() => send('cant_tell')} disabled={busy}>
          ? I can’t tell
        </button>
      </div>
    </section>
  );
}
