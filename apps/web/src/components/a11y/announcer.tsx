'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

export type Politeness = 'polite' | 'assertive';

export interface Announcement {
  id: number;
  text: string;
  politeness: Politeness;
  at: number;
  /** Where it came from, shown in the Speech Viewer. */
  source?: string;
  /** False when it was not written to a live region (focus moved to the same text instead). */
  live?: boolean;
}

interface AnnounceOptions {
  politeness?: Politeness;
  /** Also speak with the app's own voice when the user turned it on. Defaults to true. */
  speak?: boolean;
  source?: string;
  /**
   * Write to a live region. Defaults to true. Pass false when focus moves to an element that
   * shows this same text: the screen reader reads it on focus, so a live announcement would
   * say it twice. It still reaches the Speech Viewer and the app's own voice.
   */
  live?: boolean;
}

interface AnnouncerApi {
  announce: (text: string, opts?: AnnounceOptions) => void;
  stop: () => void;
  subscribe: (fn: (a: Announcement) => void) => () => void;
  history: () => Announcement[];
  ownVoice: { enabled: boolean; rate: number };
  setOwnVoice: (v: { enabled: boolean; rate: number }) => void;
}

const AnnouncerContext = createContext<AnnouncerApi | null>(null);

const DEDUPE_MS = 1200;
const KEEP_MS = 5000;

/**
 * The only component that writes to live regions. Messages are appended as new nodes (never
 * replaced) so screen readers queue them instead of dropping one; identical messages within a
 * short window are dropped so nothing is announced twice.
 */
export function AnnouncerProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<Announcement[]>([]);
  const nextId = useRef(1);
  const last = useRef<{ text: string; at: number } | null>(null);
  const listeners = useRef(new Set<(a: Announcement) => void>());
  const log = useRef<Announcement[]>([]);
  const [ownVoice, setOwnVoiceState] = useState({ enabled: false, rate: 1 });
  const ownVoiceRef = useRef(ownVoice);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('sl-own-voice') ?? 'null');
      if (saved && typeof saved.enabled === 'boolean') {
        setOwnVoiceState(saved);
        ownVoiceRef.current = saved;
      }
    } catch {
      /* storage blocked: keep defaults */
    }
  }, []);

  const setOwnVoice = useCallback((v: { enabled: boolean; rate: number }) => {
    ownVoiceRef.current = v;
    setOwnVoiceState(v);
    try {
      localStorage.setItem('sl-own-voice', JSON.stringify(v));
    } catch {
      /* ignore */
    }
  }, []);

  const stop = useCallback(() => {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
  }, []);

  const announce = useCallback((text: string, opts: AnnounceOptions = {}) => {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean) return;
    const now = Date.now();
    if (last.current && last.current.text === clean && now - last.current.at < DEDUPE_MS) return;
    last.current = { text: clean, at: now };
    const a: Announcement = {
      id: nextId.current++,
      text: clean,
      politeness: opts.politeness ?? 'polite',
      at: now,
      source: opts.source,
      live: opts.live !== false,
    };
    log.current = [...log.current.slice(-199), a];
    // Read by end-to-end tests to check that each update is announced exactly once.
    (window as unknown as { __announcements?: string[] }).__announcements = log.current.map((x) => x.text);
    if (opts.live !== false) setItems((prev) => [...prev.filter((p) => now - p.at < KEEP_MS), a]);
    for (const fn of listeners.current) fn(a);
    const v = ownVoiceRef.current;
    if (v.enabled && opts.speak !== false && typeof window !== 'undefined' && 'speechSynthesis' in window) {
      if (a.politeness === 'assertive') window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(clean);
      u.rate = v.rate;
      u.lang = document.documentElement.lang || 'en-US';
      window.speechSynthesis.speak(u);
    }
  }, []);

  useEffect(() => {
    const t = setInterval(() => {
      const now = Date.now();
      setItems((prev) => (prev.some((p) => now - p.at >= KEEP_MS) ? prev.filter((p) => now - p.at < KEEP_MS) : prev));
    }, 1000);
    return () => clearInterval(t);
  }, []);

  const subscribe = useCallback((fn: (a: Announcement) => void) => {
    listeners.current.add(fn);
    return () => {
      listeners.current.delete(fn);
    };
  }, []);

  const api = useMemo<AnnouncerApi>(
    () => ({ announce, stop, subscribe, history: () => log.current, ownVoice, setOwnVoice }),
    [announce, stop, subscribe, ownVoice, setOwnVoice],
  );

  return (
    <AnnouncerContext.Provider value={api}>
      {children}
      <div className="sr-only" aria-live="polite" aria-atomic="false" aria-relevant="additions" data-announcer="polite">
        {items
          .filter((i) => i.politeness === 'polite')
          .map((i) => (
            <p key={i.id}>{i.text}</p>
          ))}
      </div>
      <div className="sr-only" aria-live="assertive" aria-atomic="false" aria-relevant="additions" data-announcer="assertive">
        {items
          .filter((i) => i.politeness === 'assertive')
          .map((i) => (
            <p key={i.id}>{i.text}</p>
          ))}
      </div>
    </AnnouncerContext.Provider>
  );
}

export function useAnnouncer(): AnnouncerApi {
  const ctx = useContext(AnnouncerContext);
  if (!ctx) throw new Error('useAnnouncer must be used inside AnnouncerProvider');
  return ctx;
}
