'use client';

import { useEffect, useRef } from 'react';
import type { Verdict, VerdictReason } from '@sightline/core';

const MODULE_LABEL: Record<VerdictReason['module'], string> = {
  colour: 'Colour',
  size: 'Size',
  identity: 'Same product',
  damage: 'Damage',
  quality: 'Photo quality',
};

const CONFIDENCE_WORD: Record<VerdictReason['confidence'], string> = {
  sure: 'Sure',
  fairly_sure: 'Fairly sure',
  not_sure: 'Not sure',
};

const KIND_LABEL: Record<Verdict['kind'], string> = {
  match: 'Matches your order',
  mismatch: 'Does not match your order',
  unsure: 'Not sure yet',
};

function Mark({ finding }: { finding: VerdictReason['finding'] }) {
  const glyph = finding === 'agree' ? '✓' : finding === 'disagree' ? '✕' : '?';
  const word = finding === 'agree' ? 'Matches' : finding === 'disagree' ? 'Different' : 'Unknown';
  return (
    <span className="verdict-mark" data-finding={finding}>
      <span aria-hidden="true">{glyph}</span>
      <span className="sr-only">{word}</span>
    </span>
  );
}

export function VerdictView({
  verdict,
  ordered,
  arrivedPhotoUrl,
  actions,
}: {
  verdict: Verdict;
  ordered: { title: string; imageUrl?: string; colour?: string; size?: string };
  arrivedPhotoUrl?: string;
  actions?: React.ReactNode;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, [verdict]);

  return (
    <section aria-labelledby="verdict-h" className="verdict" data-kind={verdict.kind}>
      <p className="verdict-kind">
        <span aria-hidden="true" className="verdict-kind-glyph">
          {verdict.kind === 'match' ? '✓' : verdict.kind === 'mismatch' ? '✕' : '?'}
        </span>
        {KIND_LABEL[verdict.kind]}
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
          {arrivedPhotoUrl && <img src={arrivedPhotoUrl} alt="What arrived, from your camera." />}
          <figcaption>
            <span className="verdict-cap">What arrived</span>
            <span>
              {verdict.reasons
                .filter((r) => r.observed && (r.module === 'colour' || r.module === 'size'))
                .map((r) => (r.module === 'size' ? `size ${r.observed}` : r.observed))
                .join(', ') || 'See the reasons below'}
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
              <td>{r.sentence}</td>
              <td>{CONFIDENCE_WORD[r.confidence]}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {verdict.nextSteps.length > 0 && (
        <div>
          <h3 className="text-[length:var(--step-1)]">What you can do</h3>
          <ul className="list-disc pl-6">
            {verdict.nextSteps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </div>
      )}
      {actions && <div className="flex flex-col sm:flex-row gap-3">{actions}</div>}
    </section>
  );
}
