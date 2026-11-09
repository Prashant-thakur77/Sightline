'use client';

import { useActionState, useEffect, useRef, useState, useTransition } from 'react';
import { useAnnouncer } from '@/components/a11y/announcer';
import { setFeedback } from '@/lib/feedback';
import { saveSettings, type SaveState } from './actions';

interface Initial {
  verbosity: string;
  voiceMode: string;
  speechRate: number;
  sizes: Record<string, string>;
  avoidColours: string;
  perOrderCap: number;
  dailyCap: number;
  payAfterCheck: boolean;
  lowVision: { enabled: boolean; textScale: number; highContrast: boolean };
}

function Radio({ name, value, label, hint, checked }: { name: string; value: string; label: string; hint?: string; checked: boolean }) {
  const id = `${name}-${value}`;
  return (
    <div className="choice">
      <input type="radio" id={id} name={name} value={value} defaultChecked={checked} aria-describedby={hint ? `${id}-h` : undefined} />
      <label htmlFor={id}>{label}</label>
      {hint && (
        <p id={`${id}-h`} className="hint">
          {hint}
        </p>
      )}
    </div>
  );
}

type Answer = NonNullable<SaveState>;

/** What each field takes, shown under it when it is the one to fix. */
const RULE: Record<string, string> = {
  speechRate: 'Use a whole number from 50 to 250.',
  tops: 'Use 8 letters or numbers at most.',
  bottoms: 'Use 8 letters or numbers at most.',
  shoes: 'Use 8 letters or numbers at most.',
  avoidColours: 'Use 200 characters at most.',
  perOrderCap: 'Use an amount from 1 to 5,000 dollars.',
  dailyCap: 'Use an amount from 1 to 10,000 dollars, and at least the most for one order.',
};

/**
 * The number limits, checked here first so a mistake is caught at once, even offline, with the
 * same words the server uses. The server checks everything again when the form is saved.
 */
function checkNumbers(fd: FormData): Answer | null {
  const num = (k: string) => (String(fd.get(k) ?? '').trim() === '' ? NaN : Number(fd.get(k)));
  const ask = (field: string, what: string): Answer => ({
    ok: false,
    field,
    message: `Not saved. Please check ${what}, then press Save again. Your other changes are still here.`,
  });
  const rate = num('speechRate');
  if (!Number.isInteger(rate) || rate < 50 || rate > 250) return ask('speechRate', 'speech rate (50 to 250)');
  const perOrder = num('perOrderCap');
  if (!(perOrder >= 1 && perOrder <= 5000)) return ask('perOrderCap', 'most for one order (1 to 5,000 dollars)');
  const daily = num('dailyCap');
  if (!(daily >= 1 && daily <= 10000)) return ask('dailyCap', 'most in one day (1 to 10,000 dollars)');
  if (daily < perOrder)
    return { ok: false, field: 'dailyCap', message: 'Not saved. The most in one day must be at least the most for one order. Change one of them, then press Save again.' };
  return null;
}
const OFFLINE: Answer = { ok: false, message: "You're offline, so nothing was saved. Your changes are still here. Press Save again when you're back online." };
const FAILED: Answer = { ok: false, message: 'Something went wrong on our side, so nothing was saved. Your changes are still here. Press Save to try again.' };

export function SettingsForm({ initial, helperName }: { initial: Initial; helperName: string | null }) {
  // Without JavaScript the form posts to the server action and the page shows its answer. With
  // JavaScript, saving goes through onSubmit instead: React then does not reset the form after the
  // action, so a "Not saved" answer keeps every edit, and a dropped connection is caught here
  // instead of replacing the page.
  const [serverState, formAction, formPending] = useActionState<SaveState, FormData>(saveSettings, null);
  const [clientState, setClientState] = useState<SaveState>(null);
  const [saving, startSaving] = useTransition();
  const state = clientState ?? serverState;
  const pending = saving || formPending;
  const { announce, setOwnVoice } = useAnnouncer();
  const statusRef = useRef<HTMLParagraphElement>(null);
  const [sounds, setSounds] = useState(true);
  const [haptics, setHaptics] = useState(true);
  // iPhones and some other browsers have no vibration for web pages: say so rather than promise it.
  const [canVibrate, setCanVibrate] = useState(true);
  const [singleKeys, setSingleKeys] = useState(false);
  const [heardEcho, setHeardEcho] = useState(true);

  useEffect(() => {
    setCanVibrate(typeof navigator.vibrate === 'function');
    try {
      setHeardEcho(localStorage.getItem('sl-heard-echo') !== '0');
      setSounds(localStorage.getItem('sl-sounds') !== '0');
      setHaptics(localStorage.getItem('sl-haptics') !== '0');
      setSingleKeys(localStorage.getItem('sl-single-keys') === '1');
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (!state) return;
    const bad = !state.ok && state.field ? document.getElementById(state.field) : null;
    // When focus lands on the message itself it is read from focus, so it is not also sent live.
    announce(state.message, { politeness: state.ok ? 'polite' : 'assertive', source: 'settings', live: Boolean(bad) });
    if (bad) bad.focus();
    else statusRef.current?.focus();
  }, [state, announce]);

  const badField = state && !state.ok ? state.field : undefined;
  /** The field to fix is marked invalid and described by what it takes, shown under it. */
  const invalid = (name: string) => (badField === name ? { 'aria-invalid': true as const, 'aria-describedby': `${name}-err` } : {});
  const fieldError = (name: string) =>
    badField === name ? (
      <p id={`${name}-err`} className="field-error">
        <span aria-hidden="true">✕ </span>
        {RULE[name] ?? state?.message}
      </p>
    ) : null;

  const applyLocal = (fd: FormData) => {
    const mode = String(fd.get('voiceMode'));
    const rate = Number(fd.get('speechRate') ?? 100) / 100;
    setOwnVoice({ enabled: mode !== 'screen-reader', rate });
    const scale = Number(fd.get('textScale') ?? 1);
    const low = fd.get('lowVision') === 'on';
    try {
      // Text size is its own setting; low-vision mode adds the high-contrast theme.
      localStorage.setItem('sl-text-scale', String(scale));
      document.documentElement.style.setProperty('--text-scale', String(scale));
      if (low) {
        localStorage.setItem('sl-theme', 'contrast');
        document.documentElement.dataset.theme = 'contrast';
      } else if (localStorage.getItem('sl-theme') === 'contrast') {
        localStorage.removeItem('sl-theme');
        delete document.documentElement.dataset.theme;
      }
      localStorage.setItem('sl-sounds', fd.get('sounds') === 'on' ? '1' : '0');
      localStorage.setItem('sl-haptics', fd.get('haptics') === 'on' ? '1' : '0');
      localStorage.setItem('sl-single-keys', fd.get('singleKeys') === 'on' ? '1' : '0');
      localStorage.setItem('sl-heard-echo', fd.get('heardEcho') === 'on' ? '1' : '0');
    } catch {
      /* ignore */
    }
    setFeedback({ sounds: fd.get('sounds') === 'on', haptics: fd.get('haptics') === 'on' });
  };

  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending) return;
    const fd = new FormData(e.currentTarget);
    const wrong = checkNumbers(fd);
    if (wrong) {
      setClientState({ ...wrong });
      return;
    }
    if (!navigator.onLine) {
      setClientState({ ...OFFLINE });
      return;
    }
    startSaving(async () => {
      try {
        const result = await saveSettings(null, fd);
        // Local preferences (text size, theme, voice, sounds) change only once the save worked.
        if (result?.ok) applyLocal(fd);
        setClientState(result);
      } catch {
        setClientState({ ...(navigator.onLine ? FAILED : OFFLINE) });
      }
    });
  };

  return (
    // noValidate: the app's own message, under the field and in the status line, replaces the
    // browser's bubble, which screen readers and magnifiers often miss.
    <form action={formAction} className="settings" onSubmit={submit} aria-labelledby="prefs-h" aria-describedby="prefs-hint settings-status" noValidate>
      <div className="grid gap-2">
        <h2 id="prefs-h" className="settings-h">
          Preferences
        </h2>
        <p id="prefs-hint" className="hint">
          Everything from here to the Save settings button is saved together when you press it.
        </p>
      </div>
      <fieldset>
        <legend>How should I talk?</legend>
        <Radio name="verbosity" value="brief" label="Brief" hint="Just the facts. Colour, size, price and total are always included." checked={initial.verbosity === 'brief'} />
        <Radio name="verbosity" value="standard" label="Standard" checked={initial.verbosity === 'standard'} />
        <Radio name="verbosity" value="detailed" label="Detailed" hint="Adds material, care and fit." checked={initial.verbosity === 'detailed'} />
      </fieldset>

      <fieldset>
        <legend>Whose voice?</legend>
        <Radio name="voiceMode" value="screen-reader" label="My screen reader" hint="Recommended if you use one. Nothing extra is spoken." checked={initial.voiceMode === 'screen-reader'} />
        <Radio name="voiceMode" value="own-voice" label="The app's own voice" checked={initial.voiceMode === 'own-voice'} />
        <Radio name="voiceMode" value="both" label="Both" checked={initial.voiceMode === 'both'} />
        <div className="field">
          <label htmlFor="speechRate">Speech rate for the app's own voice, in percent</label>
          <input id="speechRate" name="speechRate" {...invalid('speechRate')} type="number" min={50} max={250} step={10} defaultValue={initial.speechRate} inputMode="numeric" />
          {fieldError('speechRate')}
        </div>
      </fieldset>

      <fieldset>
        <legend>When I listen</legend>
        <div className="choice">
          <input type="checkbox" id="heardEcho" name="heardEcho" checked={heardEcho} onChange={(e) => setHeardEcho(e.target.checked)} aria-describedby="heardEcho-h" />
          <label htmlFor="heardEcho">Say what I heard before I answer</label>
          <p id="heardEcho-h" className="hint">
            When you talk, I first say “I heard” and your words, so you can catch a word I got wrong. On by default.
          </p>
        </div>
      </fieldset>

      <fieldset>
        <legend>My sizes</legend>
        <p className="hint">Used when you don't say a size. You can always say a different one.</p>
        <div className="field-row">
          <div className="field">
            <label htmlFor="tops">Tops</label>
            <input id="tops" name="tops" {...invalid('tops')} type="text" defaultValue={initial.sizes.tops ?? ''} autoComplete="off" />
            {fieldError('tops')}
          </div>
          <div className="field">
            <label htmlFor="bottoms">Bottoms</label>
            <input id="bottoms" name="bottoms" {...invalid('bottoms')} type="text" defaultValue={initial.sizes.bottoms ?? ''} autoComplete="off" />
            {fieldError('bottoms')}
          </div>
          <div className="field">
            <label htmlFor="shoes">Shoes</label>
            <input id="shoes" name="shoes" {...invalid('shoes')} type="text" defaultValue={initial.sizes.shoes ?? ''} autoComplete="off" />
            {fieldError('shoes')}
          </div>
        </div>
        <div className="field">
          <label htmlFor="avoidColours">Colours to avoid, separated by commas</label>
          <input id="avoidColours" name="avoidColours" {...invalid('avoidColours')} type="text" defaultValue={initial.avoidColours} autoComplete="off" />
          {fieldError('avoidColours')}
        </div>
      </fieldset>

      <fieldset>
        <legend>Spending limits</legend>
        <p className="hint">I refuse any payment over these limits, even if you confirm. Amounts in US dollars.</p>
        <div className="field-row">
          <div className="field">
            <label htmlFor="perOrderCap">Most for one order</label>
            <input id="perOrderCap" name="perOrderCap" {...invalid('perOrderCap')} type="number" min={1} step={1} defaultValue={initial.perOrderCap} inputMode="decimal" />
            {fieldError('perOrderCap')}
          </div>
          <div className="field">
            <label htmlFor="dailyCap">Most in one day</label>
            <input id="dailyCap" name="dailyCap" {...invalid('dailyCap')} type="number" min={1} step={1} defaultValue={initial.dailyCap} inputMode="decimal" />
            {fieldError('dailyCap')}
          </div>
        </div>
        <div className="choice">
          <input type="checkbox" id="payAfterCheck" name="payAfterCheck" defaultChecked={initial.payAfterCheck} aria-describedby="pac-h" />
          <label htmlFor="payAfterCheck">Pay after I check</label>
          <p id="pac-h" className="hint">
            With stores that allow it, PayPal only holds the money until your camera check matches.
          </p>
        </div>
      </fieldset>

      <fieldset>
        <legend>Seeing the screen</legend>
        <div className="choice">
          <input type="checkbox" id="lowVision" name="lowVision" defaultChecked={initial.lowVision.enabled} aria-describedby="lv-h" />
          <label htmlFor="lowVision">Low-vision mode</label>
          <p id="lv-h" className="hint">
            Yellow on black, larger text, larger targets.
          </p>
        </div>
        <div className="field">
          <label htmlFor="textScale">Text size (works with or without low-vision mode)</label>
          <select id="textScale" name="textScale" defaultValue={String(initial.lowVision.textScale)}>
            <option value="1">Normal</option>
            <option value="1.25">Large</option>
            <option value="1.5">Larger</option>
            <option value="2">Largest</option>
          </select>
        </div>
      </fieldset>

      <fieldset>
        <legend>Sounds and vibration</legend>
        <div className="choice">
          <input type="checkbox" id="sounds" name="sounds" checked={sounds} onChange={(e) => setSounds(e.target.checked)} />
          <label htmlFor="sounds">Short sounds for listening, done and attention</label>
        </div>
        <div className="choice">
          <input
            type="checkbox"
            id="haptics"
            name="haptics"
            checked={haptics}
            onChange={(e) => setHaptics(e.target.checked)}
            aria-describedby={canVibrate ? undefined : 'haptics-h'}
          />
          <label htmlFor="haptics">Vibration on phones that support it</label>
          {!canVibrate && (
            <p id="haptics-h" className="hint">
              This browser can’t make the phone vibrate, so you won’t feel anything. The sounds and spoken guidance still work.
            </p>
          )}
        </div>
      </fieldset>

      <fieldset>
        <legend>Keyboard</legend>
        <div className="choice">
          <input type="checkbox" id="singleKeys" name="singleKeys" checked={singleKeys} onChange={(e) => setSingleKeys(e.target.checked)} aria-describedby="sk-h" />
          <label htmlFor="singleKeys">Single-key shortcuts</label>
          <p id="sk-h" className="hint">
            Off by default so they never clash with your screen reader. When off, hold Alt and Shift (Option and Shift on a Mac) with the key.
          </p>
        </div>
      </fieldset>

      <fieldset>
        <legend>Trusted helper</legend>
        <p>
          {helperName
            ? `${helperName} can look at photos when I'm not sure, through a private link. They never see payment details and can't move money.`
            : 'No helper yet.'}
        </p>
      </fieldset>

      <div className="grid gap-3">
        <button type="submit" className="btn btn-primary btn-xl" disabled={pending}>
          {pending ? 'Saving…' : 'Save settings'}
        </button>
        <p id="settings-status" ref={statusRef} tabIndex={-1} className={state ? (state.ok ? 'mb-result' : 'card-refusal') : 'sr-only'}>
          {state?.message ?? ''}
        </p>
      </div>
    </form>
  );
}
