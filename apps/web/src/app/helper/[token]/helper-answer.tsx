'use client';

import { useEffect, useRef, useState } from 'react';
import { useAnnouncer } from '@/components/a11y/announcer';

type Answer = 'matches' | 'different' | 'cant_tell';
const ANSWERS: [Answer, string, string][] = [
  ['matches', '✓', 'It matches'],
  ['different', '✕', 'It’s different'],
  ['cant_tell', '?', 'I can’t tell'],
];
const label = (a: Answer) => ANSWERS.find(([k]) => k === a)![2];

const sentLine = (name: string) => `Thank you. ${name} has your answer. You can close this page.`;
const alreadyLine = (name: string) => `${name} already has an answer from this link, and it can’t be changed. You can close this page.`;

/**
 * The helper's answer. A tap chooses an answer; nothing is sent until the helper checks it and
 * presses Send my answer, so a wrong tap is undone with Change my answer. No timer: the check step
 * waits as long as the helper needs.
 */
export function HelperAnswer({ token, answered, buyerName }: { token: string; answered: boolean; buyerName: string }) {
  const { announce } = useAnnouncer();
  const [done, setDone] = useState<'sent' | 'already' | null>(answered ? 'already' : null);
  const [chosen, setChosen] = useState<Answer | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const doneRef = useRef<HTMLParagraphElement>(null);
  const askRef = useRef<HTMLParagraphElement>(null);
  const answerRefs = useRef(new Map<Answer, HTMLButtonElement>());
  // The answer buttons are replaced by the thank-you line: focus moves there, not on page load.
  const justSent = useRef(false);
  // After "Change my answer", focus goes back to the answer that was chosen.
  const backTo = useRef<Answer | null>(null);

  useEffect(() => {
    if (!done || !justSent.current) return;
    justSent.current = false;
    doneRef.current?.focus();
  }, [done]);

  useEffect(() => {
    if (chosen) askRef.current?.focus();
    else if (backTo.current) {
      answerRefs.current.get(backTo.current)?.focus();
      backTo.current = null;
    }
  }, [chosen]);

  const fail = (msg: string) => {
    setError(msg);
    announce(msg, { politeness: 'assertive', source: 'helper' });
  };

  const choose = (answer: Answer) => {
    setError(null);
    setChosen(answer);
    // Focus moves to the question, which says the same thing: no live announcement on top of it.
    announce(`Send “${label(answer)}” to ${buyerName}? Nothing is sent yet.`, { source: 'helper', live: false });
  };

  const change = () => {
    backTo.current = chosen;
    setChosen(null);
    setError(null);
    announce('Not sent. Choose your answer again.', { source: 'helper' });
  };

  const send = async (answer: Answer) => {
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
      {chosen ? (
        <>
          <p ref={askRef} tabIndex={-1} className="font-bold text-[length:var(--step-1)]">
            Send “{label(chosen)}” to {buyerName}? Nothing is sent yet.
          </p>
          {note.trim() && <p className="max-w-[var(--measure)]">Your note: “{note.trim()}”</p>}
          <p className="max-w-[var(--measure)]">You can still change it. Once it’s sent, it can’t be changed.</p>
          {error && <p className="card-refusal">{error}</p>}
          <div className="helper-answers">
            <button type="button" className="btn btn-primary btn-xl" onClick={() => send(chosen)} aria-disabled={busy || undefined}>
              {busy ? 'Sending…' : 'Send my answer'}
            </button>
            <button type="button" className="btn btn-xl" onClick={change} aria-disabled={busy || undefined}>
              Change my answer
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="max-w-[var(--measure)]">
            Your answer goes straight to {buyerName}, with your note if you add one. You check it before it’s sent, and you can’t change it once it’s
            sent. {buyerName} decides what happens next; nothing about the payment changes.
          </p>
          {error && <p className="card-refusal">{error}</p>}
          <div className="field">
            <label htmlFor="note">Anything to add? Optional.</label>
            <textarea id="note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
          </div>
          {/* Three answers of equal weight, so the page never nudges toward one. */}
          <div className="helper-answers">
            {ANSWERS.map(([key, glyph, name]) => (
              <button
                key={key}
                type="button"
                className="btn btn-xl"
                ref={(el) => {
                  if (el) answerRefs.current.set(key, el);
                  else answerRefs.current.delete(key);
                }}
                onClick={() => choose(key)}
              >
                <span aria-hidden="true">{glyph}</span> {name}
              </button>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
