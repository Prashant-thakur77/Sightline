'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

type Line = { id: number; text: string; kind: 'focus' | 'live' | 'read' };

type Virtual = {
  start: (o: { container: Element; displayCursor?: boolean }) => Promise<void>;
  stop: () => Promise<void>;
  next: () => Promise<void>;
  spokenPhraseLog: () => Promise<string[]>;
  lastSpokenPhrase: () => Promise<string>;
  clearSpokenPhraseLog: () => Promise<void>;
};

const STORAGE_KEY = 'sl-speech-viewer';

/**
 * Shows sighted people, word for word, what a screen reader says on this page: every focus
 * change and every live announcement, plus a "read this page" walk-through. It runs a virtual
 * screen reader over the app root; the transcript itself is hidden from assistive technology so
 * real screen-reader users never hear things twice.
 */
export function SpeechViewer({ rootId = 'app-root', defaultOpen = false }: { rootId?: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [lines, setLines] = useState<Line[]>([]);
  const [reading, setReading] = useState(false);
  const vRef = useRef<Virtual | null>(null);
  const seen = useRef(0);
  const nextId = useRef(1);
  const readingRef = useRef(false);
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved !== null) setOpen(saved === '1');
    } catch {
      /* ignore */
    }
  }, []);

  const push = useCallback((text: string, kind: Line['kind']) => {
    setLines((prev) => [...prev.slice(-80), { id: nextId.current++, text, kind }]);
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    (async () => {
      const mod = await import('@guidepup/virtual-screen-reader');
      if (cancelled) return;
      const root = document.getElementById(rootId) ?? document.body;
      const v = mod.virtual as unknown as Virtual;
      vRef.current = v;
      await v.start({ container: root, displayCursor: false });
      await v.clearSpokenPhraseLog();
      seen.current = 0;
      timer = setInterval(async () => {
        const log = await v.spokenPhraseLog();
        if (log.length > seen.current) {
          for (const text of log.slice(seen.current)) {
            if (!text || text === 'document') continue;
            push(text, readingRef.current ? 'read' : /^(polite|assertive):/.test(text) ? 'live' : 'focus');
          }
          seen.current = log.length;
        }
      }, 250);
    })().catch(() => push('The Speech Viewer could not start in this browser.', 'live'));
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      readingRef.current = false;
      void vRef.current?.stop();
      vRef.current = null;
    };
  }, [open, push, rootId]);

  useEffect(() => {
    listRef.current?.lastElementChild?.scrollIntoView({ block: 'end' });
  }, [lines]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    try {
      localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
    } catch {
      /* ignore */
    }
  };

  const readPage = async () => {
    const v = vRef.current;
    if (!v) return;
    if (readingRef.current) {
      readingRef.current = false;
      setReading(false);
      return;
    }
    readingRef.current = true;
    setReading(true);
    const root = document.getElementById(rootId) ?? document.body;
    await v.stop();
    await v.start({ container: root, displayCursor: true });
    await v.clearSpokenPhraseLog();
    seen.current = 0;
    for (let i = 0; i < 400 && readingRef.current; i++) {
      await v.next();
      const last = await v.lastSpokenPhrase();
      if (last === 'end of document') break;
      await new Promise((r) => setTimeout(r, 380));
    }
    readingRef.current = false;
    setReading(false);
  };

  return (
    <div className="speech-viewer" data-open={open}>
      <button type="button" className="btn speech-viewer-toggle" aria-pressed={open} onClick={toggle}>
        <span aria-hidden="true" className="sv-dots">
          <span className="dot" />
          <span className="dot" data-off="" />
          <span className="dot" />
        </span>
        Speech Viewer
      </button>
      {open && (
        <aside className="speech-viewer-panel" aria-label="Speech Viewer">
          <div className="sv-head">
            <p className="sv-title">What a screen reader says</p>
            <p className="sr-only">
              This panel shows sighted viewers what a screen reader announces. If you use a screen reader, you are already hearing it, so you can
              ignore this panel.
            </p>
            <div className="sv-actions">
              <button type="button" className="btn" onClick={readPage}>
                {reading ? 'Stop reading' : 'Read this page'}
              </button>
              <button type="button" className="btn" onClick={() => setLines([])}>
                Clear
              </button>
            </div>
          </div>
          <ol ref={listRef} className="sv-lines" aria-hidden="true">
            {lines.length === 0 && <li className="sv-empty">Move around the page with Tab, or press Read this page.</li>}
            {lines.map((l) => (
              <li key={l.id} data-kind={l.kind}>
                {l.text}
              </li>
            ))}
          </ol>
        </aside>
      )}
    </div>
  );
}
