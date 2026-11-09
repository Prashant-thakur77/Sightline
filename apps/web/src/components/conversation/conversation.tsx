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
  const k = (key: string) => (single ? key : `Alt + Shift + ${key}`);
  return [
    [single ? 'Hold Space' : 'Space or Enter on the Talk button', single ? 'Talk while held' : 'Start talking; press again to send'],
    [k('T'), 'Turn talking on or off'],
    [k('R'), 'Repeat the last thing I said'],
    [k('1, 2, 3'), 'Choose an option'],
    [k('M'), 'More details'],
    [k('C'), 'Compare the options'],
    ['Shift + Enter', 'Confirm, only while I read back a purchase (not from the text box)'],
    ['Escape', 'Stop speaking, or stop listening'],
    [k('H'), 'Help'],
    [k('O'), 'Orders and money'],
    [k('?'), 'Show these shortcuts'],
  ];
}

/**
 * How long the microphone waits after "Listening." is announced, so a screen reader saying it is
 * not transcribed as the request. Short and fixed: the earcon marks the moment it opens.
 */
const MIC_OPEN_DELAY_MS = 700;

/** The optional "I heard: …" echo of recognised speech. On unless switched off in Settings. */
export const HEARD_ECHO_KEY = 'sl-heard-echo';
function heardEchoOn(): boolean {
  try {
    return localStorage.getItem(HEARD_ECHO_KEY) !== '0';
  } catch {
    return true;
  }
}

function isTyping(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

/** Typed words that did not reach the server go back in the text box, and the message says so. */
const KEPT = ' Your words are still in the text box.';

export function Conversation({
  firstName,
  initial,
  opening,
}: {
  firstName: string;
  /**
   * The conversation so far, from the server: messages, and a readback or options still waiting.
   * Shown at once; the greeting turn that follows says hello and brings the same card back.
   */
  initial?: TurnResponse | null;
  /** What the page was opened to do, instead of the usual greeting: "offer" reads the store's waiting offer. */
  opening?: 'offer';
}) {
  const { announce, stop: stopSpeaking, ownVoice, setOwnVoice } = useAnnouncer();
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
  // After the first request the big greeting shrinks, so the active card stays above the fold.
  const [compact, setCompact] = useState(() => Boolean(initial?.messages.some((m) => m.role === 'user')));
  const lastSay = useRef(initial?.say ?? '');
  const cardRef = useRef<HTMLDivElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);
  /** Where focus should go once the reply's card is on screen; applied by the effect below. */
  const pendingFocus = useRef<{ inCard: boolean; inSuggestions: boolean; action: string | null } | null>(null);
  const [focusTick, setFocusTick] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const transcriptRef = useRef<HTMLElement>(null);
  const spaceDown = useRef(false);

  const busyRef = useRef(false);
  /**
   * Sends one turn. True when the server answered; false when nothing was sent (offline, or another
   * request still running) or the request failed, so a caller can give typed words back.
   */
  const send = useCallback(
    async (req: TurnRequest, opts: { typed?: boolean } = {}): Promise<boolean> => {
      if (busyRef.current) return false;
      const kept = opts.typed ? KEPT : '';
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        const msg = `You're offline, so I can't do that right now. Nothing was sent or charged.${kept}`;
        setError(msg);
        announce(msg, { politeness: 'assertive', source: 'network' });
        return false;
      }
      busyRef.current = true;
      setBusy(true);
      setError(null);
      const greeting = 'action' in req && req.action === 'start';
      // No sound or vibration as the page opens (nothing autoplays); cues follow what the person does.
      if (!greeting) cue('thinking');
      if (!greeting) setCompact(true);
      // Focus inside the card is about to disappear with the card; remember to move it.
      // An offer opened from an order page's link always lands on the offer card: focus may still be
      // on the link that navigated here, so it can't be used to decide.
      const openedOffer = 'action' in req && req.action === 'offer';
      const focusWasInCard =
        openedOffer ||
        (!greeting && (Boolean(cardRef.current?.contains(document.activeElement)) || document.activeElement === document.body));
      // The card control that had focus (Confirm, Wait, Cancel), so the same control in the card
      // that comes back keeps it, instead of sending a screen reader back to the heading.
      const actionHadFocus =
        document.activeElement instanceof HTMLElement && cardRef.current?.contains(document.activeElement)
          ? document.activeElement.closest<HTMLElement>('[data-action]')?.dataset.action
          : undefined;
      // Suggestion buttons are replaced too; if focus was on one, it must not fall to the page.
      const focusWasInSuggestions = Boolean(suggestionsRef.current?.contains(document.activeElement));
      // If the reply takes a while, say so once; the visible status line already says "Thinking…".
      const slow = setTimeout(() => announce('Working on it.', { source: 'assistant', speak: false }), 1500);
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
        // A speech rate changed by voice applies before the reply is spoken, so it is heard at once.
        if (data.settings?.speechRate) setOwnVoice({ enabled: ownVoice.enabled, rate: data.settings.speechRate / 100 });
        // One channel: the reply is announced; focus stays where the person is unless the
        // control they used just went away, in which case it goes to the new card's heading.
        announce(data.say, { politeness: data.politeness, source: 'assistant' });
        if (!greeting) {
          if (data.cue) cue(data.cue);
          else cue('done');
        }
        clearTimeout(slow);
        // Moved after React has drawn the new card (see the effect on focusTick), never on a timer,
        // so a slow render can't send focus to the text box instead of the card.
        if (focusWasInCard || focusWasInSuggestions) {
          pendingFocus.current = { inCard: focusWasInCard, inSuggestions: focusWasInSuggestions, action: actionHadFocus ?? null };
          setFocusTick((t) => t + 1);
        }
        return true;
      } catch {
        clearTimeout(slow);
        // The words never reached a reply, so they are not left in the transcript as if they had.
        setMessages((m) => m.filter((x) => !x.id.startsWith('local-')));
        const msg = opts.typed
          ? `Something went wrong on my side, so that wasn't sent. Nothing was charged.${KEPT} Press Send to try again.`
          : 'Something went wrong on my side. Nothing was charged. Please try that again.';
        setError(msg);
        cue('error');
        announce(msg, { politeness: 'assertive', source: 'assistant' });
        return false;
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [announce, ownVoice.enabled, setOwnVoice],
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
    announce(v ? 'Single-key shortcuts on.' : 'Single-key shortcuts off. Use Alt and Shift with the key.', { source: 'settings' });
  };

  const speech = useSpeechInput(
    (heard) => {
      // Said once, before the reply, so a misheard word is caught before it matters. The
      // transcript already shows what was sent, so the echo is not added there.
      if (heardEchoOn()) announce(`I heard: ${heard.trim().replace(/[.!?]+$/, '')}.`, { source: 'microphone' });
      void send({ text: heard, source: 'voice' });
    },
    (msg) => announce(msg, { politeness: 'assertive', source: 'microphone' }),
  );

  /** The microphone is about to open: "Listening." has been announced and is being spoken. */
  const [arming, setArming] = useState(false);
  const micTimer = useRef<number | null>(null);
  const cancelArming = useCallback((): boolean => {
    if (micTimer.current === null) return false;
    window.clearTimeout(micTimer.current);
    micTimer.current = null;
    setArming(false);
    return true;
  }, []);
  useEffect(() => () => void cancelArming(), [cancelArming]);

  const startListening = useCallback(() => {
    stopSpeaking();
    // Assertive, so it cuts in on anything the screen reader is still reading and is short.
    announce('Listening.', { politeness: 'assertive', source: 'microphone', speak: false });
    cancelArming();
    setArming(true);
    // The microphone opens only once "Listening." has had time to be spoken, so the screen
    // reader's own voice is not transcribed. The listening sound marks the moment it opens.
    micTimer.current = window.setTimeout(() => {
      micTimer.current = null;
      setArming(false);
      cue('listening');
      void speech.start();
    }, MIC_OPEN_DELAY_MS);
  }, [announce, cancelArming, speech, stopSpeaking]);

  /** Stop and send what was heard; before the microphone opened, nothing was heard or sent. */
  const stopListening = useCallback(() => {
    if (cancelArming()) announce('Nothing was sent. Hold Talk a moment longer before you speak.', { source: 'microphone' });
    else speech.stop();
  }, [announce, cancelArming, speech]);

  const micOn = speech.listening || arming;

  /** Press once to start, again to send. Used by keyboard, click-only assistive tech and quick taps. */
  const toggleListening = useCallback(() => {
    if (micOn) {
      stopListening();
      setToggleTalk(false);
    } else {
      setToggleTalk(true);
      startListening();
    }
  }, [micOn, startListening, stopListening]);
  /** The pointer press in progress on Talk: when it began, and whether it started listening. */
  const press = useRef<{ at: number; started: boolean } | null>(null);
  const lastKeyPress = useRef(0);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        stopSpeaking();
        const wasArming = cancelArming();
        if (speech.listening || wasArming) {
          speech.cancel();
          setToggleTalk(false);
          announce('Stopped listening. Nothing was sent.', { source: 'microphone' });
        }
        setShowKeys(false);
        return;
      }
      if (e.metaKey || e.ctrlKey) return;
      // Alt+Shift (Option+Shift) chords work everywhere, the text box included: they don't type
      // text there. Single keys and Shift+Enter never act from a text box, so typing can't trigger them.
      const chord = e.altKey && e.shiftKey;
      const typing = isTyping(e.target);
      if (typing && !chord) return;
      // Confirming by keyboard never happens from inside the text box, so a stray key while typing can't pay.
      if (!typing && e.key === 'Enter' && e.shiftKey && !e.altKey && card?.kind === 'readback') {
        e.preventDefault();
        void send({ action: 'confirm-button', readbackId: card.readbackId });
        return;
      }
      // Single-character shortcuts only when switched on; Alt+Shift, which browsers and screen
      // readers leave free, always works.
      if (!chord && !(singleKeys && !e.altKey)) return;
      if (!chord && singleKeys && e.code === 'Space' && !e.repeat && !(e.target instanceof HTMLButtonElement) && !(e.target instanceof HTMLAnchorElement)) {
        e.preventDefault();
        spaceDown.current = true;
        startListening();
        return;
      }
      // With Alt held, some layouts change e.key; use the physical key.
      const k = e.altKey ? e.code.replace(/^Key|^Digit/, '').toLowerCase() : e.key.toLowerCase();
      if (k === 't') {
        e.preventDefault();
        toggleListening();
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
      } else if (e.key === '?' || k === 'slash' || (e.altKey && e.code === 'Slash')) {
        e.preventDefault();
        setShowKeys((s) => !s);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space' && spaceDown.current) {
        spaceDown.current = false;
        stopListening();
      }
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [announce, cancelArming, card, send, singleKeys, speech, startListening, stopListening, stopSpeaking, toggleListening]);

  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (opening === 'offer') {
      // Opened from an order's "Hear the offer" link: read the offer straight away. The address goes
      // back to plain /app, so reloading the page greets as usual.
      window.history.replaceState(null, '', '/app');
      void send({ action: 'offer' });
    } else void send({ action: 'start' });
  }, [opening, send]);

  useEffect(() => {
    const p = pendingFocus.current;
    if (!p) return;
    pendingFocus.current = null;
    const active = document.activeElement;
    if (!p.inCard && active && active !== document.body && suggestionsRef.current?.contains(active)) return;
    const sameControl = p.action ? cardRef.current?.querySelector<HTMLElement>(`[data-action="${CSS.escape(p.action)}"]`) : null;
    if (sameControl) {
      // Usually the very same button, still focused: leave it be so nothing is read twice.
      if (sameControl !== active) sameControl.focus({ preventScroll: false });
      return;
    }
    const target =
      cardRef.current?.querySelector<HTMLElement>('.card-h') ??
      (p.inSuggestions ? suggestionsRef.current?.querySelector<HTMLElement>('button') : null) ??
      inputRef.current;
    target?.focus({ preventScroll: false });
  }, [focusTick]);

  // The newest message stays in view. Only the box scrolls: focus and the page stay where they are.
  useEffect(() => {
    const box = transcriptRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [messages]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t || busyRef.current) return;
    setText('');
    const sent = await send({ text: t, source: 'keyboard' }, { typed: true });
    // Nothing reached the server: the words come back, unless something new was typed meanwhile.
    if (!sent) setText((now) => now || t);
  };

  return (
    <div className="convo-wrap">
      <div className="convo">
        <div className="convo-main">
          {/* Same heading and text for screen readers; only its size changes after the first request. */}
          <h1 className="convo-h" data-compact={compact || undefined}>
            What do you need today, {firstName}?
          </h1>

          <div ref={cardRef} className="convo-card" aria-busy={busy || undefined}>
            {card && (
              <CardView
                card={card}
                onChoose={(i) => void send({ action: 'details', index: i })}
                onBuy={(i) => void send({ action: 'buy', index: i })}
                onConfirm={(id) => void send({ action: 'confirm-button', readbackId: id })}
                onHold={(id) => void send({ action: 'hold', readbackId: id })}
                onCancel={() => void send({ action: 'cancel' })}
                onOffer={(answer, offerId) => void send({ action: answer === 'accept' ? 'offer-accept' : 'offer-decline', offerId })}
                paypalSlot={
                  card.kind === 'paypal' ? (
                    <PayPalCheckout
                      clientId={card.clientId}
                      paypalOrderId={card.paypalOrderId}
                      total={card.total}
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
              aria-pressed={micOn}
              aria-describedby="talk-hint"
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                if (micOn) {
                  press.current = { at: performance.now(), started: false };
                  return;
                }
                press.current = { at: performance.now(), started: true };
                setToggleTalk(false);
                startListening();
              }}
              onPointerUp={() => {
                const p = press.current;
                press.current = null;
                if (!p) return;
                if (!p.started) {
                  // A second press while listening sends.
                  stopListening();
                  setToggleTalk(false);
                } else if (performance.now() - p.at < 350) {
                  // A quick tap (and touch screen readers' double tap) starts listening and keeps it on.
                  setToggleTalk(true);
                } else {
                  // Held, then released: send.
                  stopListening();
                }
              }}
              onPointerLeave={() => {
                if (press.current?.started && !toggleTalk) {
                  press.current = null;
                  stopListening();
                }
              }}
              onKeyDown={(e) => {
                if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) {
                  e.preventDefault();
                  lastKeyPress.current = performance.now();
                  toggleListening();
                }
              }}
              onClick={(e) => {
                // Assistive tech that sends only a click (no pointer or key events) has detail 0.
                if (e.detail !== 0 || performance.now() - lastKeyPress.current < 500) return;
                toggleListening();
              }}
            >
              <span className="talk-dots" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
              <span>
                {arming ? 'Getting ready…' : speech.listening ? (toggleTalk ? 'Listening… press again to send' : 'Listening… let go to send') : 'Talk'}
              </span>
            </button>
            {/* Read as the Talk button's description; hidden here so browse mode doesn't read it twice. */}
            <p id="talk-hint" className="hint talk-hint" aria-hidden="true">
              Hold to talk, or press once to start and again to send.
            </p>
            {ownVoice.enabled && (
              <button type="button" className="btn" onClick={() => stopSpeaking()}>
                Stop speaking
              </button>
            )}
            <div className="composer-type">
              <label htmlFor="say" className="composer-label">
                Or type what you need
              </label>
              <input
                ref={inputRef}
                id="say"
                type="text"
                autoComplete="off"
                placeholder="For example: navy crew-neck sweater, medium, under $40"
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

          {/* Close under the composer: what you can say next, and the shortcuts. */}
          <div className="convo-extras">
            {suggestions.length > 0 && (
              <div className="suggestions" ref={suggestionsRef}>
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
                    Off by default, so they never clash with your screen reader's own keys. When off, hold Alt and Shift (Option and Shift on a Mac) with the key.
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
        </div>

        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrollable region must be reachable by keyboard (WCAG 2.1.1) */}
        <section ref={transcriptRef} className="transcript" aria-labelledby="transcript-h" tabIndex={0}>
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
    </div>
  );
}
