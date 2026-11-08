'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
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

export function SettingsForm({ initial, helperName }: { initial: Initial; helperName: string | null }) {
  const [state, action, pending] = useActionState<SaveState, FormData>(saveSettings, null);
  const { announce, setOwnVoice } = useAnnouncer();
  const statusRef = useRef<HTMLParagraphElement>(null);
  const [sounds, setSounds] = useState(true);
  const [haptics, setHaptics] = useState(true);
  const [singleKeys, setSingleKeys] = useState(false);

  useEffect(() => {
    try {
      setSounds(localStorage.getItem('sl-sounds') !== '0');
      setHaptics(localStorage.getItem('sl-haptics') !== '0');
      setSingleKeys(localStorage.getItem('sl-single-keys') === '1');
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (!state) return;
    announce(state.message, { politeness: state.ok ? 'polite' : 'assertive', source: 'settings' });
    const bad = state.field ? document.getElementById(state.field) : null;
    if (!state.ok && bad) bad.focus();
    else statusRef.current?.focus();
  }, [state, announce]);

  const invalid = (name: string) => (state && !state.ok && state.field === name ? { 'aria-invalid': true as const, 'aria-errormessage': 'settings-status' } : {});

  const applyLocal = (form: HTMLFormElement) => {
    const fd = new FormData(form);
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
    } catch {
      /* ignore */
    }
    setFeedback({ sounds: fd.get('sounds') === 'on', haptics: fd.get('haptics') === 'on' });
  };

  return (
    <form
      action={action}
      className="settings"
      onSubmit={(e) => applyLocal(e.currentTarget)}
      aria-describedby="settings-status"
    >
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
        </div>
      </fieldset>

      <fieldset>
        <legend>My sizes</legend>
        <p className="hint">Used when you don't say a size. You can always say a different one.</p>
        <div className="field-row">
          <div className="field">
            <label htmlFor="tops">Tops</label>
            <input id="tops" name="tops" {...invalid('tops')} type="text" defaultValue={initial.sizes.tops ?? ''} autoComplete="off" />
          </div>
          <div className="field">
            <label htmlFor="bottoms">Bottoms</label>
            <input id="bottoms" name="bottoms" {...invalid('bottoms')} type="text" defaultValue={initial.sizes.bottoms ?? ''} autoComplete="off" />
          </div>
          <div className="field">
            <label htmlFor="shoes">Shoes</label>
            <input id="shoes" name="shoes" {...invalid('shoes')} type="text" defaultValue={initial.sizes.shoes ?? ''} autoComplete="off" />
          </div>
        </div>
        <div className="field">
          <label htmlFor="avoidColours">Colours to avoid, separated by commas</label>
          <input id="avoidColours" name="avoidColours" {...invalid('avoidColours')} type="text" defaultValue={initial.avoidColours} autoComplete="off" />
        </div>
      </fieldset>

      <fieldset>
        <legend>Spending limits</legend>
        <p className="hint">I refuse any payment over these limits, even if you confirm. Amounts in US dollars.</p>
        <div className="field-row">
          <div className="field">
            <label htmlFor="perOrderCap">Most for one order</label>
            <input id="perOrderCap" name="perOrderCap" {...invalid('perOrderCap')} type="number" min={1} step={1} defaultValue={initial.perOrderCap} inputMode="decimal" />
          </div>
          <div className="field">
            <label htmlFor="dailyCap">Most in one day</label>
            <input id="dailyCap" name="dailyCap" {...invalid('dailyCap')} type="number" min={1} step={1} defaultValue={initial.dailyCap} inputMode="decimal" />
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
          <input type="checkbox" id="haptics" name="haptics" checked={haptics} onChange={(e) => setHaptics(e.target.checked)} />
          <label htmlFor="haptics">Vibration on phones that support it</label>
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
