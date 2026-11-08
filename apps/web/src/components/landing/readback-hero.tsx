'use client';

import { useState } from 'react';

const SENTENCE: (string | { word: string; tag: string })[] = [
  'I need a ',
  { word: 'navy', tag: 'colour: navy' },
  ' ',
  { word: 'crew-neck sweater', tag: 'crew neck' },
  ', ',
  { word: 'medium', tag: 'size M' },
  ', ',
  { word: 'under forty dollars', tag: 'under $40' },
  '.',
];

const LINES: [string, string][] = [
  ['Item', 'Harbor knit crew-neck sweater'],
  ['Colour', 'Navy'],
  ['Size', 'M'],
  ['Seller', 'Demo Store'],
  ['Total', '$36.72 with tax'],
  ['Arrives', 'Tuesday 17 November'],
  ['Returns', 'Free for 30 days'],
];

const CELLS = 14;

/**
 * The signature moment: speech becomes a ticket. The animated layer is hidden from assistive
 * technology; the same content is present as plain text in the figure caption.
 */
export function ReadbackHero() {
  const [run, setRun] = useState(0);
  let tagIndex = 0;
  return (
    <figure className="rbh" aria-labelledby="rbh-cap">
      <div className="rbh-stage" key={run} aria-hidden="true">
        <p className="rbh-said">
          <span className="rbh-who">You say</span>
          <span className="rbh-sentence">
            {SENTENCE.map((p, i) =>
              typeof p === 'string' ? (
                <span key={i}>{p}</span>
              ) : (
                <span key={i} className="rbh-tagged" style={{ ['--i' as string]: tagIndex++ }}>
                  {p.word}
                </span>
              ),
            )}
          </span>
          <span className="rbh-tags">
            {SENTENCE.filter((p): p is { word: string; tag: string } => typeof p !== 'string').map((p, i) => (
              <span key={p.tag} className="rbh-tag" style={{ ['--i' as string]: i }}>
                {p.tag}
              </span>
            ))}
          </span>
        </p>
        <div className="rbh-head">
          {Array.from({ length: CELLS }, (_, i) => (
            <span key={i} className="rbh-cell" style={{ ['--c' as string]: i }}>
              {[0, 1, 2, 3, 4, 5].map((d) => (
                <span key={d} data-on={(i * 7 + d * 3) % 5 < 2 ? '' : undefined} />
              ))}
            </span>
          ))}
        </div>
        <div className="rbh-ticket">
          <p className="rbh-ticket-h">
            <span>Readback</span>
            <span>Before you pay</span>
          </p>
          <ol>
            {LINES.map(([k, v], i) => (
              <li key={k} style={{ ['--l' as string]: i }} data-key={k.toLowerCase()}>
                <span className="rbh-num">{String(i + 1).padStart(2, '0')}</span>
                <span className="rbh-k">{k}</span>
                <span className="rbh-v">{v}</span>
              </li>
            ))}
          </ol>
          <p className="rbh-say">
            To pay, say <strong>“confirm purchase”</strong>.
          </p>
          <div className="rbh-stub">
            <span>KEEP</span>
            <span>This is your proof</span>
          </div>
        </div>
      </div>
      <figcaption id="rbh-cap" className="rbh-cap">
        <span className="sr-only">
          Example. You say: I need a navy crew-neck sweater, medium, under forty dollars. Before anything is paid, {''}
          the app reads back: Harbor knit crew-neck sweater. Colour navy. Size M. Seller Demo Store. Total $36.72 with tax. Arrives Tuesday 17
          November. Free returns for 30 days. To pay, say confirm purchase.
        </span>
        <button type="button" className="btn btn-quiet rbh-replay" onClick={() => setRun((r) => r + 1)}>
          Play the readback again
        </button>
      </figcaption>
    </figure>
  );
}
