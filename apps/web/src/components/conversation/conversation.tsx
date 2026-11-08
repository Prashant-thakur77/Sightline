'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { PRODUCT_NAME } from '@sightline/core';
import { useAnnouncer } from '@/components/a11y/announcer';
import { cue } from '@/lib/feedback';
import { useSpeechInput } from '@/lib/speech-input';
import { CardView } from './cards';
import type { Card, ChatMessage, TurnRequest, TurnResponse } from './types';
import { PayPalCheckout } from './paypal-checkout';

/** Shortcut keys. Single-character keys are opt-in (WCAG 2.1.4); by default they need Alt (Option). */
function shortcutRows(single: boolean): [string, string][] {
  const k = (key: string) => (single ? key : `Alt + ${key}`);
  return [
    [single ? 'Hold Space' : 'Space or Enter on the Talk button', single ? 'Talk while held' : 'Start talking; press again to send'],
    [k('T'), 'Turn talking on or off'],
    [k('R'), 'Repeat the last thing I said'],
    [k('1, 2, 3'), 'Choose an option'],
    [k('M'), 'More details'],
    [k('C'), 'Compare the options'],
    ['Shift + Enter', 'Confirm, only while I read back a purchase'],
    ['Escape', 'Stop speaking, or stop listening'],
    [k('H'), 'Help'],
    [k('O'), 'Orders and money'],
    [k('?'), 'Show these shortcuts'],
  ];
}

function isTyping(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

export function Conversation({ firstName, initial }: { firstName: string; initial?: TurnResponse | null }) {
  const { announce, stop: stopSpeaking } = useAnnouncer();
  const [messages, setMessages] = useState<ChatMessage[]>(initial?.messages ?? []);
  const [card, setCard] = useState<Card | null>(initial?.card ?? null);
  const [suggestions, setSuggestions] = useState(initial?.suggestions ?? []);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const [toggleTalk, setToggleTalk] = useState(false);
  const [showKeys, setShowKeys] = useState(false);
  const [singleKeys, setSingleKeys] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState(true);
  const lastSay = useRef(initial?.say ?? '');
  const cardRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const spaceDown = useRef(false);

  const busyRef = useRef(false);
  const send = useCallback(
    async (req: TurnRequest) => {
      if (busyRef.current) return;
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        const msg = "You're offline, so I can't do that right now. Nothing was sent or charged.";
        setError(msg);
        announce(msg, { politeness: 'assertive', source: 'network' });
        return;
      }
      busyRef.current = true;
      setBusy(true);
      setError(null);
      cue('thinking');
      // Focus inside the card is about to disappear with the card; remember to move it.
      const focusWasInCard = Boolean(cardRef.current?.contains(document.activeElement)) || document.activeElement === document.body;
      if ('text' in req) setMessages((m) => [...m, { id: `local-${Date.now()}`, role: 'user', text: req.text }]);
      try {
        const res = await fetch('/api/turn', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(req),
        });
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as TurnResponse;
        setMessages((m) => [...m.filter((x) => !x.id.startsWith('local-')), ...data.messages]);
        setCard(data.card);
        setSuggestions(data.suggestions);
        lastSay.current = data.say;
        // One channel: the reply is announced; focus stays where the person is unless the
        // control they used just went away, in which case it goes to the new card's heading.
        announce(data.say, { politeness: data.politeness, source: 'assistant' });
        if (data.cue) cue(data.cue);
        else cue('done');
        if (focusWasInCard)
          requestAnimationFrame(() => (cardRef.current?.querySelector<HTMLElement>('.card-h') ?? inputRef.current)?.focus({ preventScroll: false }));
      } catch {
        const msg = 'Something went wrong on my side. Nothing was charged. Please try that again.';
        setError(msg);
        cue('error');
        announce(msg, { politeness: 'assertive', source: 'assistant' });
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [announce],
  );

  useEffect(() => {
    try {
      setSingleKeys(localStorage.getItem('sl-single-keys') === '1');
    } catch {
      /* ignore */
    }
    const on = () => {
      setOnline(true);
      announce("You're back online.", { source: 'network' });
    };
    const off = () => {
      setOnline(false);
      announce("You're offline. Nothing will be sent until you're back online.", { politeness: 'assertive', source: 'network' });
    };
    setOnline(navigator.onLine);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, [announce]);

  const toggleSingleKeys = (v: boolean) => {
    setSingleKeys(v);
    try {
      localStorage.setItem('sl-single-keys', v ? '1' : '0');
    } catch {
      /* ignore */
    }
    announce(v ? 'Single-key shortcuts on.' : 'Single-key shortcuts off. Use Alt with the key.', { source: 'settings' });
  };

  const speech = useSpeechInput(
    (heard) => {
      void send({ text: heard, source: 'voice' });
    },
    (msg) => announce(msg, { politeness: 'assertive', source: 'microphone' }),
  );

  const startListening = useCallback(() => {
    stopSpeaking();
    cue('listening');
    announce('Listening.', { source: 'microphone', speak: false });
    void speech.start();
  }, [announce, speech, stopSpeaking]);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        stopSpeaking();
        if (speech.listening) speech.cancel();
        setShowKeys(false);
        return;
      }
      if (e.key === 'Enter' && e.shiftKey && card?.kind === 'readback') {
        e.preventDefault();
        void send({ action: 'confirm-button', readbackId: card.readbackId });
        return;
      }
      if (isTyping(e.target) || e.metaKey || e.ctrlKey) return;
      // Single-character shortcuts only when switched on; otherwise they need Alt (Option).
      if (singleKeys ? e.altKey : !e.altKey) return;
      if (singleKeys && e.code === 'Space' && !e.repeat && !(e.target instanceof HTMLButtonElement) && !(e.target instanceof HTMLAnchorElement)) {
        e.preventDefault();
        spaceDown.current = true;
        startListening();
        return;
      }
      // With Alt held, some layouts change e.key; use the physical key.
      const k = e.altKey ? e.code.replace(/^Key|^Digit/, '').toLowerCase() : e.key.toLowerCase();
      if (k === 't') {
        e.preventDefault();
        if (speech.listening) {
          speech.stop();
          setToggleTalk(false);
        } else {
          setToggleTalk(true);
          startListening();
        }
      } else if (k === 'r') {
        e.preventDefault();
        if (lastSay.current) announce(lastSay.current, { source: 'assistant (repeat)' });
      } else if (['1', '2', '3'].includes(k) && card?.kind === 'options') {
        e.preventDefault();
        void send({ action: 'choose', index: Number(k) });
      } else if (k === 'm') {
        e.preventDefault();
        void send({ text: 'tell me more', source: 'keyboard' });
      } else if (k === 'c') {
        e.preventDefault();
        void send({ text: 'compare them', source: 'keyboard' });
      } else if (k === 'h') {
        e.preventDefault();
        void send({ text: 'help', source: 'keyboard' });
      } else if (k === 'o') {
        e.preventDefault();
        window.location.href = '/app/orders';
      } else if (e.key === '?' || (e.altKey && e.code === 'Slash')) {
        e.preventDefault();
        setShowKeys((s) => !s);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space' && spaceDown.current) {
        spaceDown.current = false;
        speech.stop();
      }
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [announce, card, send, singleKeys, speech, startListening, stopSpeaking]);

  const started = useRef(false);
  useEffect(() => {
    if (started.current || initial) return;
    started.current = true;
    void send({ action: 'start' });
  }, [initial, send]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    setText('');
    void send({ text: t, source: 'keyboard' });
  };

  return (
    <div className="convo">
      <div className="convo-main">
        <h1 className="convo-h">What do you need today, {firstName}?</h1>

        <div ref={cardRef} className="convo-card" aria-busy={busy || undefined}>
          {card && (
            <CardView
              card={card}
              onChoose={(i) => void send({ action: 'details', index: i })}
              onBuy={(i) => void send({ action: 'buy', index: i })}
              onConfirm={(id) => void send({ action: 'confirm-button', readbackId: id })}
              onHold={(id) => void send({ action: 'hold', readbackId: id })}
              onCancel={() => void send({ action: 'cancel' })}
              paypalSlot={
                card.kind === 'paypal' ? (
                  <PayPalCheckout
                    clientId={card.clientId}
                    readbackId={card.readbackId}
                    intent={card.orderIntent}
                    onApproved={(paypalOrderId) => void send({ action: 'paypal-approved', readbackId: card.readbackId, paypalOrderId })}
                    onError={(m) => announce(m, { politeness: 'assertive', source: 'PayPal' })}
                  />
                ) : null
              }
            />
          )}
        </div>

        <form className="composer" onSubmit={submit} aria-label="Talk or type">
          <button
            type="button"
            className="talk"
            aria-pressed={speech.listening}
            onPointerDown={(e) => {
              if (toggleTalk) return;
              e.preventDefault();
              startListening();
            }}
            onPointerUp={() => !toggleTalk && speech.stop()}
            onPointerLeave={() => !toggleTalk && speech.listening && speech.stop()}
            onKeyDown={(e) => {
              if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) {
                e.preventDefault();
                if (speech.listening) speech.stop();
                else {
                  setToggleTalk(true);
                  startListening();
                }
              }
            }}
          >
            <span className="talk-dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            <span>{speech.listening ? 'Listening… release or press again to send' : 'Hold to talk'}</span>
          </button>
          <div className="composer-type">
            <label htmlFor="say" className="sr-only">
              Or type what you need
            </label>
            <input
              ref={inputRef}
              id="say"
              type="text"
              autoComplete="off"
              placeholder="Or type: navy crew-neck sweater, medium, under $40"
              value={text}
              onChange={(e) => setText(e.target.value)}
              readOnly={busy}
              aria-describedby="convo-status"
            />
            <button type="submit" className="btn btn-primary" aria-disabled={busy || !text.trim() || undefined}>
              Send
            </button>
          </div>
          {speech.listening && speech.interim && (
            <p className="interim" aria-hidden="true">
              {speech.interim}
            </p>
          )}
          <p id="convo-status" className="convo-status" data-state={!online ? 'offline' : error ? 'error' : busy ? 'busy' : 'idle'}>
            {!online ? "You're offline. Nothing will be sent until you're back online." : error ? error : busy ? 'Thinking…' : ''}
          </p>
        </form>

        {suggestions.length > 0 && (
          <div className="suggestions">
            <h2 className="sr-only">Things you can say</h2>
            <ul>
              {suggestions.map((s) => (
                <li key={s.label}>
                  <button type="button" className="btn" onClick={() => void send({ text: s.utterance, source: 'keyboard' })} aria-disabled={busy || undefined}>
                    {s.label}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="keys-hint">
          <button type="button" className="btn btn-quiet" aria-expanded={showKeys} onClick={() => setShowKeys((s) => !s)}>
            Keyboard shortcuts
          </button>
        </p>
        {showKeys && (
          <div className="grid gap-3">
          <div className="choice">
            <input type="checkbox" id="single-keys" checked={singleKeys} onChange={(e) => toggleSingleKeys(e.target.checked)} aria-describedby="single-keys-h" />
            <label htmlFor="single-keys">Use single-key shortcuts</label>
            <p id="single-keys-h" className="hint">
              Off by default, so they never clash with your screen reader's own keys. When off, hold Alt (Option on a Mac) with the key.
            </p>
          </div>
          <table className="keys">
            <caption className="sr-only">Keyboard shortcuts</caption>
            <tbody>
              {shortcutRows(singleKeys).map(([k, v]) => (
                <tr key={k}>
                  <th scope="row">
                    <kbd>{k}</kbd>
                  </th>
                  <td>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>

      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrollable region must be reachable by keyboard (WCAG 2.1.1) */}
      <section className="transcript" aria-labelledby="transcript-h" tabIndex={0}>
        <h2 id="transcript-h" className="transcript-h">
          Conversation
        </h2>
        {messages.length === 0 ? (
          <p className="muted">Nothing yet.</p>
        ) : (
          <ol>
            {messages.map((m) => (
              <li key={m.id} data-role={m.role}>
                <span className="sr-only">{m.role === 'user' ? 'You said: ' : `${PRODUCT_NAME} said: `}</span>
                {m.text}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
