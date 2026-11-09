'use client';

import { useEffect, useRef, useState } from 'react';
import { spokenWhen } from '@/lib/when';
import type { AgentProposalView, MerchantCase } from '@/server/merchant';

export type AgentAct = { do: 'ask' } | { do: 'dismiss'; proposalId: string } | { do: 'send'; proposalId: string; confirm: true } | { do: 'change'; proposalId: string; optionId: string; confirm: true };

const STATUS_WORDS: Record<string, string> = {
  sent: 'Sent',
  dismissed: 'Set aside by staff',
  superseded: 'Replaced by a staff reply',
  failed: 'Stopped',
  handed_over: 'Handed to staff',
  sending: 'Sending',
};

/** What sending a reply does, said before it is sent. Amounts are the ones code computed. */
function sendCopy(c: MerchantCase, optionId: string | null, title: string | null, amount: string | null): { title: string; body: string; yes: string } {
  const t = title ?? 'this reply';
  switch (optionId) {
    case 'refund':
      return c.refundPath === 'void' && !c.dispute
        ? { title: `Release ${c.buyer}’s ${c.amount} hold?`, body: `PayPal releases the hold now, so Demo Store is never paid, and the case closes. This cannot be undone.`, yes: `Yes, release ${c.amount}` }
        : { title: `Refund ${c.amount} to ${c.buyer}?`, body: `PayPal sends ${c.amount} back to ${c.buyer} and the case closes. This cannot be undone.`, yes: `Yes, refund ${c.amount}` };
    case 'replacement':
      return { title: `Offer ${c.buyer} a replacement?`, body: `${c.buyer} hears the offer with your agent’s reasons. Nothing changes until ${c.buyer} answers.`, yes: 'Yes, offer a replacement' };
    case 'return':
      return { title: `Ask ${c.buyer} for the item back first?`, body: `${c.buyer} hears the offer with your agent’s reasons. Nothing changes until ${c.buyer} answers.`, yes: 'Yes, ask for it back' };
    case 'partial_20':
    case 'partial_50':
      return {
        title: `Offer ${c.buyer} ${amount} back to keep the ${c.item}?`,
        body: `${c.buyer} hears the offer with your agent’s reasons. No money moves unless ${c.buyer} accepts; then PayPal ${c.refundPath === 'void' ? 'takes only the rest of the hold' : `refunds ${amount}`}.`,
        yes: `Yes, offer ${amount} back`,
      };
    default:
      return { title: `Send “${t}”?`, body: `Nothing changes until ${c.buyer} answers.`, yes: 'Yes, send it' };
  }
}

/**
 * The store's agent on one case: what it proposed and why, for Send, Change or Dismiss; or that it
 * handed the case over; or a button to ask it. Every send asks to confirm first, and code decides
 * again on send whether the reply is allowed and for how much.
 */
export function AgentProposal({ c, h, busy, anyBusy, onAct }: { c: MerchantCase; h: string; busy: boolean; anyBusy: boolean; onAct: (a: AgentAct) => Promise<void> }) {
  const a = c.agent;
  const p = a.pending;
  const [mode, setMode] = useState<'idle' | 'confirm' | 'change'>('idle');
  const [choice, setChoice] = useState<string | null>(null);
  const confirmRef = useRef<HTMLHeadingElement>(null);
  const changeRef = useRef<HTMLLegendElement>(null);
  const sendRef = useRef<HTMLButtonElement>(null);
  const changeBtnRef = useRef<HTMLButtonElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const changed = choice && choice !== p?.optionId ? a.choices.find((x) => x.id === choice) : null;

  useEffect(() => {
    if (mode === 'confirm') confirmRef.current?.focus();
    if (mode === 'change') changeRef.current?.focus();
  }, [mode]);

  // Escape closes the open question or the choices and returns focus to the button that opened it.
  useEffect(() => {
    const box = boxRef.current;
    if (mode === 'idle' || !box) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || busy) return;
      e.preventDefault();
      e.stopPropagation();
      back();
    };
    box.addEventListener('keydown', onKey);
    return () => box.removeEventListener('keydown', onKey);
  });

  const back = () => {
    const from = changed || mode === 'change' ? changeBtnRef : sendRef;
    setMode('idle');
    setChoice(null);
    requestAnimationFrame(() => from.current?.focus());
  };

  if (!c.open) return null;

  if (a.thinking)
    return (
      <div className="mx-suggest mx-agent">
        <p className="mx-suggest-tag">Your store agent</p>
        <h4 id={`${h}-ag`} className="mx-suggest-h">
          Reading this case now
        </h4>
        <p>It reads the signed evidence and your policy, then proposes a reply here. Reload the page in a few seconds to see it.</p>
      </div>
    );

  if (!p)
    return a.handedOver ? (
      <div className="mx-suggest mx-agent">
        <p className="mx-suggest-tag">Your store agent</p>
        <h4 id={`${h}-ag`} className="mx-suggest-h">
          Handed to you
        </h4>
        <p>{a.handedOver} Reply with the buttons below.</p>
      </div>
    ) : a.canAsk ? (
      <div className="mx-agent-ask">
        <button type="button" className="btn mx-btn" aria-disabled={anyBusy || undefined} aria-describedby={`${h}-tab`} onClick={() => !anyBusy && void onAct({ do: 'ask' })}>
          {busy ? 'Your store agent is reading the case…' : 'Ask your store agent to propose a reply'}
        </button>
      </div>
    ) : null;

  const shown = changed ?? { id: p.optionId ?? '', title: p.title ?? '', means: '' };
  const confirm = mode === 'confirm' ? sendCopy(c, shown.id, shown.title, changed ? null : p.amount) : null;
  const others = a.choices.filter((x) => x.id !== p.optionId);

  return (
    <div ref={boxRef} className="mx-suggest mx-agent" role="group" aria-labelledby={`${h}-ag`}>
      <p className="mx-suggest-tag">Proposed by your store agent · waiting for you</p>
      <h4 id={`${h}-ag`} className="mx-suggest-h">
        {p.title}
      </h4>
      {p.reasons.length > 0 && (
        <>
          <p className="mx-agent-why-h">{`Why, as ${c.buyer} will hear it:`}</p>
          <ul className="mx-history">
            {p.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </>
      )}
      {p.staffNote && <p>{p.staffNote}</p>}
      <p>
        {p.source === 'model' ? 'Claude chose this among the replies your policy allows; code checked every reason against the evidence.' : 'Your store rules chose this.'}{' '}
        {p.staffWhy ? `It waits for you because: ${p.staffWhy}` : ''}
      </p>
      {p.checkNotes.length > 0 && (
        <details className="tech">
          <summary>
            <span className="tech-marker" aria-hidden="true" />
            What the check set aside
          </summary>
          <ul className="mx-history">
            {p.checkNotes.map((n, i) => (
              <li key={i}>{n.text ? `“${n.text}”: ${n.why}.` : n.why}</li>
            ))}
          </ul>
        </details>
      )}
      {p.result && <p className="mx-demo-note">Last try: {p.result}</p>}

      {mode === 'idle' && (
        <div className="mx-reply-actions">
          <button ref={sendRef} type="button" className="btn btn-primary mx-btn" aria-disabled={anyBusy || undefined} onClick={() => !anyBusy && setMode('confirm')}>
            Send{' '}<span className="sr-only">the proposal: {p.title}</span>
          </button>
          {others.length > 0 && (
            <button ref={changeBtnRef} type="button" className="btn mx-btn" aria-disabled={anyBusy || undefined} onClick={() => !anyBusy && setMode('change')}>
              Change{' '}<span className="sr-only">to another reply</span>
            </button>
          )}
          <button type="button" className="btn mx-btn" aria-disabled={anyBusy || undefined} onClick={() => !anyBusy && void onAct({ do: 'dismiss', proposalId: p.id })}>
            Dismiss{' '}<span className="sr-only">the proposal; nothing is sent</span>
          </button>
        </div>
      )}

      {mode === 'change' && (
        <fieldset className="mx-confirm">
          <legend ref={changeRef} tabIndex={-1} className="mx-confirm-h">
            Choose another reply
          </legend>
          {others.map((x) => (
            <div key={x.id} className="choice">
              <input type="radio" id={`${h}-opt-${x.id}`} name={`${h}-opt`} value={x.id} checked={choice === x.id} onChange={() => setChoice(x.id)} aria-describedby={`${h}-opt-${x.id}-h`} />
              <label htmlFor={`${h}-opt-${x.id}`}>{x.title}</label>
              <p id={`${h}-opt-${x.id}-h`} className="hint">
                {x.means}
              </p>
            </div>
          ))}
          <div className="mx-confirm-actions">
            <button type="button" className="btn btn-primary mx-btn" aria-disabled={!choice || undefined} onClick={() => choice && setMode('confirm')}>
              Send this instead
            </button>
            <button type="button" className="btn mx-btn" onClick={back}>
              Cancel
            </button>
          </div>
        </fieldset>
      )}

      {confirm && (
        <div className="mx-confirm" role="group" aria-labelledby={`${h}-ag-confirm`}>
          <h5 id={`${h}-ag-confirm`} ref={confirmRef} tabIndex={-1} className="mx-confirm-h">
            {confirm.title}
          </h5>
          <p>{confirm.body}</p>
          <div className="mx-confirm-actions">
            <button
              type="button"
              className="btn btn-primary mx-btn"
              aria-disabled={busy || undefined}
              onClick={async () => {
                if (busy) return;
                await onAct(changed ? { do: 'change', proposalId: p.id, optionId: changed.id, confirm: true } : { do: 'send', proposalId: p.id, confirm: true });
                setMode('idle');
                setChoice(null);
              }}
            >
              {busy ? 'Sending…' : confirm.yes}
            </button>
            <button type="button" className="btn mx-btn" aria-disabled={busy || undefined} onClick={() => !busy && back()}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** What the store's agent did on a case, for the case's history. */
export function agentHistoryLine(p: AgentProposalView, buyer: string): string {
  const what = p.status === 'handed_over' ? (p.result ?? 'Handed the case to staff.') : `${STATUS_WORDS[p.status] ?? p.status}: ${p.title ?? 'a reply'}.`;
  const who = p.decidedBy === 'store_agent' && p.status === 'sent' ? ' Sent by your store agent, inside your policy.' : p.decidedBy === 'staff' && p.status === 'sent' ? ' Sent by staff.' : '';
  const why = p.reasons.length && p.status === 'sent' ? ` ${buyer} heard why: ${p.reasons.join(' ')}` : '';
  return `${spokenWhen(p.decidedAt ?? p.createdAt)} · Your store agent. ${what}${who}${why}`;
}
