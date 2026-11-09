'use client';

import { useActionState, useCallback, useEffect, useId, useRef, useState } from 'react';
import { useAnnouncer } from '@/components/a11y/announcer';
import { forgetAllMemoriesAction, forgetMemoryAction, updateMemoryAction, type MemoryState } from './actions';

/** One remembered preference, as the page shows it. */
export interface MemoryView {
  id: string;
  /** "You're a medium in sweaters." */
  sentence: string;
  /** The buyer's own words it came from. */
  said: string;
  /** "Monday 9 November". */
  when: string;
  /** The value to edit, and what to call the field. */
  value: string;
  field: string;
}

/**
 * "What I remember": every preference the conversation remembered, with what the buyer said, to
 * change or forget one at a time, or all at once (which asks first). Results are read from focus:
 * focus moves to the result line, and the announcer is told not to write it to a live region too.
 */
export function MemoryControls({ memories }: { memories: MemoryView[] }) {
  const { announce } = useAnnouncer();
  const [result, setResult] = useState<MemoryState>(null);
  const resultRef = useRef<HTMLParagraphElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [forgot, forgetOne, forgetting] = useActionState<MemoryState, FormData>(forgetMemoryAction, null);
  const [forgotAll, forgetAll, forgettingAll] = useActionState<MemoryState, FormData>(forgetAllMemoriesAction, null);
  const [asking, setAsking] = useState(false);
  const askRef = useRef<HTMLParagraphElement>(null);
  const openAllRef = useRef<HTMLButtonElement>(null);
  const qid = useId();

  // Focus moves to the result after it is drawn (and after a closed edit form is gone).
  const [shown, setShown] = useState(0);
  const report = useCallback(
    (s: NonNullable<MemoryState>) => {
      setResult(s);
      setShown((n) => n + 1);
      announce(s.message, { politeness: s.ok ? 'polite' : 'assertive', source: 'settings', live: false });
    },
    [announce],
  );
  useEffect(() => {
    if (shown) resultRef.current?.focus();
  }, [shown]);

  // Forgetting is decided here, not in the item: the item is gone from the list once it's forgotten.
  useEffect(() => {
    if (forgot) report(forgot);
  }, [forgot, report]);
  useEffect(() => {
    if (!forgotAll) return;
    setAsking(false);
    report(forgotAll);
  }, [forgotAll, report]);
  useEffect(() => {
    if (asking) askRef.current?.focus();
  }, [asking]);
  // Opened from the conversation's "Change what I remember" link: start at this section.
  useEffect(() => {
    if (window.location.hash === '#memory-h') headingRef.current?.focus();
  }, []);

  return (
    <section aria-labelledby="memory-h" className="settings settings-box">
      <h2 id="memory-h" ref={headingRef} tabIndex={-1} className="settings-h">
        What I remember
      </h2>
      <p className="hint">
        Things you asked me to remember when we talked. I use them when I search for you, and I say when I do. They are never sent to a store.
      </p>
      {memories.length === 0 ? (
        <p>Nothing yet. When you tell me your size, or something you avoid, I ask before I remember it.</p>
      ) : (
        <ul className="grid gap-5">
          {memories.map((m) => (
            <MemoryItem key={m.id} m={m} onChanged={report} forgetAction={forgetOne} forgetting={forgetting} />
          ))}
        </ul>
      )}
      <p ref={resultRef} tabIndex={-1} className={result ? (result.ok ? 'mb-result' : 'card-refusal') : 'sr-only'}>
        {result?.message ?? ''}
      </p>
      {memories.length > 1 &&
        (asking ? (
          <form action={forgetAll} role="group" aria-labelledby={qid} className="grid gap-3">
            <p id={qid} ref={askRef} tabIndex={-1} className="font-bold">
              Forget all {memories.length} things I remember? You can tell me again any time.
            </p>
            <div className="flex flex-wrap gap-3">
              <button type="submit" className="btn btn-danger" disabled={forgettingAll}>
                {forgettingAll ? 'Forgetting…' : 'Yes, forget them all'}
              </button>
              <button
                type="button"
                className="btn"
                disabled={forgettingAll}
                onClick={() => {
                  setAsking(false);
                  announce('Nothing was forgotten.', { source: 'settings' });
                  requestAnimationFrame(() => openAllRef.current?.focus());
                }}
              >
                Keep them
              </button>
            </div>
          </form>
        ) : (
          <button type="button" ref={openAllRef} className="btn" onClick={() => setAsking(true)}>
            Forget everything I remember
          </button>
        ))}
    </section>
  );
}

function MemoryItem({
  m,
  onChanged,
  forgetAction,
  forgetting,
}: {
  m: MemoryView;
  onChanged: (s: NonNullable<MemoryState>) => void;
  forgetAction: (form: FormData) => void;
  forgetting: boolean;
}) {
  const { announce } = useAnnouncer();
  const [editing, setEditing] = useState(false);
  const [saved, save, saving] = useActionState<MemoryState, FormData>(updateMemoryAction, null);
  const inputRef = useRef<HTMLInputElement>(null);
  const changeRef = useRef<HTMLButtonElement>(null);
  const id = useId();
  const bad = Boolean(saved && !saved.ok && editing);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);
  // Only a new answer from the server acts; a re-render with the same answer does nothing.
  const latest = useRef({ onChanged, announce });
  latest.current = { onChanged, announce };
  useEffect(() => {
    if (!saved) return;
    if (saved.ok) {
      setEditing(false);
      latest.current.onChanged(saved);
    } else {
      // The field to fix keeps focus and says what it takes.
      latest.current.announce(saved.message, { politeness: 'assertive', source: 'settings', live: false });
      inputRef.current?.focus();
    }
  }, [saved]);

  return (
    <li className="grid gap-2">
      <p id={`${id}-s`} className="font-bold">
        {m.sentence}
      </p>
      <p className="hint">
        You said: “{m.said}”, on {m.when}.
      </p>
      {editing ? (
        <form action={save} className="grid gap-3">
          <input type="hidden" name="id" value={m.id} />
          <label htmlFor={`${id}-v`}>{m.field}</label>
          <input
            id={`${id}-v`}
            ref={inputRef}
            name="value"
            defaultValue={m.value}
            autoComplete="off"
            aria-invalid={bad || undefined}
            aria-describedby={bad ? `${id}-err` : undefined}
          />
          {bad && (
            <p id={`${id}-err`} className="field-error">
              <span aria-hidden="true">✕ </span>
              {saved!.message}
            </p>
          )}
          <div className="flex flex-wrap gap-3">
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              className="btn"
              disabled={saving}
              onClick={() => {
                setEditing(false);
                announce('Nothing changed.', { source: 'settings' });
                requestAnimationFrame(() => changeRef.current?.focus());
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-3">
          <button type="button" ref={changeRef} className="btn" onClick={() => setEditing(true)} aria-describedby={`${id}-s`}>
            Change
          </button>
          <form action={forgetAction}>
            <input type="hidden" name="id" value={m.id} />
            <button type="submit" className="btn" disabled={forgetting} aria-describedby={`${id}-s`}>
              Forget
            </button>
          </form>
        </div>
      )}
    </li>
  );
}
