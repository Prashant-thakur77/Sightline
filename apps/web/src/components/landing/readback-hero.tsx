'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useAnnouncer } from '@/components/a11y/announcer';

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
  ['Store is paid', 'After your check'],
  ['Arrives', 'Tuesday 17 November'],
  ['Returns', 'Free for 30 days'],
];

const CELLS = 14;

const NO_VOICE = "This browser couldn't read it aloud. The same words are written in this example.";

/** Speech synthesis is a browser feature: off on the server, checked once in the browser. */
const noSubscribe = () => () => {};
const browserCanSpeak = () => 'speechSynthesis' in window && typeof window.SpeechSynthesisUtterance === 'function';
const serverCanSpeak = () => false;

/**
 * The signature moment: speech becomes a ticket. The animated layer is hidden from assistive
 * technology; the same content is present as plain text in the figure caption.
 */
export function ReadbackHero() {
  const [run, setRun] = useState(0);
  const [speaking, setSpeaking] = useState(false);
  // Hidden where the browser has no speech; replaced by a plain note if speaking fails.
  const canSpeak = useSyncExternalStore(noSubscribe, browserCanSpeak, serverCanSpeak);
  const [failed, setFailed] = useState(false);
  const { announce } = useAnnouncer();
  const hearRef = useRef<HTMLButtonElement>(null);
  const noteRef = useRef<HTMLSpanElement>(null);
  const focusNote = useRef(false);
  const startTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (startTimer.current) clearTimeout(startTimer.current);
  }, []);

  useEffect(() => {
    if (failed && focusNote.current) {
      focusNote.current = false;
      noteRef.current?.focus();
    }
  }, [failed]);

  const fail = () => {
    if (startTimer.current) clearTimeout(startTimer.current);
    window.speechSynthesis.cancel();
    setSpeaking(false);
    // The button goes away; if it had focus, focus moves to the note that replaces it, which is
    // read from focus, so it is not also sent to a live region.
    focusNote.current = document.activeElement === hearRef.current;
    setFailed(true);
    announce(NO_VOICE, { source: 'example', live: !focusNote.current });
  };

  const hear = () => {
    if (!canSpeak) return;
    if (speaking) {
      if (startTimer.current) clearTimeout(startTimer.current);
      window.speechSynthesis.cancel();
      setSpeaking(false);
      return;
    }
    setRun((r) => r + 1);
    const said = new SpeechSynthesisUtterance('I need a navy crew-neck sweater, medium, under forty dollars.');
    const readback = new SpeechSynthesisUtterance(
      "Here's what you're buying. Harbor knit crew-neck sweater. Colour: navy. Size: M. Sold by Demo Store. Total $36.72 with tax. PayPal holds the money, and Demo Store is paid after you check the parcel. Arrives Tuesday 17 November. Free returns within 30 days. To pay, say confirm purchase.",
    );
    said.rate = 1;
    readback.rate = 1.05;
    const started = () => {
      if (startTimer.current) clearTimeout(startTimer.current);
    };
    const errored = (e: SpeechSynthesisErrorEvent) => {
      // Stopping on purpose is not a failure.
      if (e.error === 'interrupted' || e.error === 'canceled') return setSpeaking(false);
      fail();
    };
    said.onstart = started;
    said.onerror = errored;
    readback.onend = () => setSpeaking(false);
    readback.onerror = errored;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(said);
    window.speechSynthesis.speak(readback);
    setSpeaking(true);
    // Some browsers have the feature but no voice installed, and then stay silent without an error.
    startTimer.current = setTimeout(fail, 4000);
  };
  let tagIndex = 0;
  return (
    <figure className="rbh" aria-label="Example: what you say, and the readback you hear before paying">
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
      <figcaption className="rbh-cap">
        <span className="sr-only">
          Example. You say: I need a navy crew-neck sweater, medium, under forty dollars. Before anything is paid, {''}
          the app reads back: Harbor knit crew-neck sweater. Colour navy. Size M. Seller Demo Store. Total $36.72 with tax. PayPal holds the money, and Demo Store is paid after you check the
          parcel. Arrives Tuesday 17 November. Free returns for 30 days. To pay, say confirm purchase.
        </span>
        <span className="rbh-buttons">
          {canSpeak && !failed && (
            // One pattern: the name says what pressing does now ("Hear it" or "Stop"), so it is not also a toggle button.
            <button ref={hearRef} type="button" className="btn rbh-hear" onClick={hear}>
              <span aria-hidden="true">{speaking ? '■' : '▶'}</span> {speaking ? 'Stop' : 'Hear it'}
            </button>
          )}
          {failed && (
            <span ref={noteRef} tabIndex={-1} className="rbh-note">
              {NO_VOICE}
            </span>
          )}
          <button type="button" className="btn btn-quiet rbh-replay" onClick={() => setRun((r) => r + 1)}>
            Replay the animation
          </button>
        </span>
      </figcaption>
    </figure>
  );
}
