'use client';

import { useEffect, useRef } from 'react';
import { CONFIDENCE_WORD, FINDING, MODULE_LABEL, verdictStatus, type Verdict, type VerdictReason } from '@sightline/core';

function Mark({ finding }: { finding: VerdictReason['finding'] }) {
  return (
    <span className="verdict-result">
      <span className="verdict-mark" data-finding={finding} aria-hidden="true">
        {FINDING[finding].glyph}
      </span>
      <span className="verdict-word">{FINDING[finding].word}</span>
    </span>
  );
}

/** Where the photo of what arrived came from, as recorded when it was sent. */
export type PhotoSource = 'camera' | 'upload' | 'demo';

const ARRIVED_ALT: Record<PhotoSource | 'unknown', string> = {
  camera: 'What arrived, from your camera.',
  upload: 'What arrived, from the photo you added.',
  demo: 'What arrived, from the demo parcel photos (not your camera).',
  unknown: 'What arrived, in the photo that was checked.',
};

/**
 * The reason without its own "how sure" clause, for the table, whose How sure column already says
 * it in a word. What made it less sure (dim light, a tint, glare) stays as a plain fact.
 */
export function withoutConfidence(sentence: string): string {
  return sentence
    .replace(/,? but (the light is \w+|there['’]s glare on it) so I['’]m less sure\./i, (_m, why: string) => `. ${why.charAt(0).toUpperCase()}${why.slice(1)}.`)
    .replace(/,? but I['’]m only fairly sure from one photo\./i, '. Seen in one photo so far.')
    .replace(/,? but I['’]m (only fairly|not) sure\./i, '.')
    .replace(/\.? I['’]m (fairly )?sure( about that)?\./i, '.')
    .trim();
}

/** The check's generic "ask a helper" steps, with the buyer's own helper named when they have one. */
export function namedSteps(steps: string[], helperName: string | null | undefined): string[] {
  if (!helperName) return steps;
  return steps.map((s) => s.replace(/\b(A|a)sk a helper\b/g, (_m, a: string) => `${a}sk ${helperName}`));
}

export function VerdictView({
  verdict,
  ordered,
  arrivedPhotoUrl,
  arrivedPhotoSource,
  actions,
  note,
  helperName,
  focusOnMount = true,
  settled = false,
  closed = false,
}: {
  verdict: Verdict;
  ordered: { title: string; imageUrl?: string; colour?: string; size?: string };
  arrivedPhotoUrl?: string;
  arrivedPhotoSource?: PhotoSource;
  actions?: React.ReactNode;
  /** Shown just before the actions, e.g. what the helper answered. */
  note?: React.ReactNode;
  /** The buyer's helper, named in the steps instead of "a helper". */
  helperName?: string | null;
  focusOnMount?: boolean;
  /** The helper has answered or a money-back case exists: steps that suggest those are dropped. */
  settled?: boolean;
  /** The money-back case is closed: no steps are suggested any more. */
  closed?: boolean;
}) {
  // Once the helper answered or a case exists, "ask a helper" and "get your money back" are done.
  const steps = closed ? [] : namedSteps(verdict.nextSteps, helperName).filter((t) => !settled || !/\b(ask|money back|refund)\b/i.test(t));
  const headingRef = useRef<HTMLHeadingElement>(null);
  // Focus moves to a new verdict, not to one that was already there when the page loaded. Comparing
  // against the first verdict (not a "first run" flag) stays right when Strict Mode runs this twice.
  const initial = useRef(focusOnMount ? null : verdict);
  useEffect(() => {
    if (verdict !== initial.current) headingRef.current?.focus();
  }, [verdict]);

  return (
    // A short name for the region; the headline is the heading inside it, so it isn't read twice.
    <section aria-label="Check result" className="verdict" data-kind={verdict.kind}>
      <p className="verdict-kind">
        <span aria-hidden="true" className="verdict-kind-glyph">
          {verdictStatus(verdict.kind).glyph}
        </span>
        {verdictStatus(verdict.kind).word}
      </p>
      <h2 id="verdict-h" ref={headingRef} tabIndex={-1} className="verdict-headline">
        {verdict.headline}
      </h2>

      <div className="verdict-compare">
        <figure>
          {ordered.imageUrl && (
            <img src={ordered.imageUrl} alt={`The ${ordered.title} as listed when you bought it.`} />
          )}
          <figcaption>
            <span className="verdict-cap">You ordered</span>
            <span>{ordered.title}</span>
            <span>
              {[ordered.colour, ordered.size && `size ${ordered.size}`].filter(Boolean).join(', ') || 'Details not listed'}
            </span>
          </figcaption>
        </figure>
        <figure>
          {arrivedPhotoUrl && <img src={arrivedPhotoUrl} alt={ARRIVED_ALT[arrivedPhotoSource ?? 'unknown']} />}
          <figcaption>
            <span className="verdict-cap">What arrived</span>
            <span>
              {verdict.reasons
                .filter((r) => r.observed && (r.module === 'colour' || r.module === 'size'))
                .map((r) => (r.module === 'size' ? `size ${r.observed}` : r.observed))
                .join(', ') || 'No colour or size read from the photo'}
            </span>
          </figcaption>
        </figure>
      </div>

      <table className="verdict-table">
        <caption className="sr-only">What I checked and how sure I am</caption>
        <thead>
          <tr>
            <th scope="col">Check</th>
            <th scope="col">Result</th>
            <th scope="col">What I found</th>
            <th scope="col">How sure</th>
          </tr>
        </thead>
        <tbody>
          {verdict.reasons.map((r, i) => (
            <tr key={`${r.module}-${i}`} data-finding={r.finding}>
              <th scope="row">{MODULE_LABEL[r.module]}</th>
              <td>
                <Mark finding={r.finding} />
              </td>
              <td>{withoutConfidence(r.sentence)}</td>
              <td>{CONFIDENCE_WORD[r.confidence]}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {steps.length > 0 && (
        <div>
          <h3 className="text-[length:var(--step-1)]">What you can do</h3>
          <ul className="list-disc pl-6">
            {steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </div>
      )}
      {note}
      {actions && <div className="btn-row">{actions}</div>}
    </section>
  );
}
