'use client';

import { useActionState, useEffect, useId, useRef, useState } from 'react';
import { useAnnouncer } from '@/components/a11y/announcer';
import { deleteDataAction, deletePhotosAction, type DeleteState } from './actions';

type Action = (prev: DeleteState, form: FormData) => Promise<DeleteState>;

/**
 * One delete control: a first press asks, a second press deletes. Focus moves to the question,
 * then to the result, and both are spoken through the announcer. The keep button puts focus back.
 */
function DeleteControl({
  action,
  label,
  question,
  confirmLabel,
  keepLabel,
}: {
  action: Action;
  label: string;
  question: string;
  confirmLabel: string;
  /** Says what is kept: "Keep my photos", "Keep everything". */
  keepLabel: string;
}) {
  const [state, run, pending] = useActionState<DeleteState, FormData>(action, null);
  const [asking, setAsking] = useState(false);
  const { announce } = useAnnouncer();
  const questionRef = useRef<HTMLParagraphElement>(null);
  const openRef = useRef<HTMLButtonElement>(null);
  const resultRef = useRef<HTMLParagraphElement>(null);
  const qid = useId();

  useEffect(() => {
    if (asking) questionRef.current?.focus();
  }, [asking]);

  useEffect(() => {
    if (!state) return;
    setAsking(false);
    // Focus goes to the result, which is read from focus, so it is not also sent live.
    announce(state.message, { politeness: state.ok ? 'polite' : 'assertive', source: 'settings', live: false });
    resultRef.current?.focus();
  }, [state, announce]);

  return (
    <div className="grid gap-3">
      {asking ? (
        <form action={run} role="group" aria-labelledby={qid} className="grid gap-3">
          <p id={qid} ref={questionRef} tabIndex={-1} className="font-bold">
            {question}
          </p>
          <div className="flex flex-wrap gap-3">
            <button type="submit" className="btn btn-danger" disabled={pending}>
              {pending ? 'Deleting…' : confirmLabel}
            </button>
            <button
              type="button"
              className="btn"
              disabled={pending}
              onClick={() => {
                setAsking(false);
                announce('Nothing was deleted.', { source: 'settings' });
                requestAnimationFrame(() => openRef.current?.focus());
              }}
            >
              {keepLabel}
            </button>
          </div>
        </form>
      ) : (
        <button type="button" ref={openRef} className="btn" onClick={() => setAsking(true)}>
          {label}
        </button>
      )}
      <p ref={resultRef} tabIndex={-1} className={state ? (state.ok ? 'mb-result' : 'card-refusal') : 'sr-only'}>
        {state?.message ?? ''}
      </p>
    </div>
  );
}

export function DataControls({ photoCount, neededByCase, retentionDays }: { photoCount: number; neededByCase: number; retentionDays: number }) {
  const deletable = photoCount - neededByCase;
  const photoWord = (n: number) => `${n} parcel photo${n === 1 ? '' : 's'}`;
  const kept = neededByCase ? ` ${photoWord(neededByCase)} stay${neededByCase === 1 ? 's' : ''} until your open money-back case is resolved.` : '';
  return (
    <section aria-labelledby="data-h" className="settings settings-box">
      <h2 id="data-h" className="settings-h">
        Your data
      </h2>
      <p className="hint">These buttons work on their own, straight away, and each asks before it deletes anything. Save settings doesn’t change them.</p>
      <p className="hint">
        Parcel photos are deleted on their own after {retentionDays} days, unless a money-back case still needs them. Location data is removed from every photo before
        it is stored. You have {photoWord(photoCount)} stored now.
      </p>
      {deletable > 0 ? (
        <DeleteControl
          action={deletePhotosAction}
          label="Delete my photos"
          question={`Delete ${photoWord(deletable)}? This can't be undone. Any helper links to them stop working.${kept}`}
          confirmLabel="Yes, delete my photos"
          keepLabel="Keep my photos"
        />
      ) : (
        <p>No photos to delete right now.{kept}</p>
      )}
      <DeleteControl
        action={deleteDataAction}
        label="Delete everything"
        question={`Delete your conversations, saved sizes and colours, what I remember about you, helper contact, notifications and photos? This can't be undone. Orders, payments and receipts are kept, because refunds need them.${kept}`}
        confirmLabel="Yes, delete everything"
        keepLabel="Keep everything"
      />
    </section>
  );
}
