'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { PRODUCT_NAME } from '@sightline/core';
import { useAnnouncer } from '@/components/a11y/announcer';
import { cue } from '@/lib/feedback';
import { useSpeechInput } from '@/lib/speech-input';
import { CardView } from './cards';
import type { Card, ChatMessage, TurnRequest, TurnResponse } from './types';
import { PayPalCheckout } from './paypal-checkout';

const SHORTCUTS: [string, string][] = [
  ['Hold Space', 'Talk (when not typing)'],
  ['T', 'Turn talking on or off'],
  ['R', 'Repeat the last thing I said'],
  ['1, 2, 3', 'Choose an option'],
  ['M', 'More details'],
  ['C', 'Compare the options'],
  ['Shift + Enter', 'Confirm, only while I read back a purchase'],
  ['Escape', 'Stop speaking, or stop listening'],
  ['H', 'Help'],
  ['O', 'Orders and money'],
  ['?', 'Show these shortcuts'],
];

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
  const lastSay = useRef(initial?.say ?? '');
  const cardRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const spaceDown = useRef(false);

  const send = useCallback(
    async (req: TurnRequest) => {
      setBusy(true);
      cue('thinking');
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
        announce(data.say, { politeness: data.politeness, source: 'assistant' });
        if (data.cue) cue(data.cue);
        else cue('done');
        if (data.card) requestAnimationFrame(() => cardRef.current?.querySelector<HTMLElement>('.card-h')?.focus());
      } catch {
        cue('error');
        announce("Something went wrong on my side. Nothing was charged. Please try that again.", { politeness: 'assertive', source: 'assistant' });
      } finally {
        setBusy(false);
      }
    },
    [announce],
  );

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
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === 'Space' && !e.repeat && !(e.target instanceof HTMLButtonElement) && !(e.target instanceof HTMLAnchorElement)) {
        e.preventDefault();
        spaceDown.current = true;
        startListening();
        return;
      }
      const k = e.key.toLowerCase();
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
      } else if (e.key === '?') {
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
  }, [announce, card, send, speech, startListening, stopSpeaking]);

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

        <div ref={cardRef} className="convo-card" aria-busy={busy}>
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
              disabled={busy}
            />
            <button type="submit" className="btn btn-primary" disabled={busy || !text.trim()}>
              Send
            </button>
          </div>
          {speech.listening && speech.interim && (
            <p className="interim" aria-hidden="true">
              {speech.interim}
            </p>
          )}
        </form>

        {suggestions.length > 0 && (
          <div className="suggestions">
            <h2 className="sr-only">Things you can say</h2>
            <ul>
              {suggestions.map((s) => (
                <li key={s.label}>
                  <button type="button" className="btn" onClick={() => void send({ text: s.utterance, source: 'keyboard' })} disabled={busy}>
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
          <table className="keys">
            <caption className="sr-only">Keyboard shortcuts</caption>
            <tbody>
              {SHORTCUTS.map(([k, v]) => (
                <tr key={k}>
                  <th scope="row">
                    <kbd>{k}</kbd>
                  </th>
                  <td>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
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
