'use client';

import { useActionState, useEffect, useRef, useState, useTransition } from 'react';
import { useAnnouncer } from '@/components/a11y/announcer';
import { savePolicyAction, type PolicyState } from './actions';

interface Initial {
  agentOn: boolean;
  autoSend: boolean;
  autoReplaceMax: number;
  askStaffAbove: number;
  partialRefunds: 'none' | 'up_to_20' | 'up_to_50';
}

const RULE: Record<string, string> = {
  autoReplaceMax: 'Use an amount from 0 to 5,000 dollars.',
  askStaffAbove: 'Use an amount from 0 to 5,000 dollars.',
};

function check(fd: FormData): PolicyState {
  for (const [field, what] of [
    ['autoReplaceMax', 'the replacement limit (0 to 5,000 dollars)'],
    ['askStaffAbove', 'the staff limit (0 to 5,000 dollars)'],
  ] as const) {
    const raw = String(fd.get(field) ?? '').trim();
    const n = raw === '' ? NaN : Number(raw);
    if (!(n >= 0 && n <= 5000)) return { ok: false, field, message: `Not saved. Please check ${what}, then press Save again. Your other changes are still here.` };
  }
  return null;
}

/**
 * The store's case policy. Code reads it on every case: what the store's agent may send without
 * staff, and which part refunds exist at all. The model never sees an amount it could change.
 */
export function PolicyForm({ initial }: { initial: Initial }) {
  const [serverState, formAction] = useActionState<PolicyState, FormData>(savePolicyAction, null);
  const [clientState, setClientState] = useState<PolicyState>(null);
  const [saving, startSaving] = useTransition();
  const state = clientState ?? serverState;
  const { announce } = useAnnouncer();
  const statusRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (!state) return;
    const bad = !state.ok && state.field ? document.getElementById(state.field) : null;
    announce(state.message, { politeness: state.ok ? 'polite' : 'assertive', source: 'Demo Store', live: Boolean(bad) });
    if (bad) bad.focus();
    else statusRef.current?.focus();
  }, [state, announce]);

  const badField = state && !state.ok ? state.field : undefined;
  const invalid = (name: string) => (badField === name ? { 'aria-invalid': true as const, 'aria-describedby': `${name}-err ${name}-h` } : { 'aria-describedby': `${name}-h` });
  const fieldError = (name: string) =>
    badField === name ? (
      <p id={`${name}-err`} className="field-error">
        <span aria-hidden="true">✕ </span>
        {RULE[name] ?? state?.message}
      </p>
    ) : null;

  return (
    <form
      action={formAction}
      className="settings"
      aria-labelledby="policy-h"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (saving) return;
        const fd = new FormData(e.currentTarget);
        const wrong = check(fd);
        if (wrong) return setClientState({ ...wrong });
        startSaving(async () => {
          try {
            setClientState(await savePolicyAction(null, fd));
          } catch {
            setClientState({ ok: false, message: 'Something went wrong on our side, so nothing was saved. Your changes are still here. Press Save to try again.' });
          }
        });
      }}
    >
      <h2 id="policy-h" className="settings-h">
        Your store agent’s policy
      </h2>

      <fieldset>
        <legend>The agent</legend>
        <div className="choice">
          <input type="checkbox" id="agentOn" name="agentOn" defaultChecked={initial.agentOn} aria-describedby="agentOn-h" />
          <label htmlFor="agentOn">Let the store agent read each new case and propose a reply</label>
          <p id="agentOn-h" className="hint">
            Off: every case waits for staff, with the rule-based suggestion only.
          </p>
        </div>
        <div className="choice">
          <input type="checkbox" id="autoSend" name="autoSend" defaultChecked={initial.autoSend} aria-describedby="autoSend-h" />
          <label htmlFor="autoSend">Send a reply without asking staff when it is inside the limits below</label>
          <p id="autoSend-h" className="hint">
            Off: the agent only proposes, and staff press Send. A full refund goes out on its own only when the check is sure or your shipping record shows the
            mistake.
          </p>
        </div>
      </fieldset>

      <fieldset>
        <legend>Limits, in US dollars</legend>
        <div className="field-row">
          <div className="field">
            <label htmlFor="autoReplaceMax">Send a replacement on its own for a wrong size or colour up to</label>
            <input id="autoReplaceMax" name="autoReplaceMax" {...invalid('autoReplaceMax')} type="number" min={0} max={5000} step={1} defaultValue={initial.autoReplaceMax} inputMode="decimal" />
            <p id="autoReplaceMax-h" className="hint">
              The order amount, tax and shipping included.
            </p>
            {fieldError('autoReplaceMax')}
          </div>
          <div className="field">
            <label htmlFor="askStaffAbove">Always ask staff for orders over</label>
            <input id="askStaffAbove" name="askStaffAbove" {...invalid('askStaffAbove')} type="number" min={0} max={5000} step={1} defaultValue={initial.askStaffAbove} inputMode="decimal" />
            <p id="askStaffAbove-h" className="hint">
              Above this, every reply waits for staff, whatever it is.
            </p>
            {fieldError('askStaffAbove')}
          </div>
        </div>
      </fieldset>

      <fieldset>
        <legend>Keep it for less: part of the price back, and the buyer keeps the item</legend>
        {(
          [
            ['none', 'Not allowed', 'The agent never offers part of the price back.'],
            ['up_to_20', 'Up to 20 percent of the price', 'The agent may offer 20 percent back.'],
            ['up_to_50', 'Up to half the price', 'The agent may offer 20 percent or half back.'],
          ] as const
        ).map(([value, label, hint]) => (
          <div key={value} className="choice">
            <input type="radio" id={`partial-${value}`} name="partialRefunds" value={value} defaultChecked={initial.partialRefunds === value} aria-describedby={`partial-${value}-h`} />
            <label htmlFor={`partial-${value}`}>{label}</label>
            <p id={`partial-${value}-h`} className="hint">
              {hint} The amount is worked out from the order, to the cent. On a held payment PayPal takes only the rest and releases the part.
            </p>
          </div>
        ))}
      </fieldset>

      <p>
        <button type="submit" className="btn btn-primary btn-xl" aria-disabled={saving || undefined}>
          {saving ? 'Saving…' : 'Save the policy'}
        </button>
      </p>
      <p className="hint">Changes apply to the next case the agent reads. You can change them back here at any time.</p>
      <p id="policy-status" ref={statusRef} tabIndex={-1} className={state ? (state.ok ? 'mb-result' : 'card-refusal') : 'sr-only'}>
        {state?.message ?? ''}
      </p>
    </form>
  );
}
