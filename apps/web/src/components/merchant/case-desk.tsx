'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Fragment, useEffect, useRef, useState } from 'react';
import { useAnnouncer } from '@/components/a11y/announcer';
import type { CaseAction, MerchantCase, MerchantResult } from '@/server/merchant';
import { StatusChip } from './status-chip';

const OFFER_WORDS: Record<string, string> = {
  REFUND: 'Refund',
  REFUND_WITH_RETURN: 'Refund after the item is returned',
  REFUND_WITH_REPLACEMENT: 'Refund with a replacement',
  REPLACEMENT_WITHOUT_REFUND: 'Replacement',
  PARTIAL_REFUND: 'Partial refund',
  REFUND_WITH_RETURN_SHIPMENT_LABEL: 'Refund with a return label',
};

const ACTIONS: { action: CaseAction; label: string }[] = [
  { action: 'refund', label: 'Refund in full' },
  { action: 'replacement', label: 'Offer a replacement' },
  { action: 'return', label: 'Ask for the item back first' },
  { action: 'no_response', label: "Don't respond (let it escalate)" },
];

const SUGGESTED_ACTION: Record<string, CaseAction | undefined> = { refund: 'refund' };

function confirmCopy(c: MerchantCase, a: CaseAction): { title: string; body: string; yes: string } {
  switch (a) {
    case 'refund':
      if (c.dispute)
        return {
          title: `Accept ${c.buyer}'s claim and refund ${c.amount}?`,
          body: `PayPal accepts the claim on dispute ${c.dispute.id} and refunds ${c.amount}. This cannot be undone.`,
          yes: `Yes, refund ${c.amount}`,
        };
      if (c.refundPath === 'void')
        return {
          title: `Release ${c.buyer}'s ${c.amount} hold?`,
          body: `PayPal releases the payment hold. Demo Store is never paid, and the case closes. This cannot be undone.`,
          yes: `Yes, release ${c.amount}`,
        };
      return {
        title: `Refund ${c.amount} to ${c.buyer}?`,
        body: `PayPal sends ${c.amount} back to ${c.buyer}'s PayPal account and the case closes. This cannot be undone.`,
        yes: `Yes, refund ${c.amount}`,
      };
    case 'replacement':
      return {
        title: `Offer ${c.buyer} a replacement?`,
        body: `${c.buyer} is offered a new ${c.item} at no cost. Nothing changes until ${c.buyer} answers.`,
        yes: 'Yes, offer a replacement',
      };
    case 'return':
      return {
        title: `Ask ${c.buyer} for the item back first?`,
        body: `${c.buyer} is asked to send the ${c.item} back. Demo Store refunds ${c.amount} when it arrives. Nothing changes until ${c.buyer} answers.`,
        yes: 'Yes, ask for it back',
      };
    default:
      return {
        title: `Leave case ${c.ref} without a reply?`,
        body: `Nothing is sent. The case stays open${c.dueWords ? `, and after the deadline ${c.buyer} can ask PayPal to step in` : ''}.`,
        yes: "Yes, don't respond",
      };
  }
}

interface Result {
  ok: boolean;
  message: string;
}

export function CaseDesk({ cases }: { cases: MerchantCase[] }) {
  const router = useRouter();
  const { announce } = useAnnouncer();
  const [results, setResults] = useState<Record<string, Result>>({});
  const [focusId, setFocusId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const open = cases.filter((c) => c.open);
  const closed = cases.filter((c) => !c.open);

  const respond = async (c: MerchantCase, action: CaseAction) => {
    setBusy(c.id);
    let r: Result;
    try {
      const res = await fetch(`/api/merchant/cases/${c.id}/respond`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, confirm: true }),
      });
      const data = (await res.json().catch(() => null)) as MerchantResult | null;
      r = {
        ok: res.ok && Boolean(data?.ok),
        message: data?.message ?? 'Something went wrong. Nothing was sent.',
      };
    } catch {
      r = { ok: false, message: 'The console could not reach the server. Nothing was sent. Try again.' };
    }
    setResults((m) => ({ ...m, [c.id]: r }));
    setFocusId(c.id);
    announce(r.message, { politeness: r.ok ? 'polite' : 'assertive', source: 'Demo Store' });
    setBusy(null);
    router.refresh();
  };

  const card = (c: MerchantCase) => (
    <CaseCard
      key={c.id}
      c={c}
      busy={busy === c.id}
      anyBusy={busy !== null}
      result={results[c.id] ?? null}
      focusResult={focusId === c.id}
      onFocused={() => setFocusId(null)}
      onRespond={(a) => respond(c, a)}
    />
  );

  return (
    <div className="mx-cases">
      <section aria-labelledby="open-h" className="mx-case-group">
        <h2 id="open-h" className="mx-h2">
          Open <span className="mx-h2-n">{open.length}</span>
        </h2>
        {open.length ? (
          <ol className="mx-case-list">{open.map(card)}</ol>
        ) : (
          <p className="mx-empty">
            No open cases. When a buyer&rsquo;s check finds a problem and they send it, the case lands here
            with their evidence.
          </p>
        )}
      </section>
      {closed.length > 0 && (
        <section aria-labelledby="closed-h" className="mx-case-group">
          <h2 id="closed-h" className="mx-h2">
            Closed <span className="mx-h2-n">{closed.length}</span>
          </h2>
          <ol className="mx-case-list">{closed.map(card)}</ol>
        </section>
      )}
    </div>
  );
}

function CaseCard({
  c,
  busy,
  anyBusy,
  result,
  focusResult,
  onFocused,
  onRespond,
}: {
  c: MerchantCase;
  busy: boolean;
  anyBusy: boolean;
  result: Result | null;
  focusResult: boolean;
  onFocused: () => void;
  onRespond: (a: CaseAction) => Promise<void>;
}) {
  const [pending, setPending] = useState<CaseAction | null>(null);
  const confirmRef = useRef<HTMLHeadingElement>(null);
  const resultRef = useRef<HTMLParagraphElement>(null);
  const triggerRefs = useRef<Partial<Record<CaseAction, HTMLButtonElement | null>>>({});
  const h = `case-${c.id}-h`;
  const suggested = SUGGESTED_ACTION[c.suggestion.action];

  useEffect(() => {
    if (pending) confirmRef.current?.focus();
  }, [pending]);

  useEffect(() => {
    if (focusResult && result) {
      resultRef.current?.focus();
      onFocused();
    }
  }, [focusResult, result, onFocused]);

  const cancel = () => {
    const a = pending;
    setPending(null);
    if (a) requestAnimationFrame(() => triggerRefs.current[a]?.focus());
  };

  const confirm = pending ? confirmCopy(c, pending) : null;
  const refundBlocked = !c.dispute && c.refundPath === 'none';

  return (
    <li id={`case-${c.id}`} className="mx-case" data-open={c.open || undefined}>
      <article aria-labelledby={h}>
        <p id={`${h}-tab`} className="mx-case-tab">
          Case #{c.ref} · Order #{c.orderRef}
        </p>
        <div className="mx-case-box">
          <header className="mx-case-head">
            <h3 id={h} className="mx-case-h">
              {c.title}
            </h3>
            <ul className="mx-case-meta" aria-label="Case status">
              <li>
                <StatusChip s={c.status} />
              </li>
              {c.dueWords && (
                <li>
                  <StatusChip
                    s={{
                      word: c.dueWords,
                      glyph: c.overdue ? '!' : '…',
                      tone: c.overdue ? 'bad' : 'waiting',
                    }}
                  />
                </li>
              )}
              <li>
                <StatusChip
                  s={{
                    word: `${c.amount} · ${c.payment.word}`,
                    glyph: c.payment.glyph,
                    tone: c.payment.tone,
                  }}
                />
              </li>
            </ul>
          </header>

          <div className="mx-case-body">
            <div className="mx-case-evidence">
              <div className="mx-block">
                <h4 id={`${h}-heard`} className="mx-h4">
                  What {c.buyer} heard before paying
                </h4>
                {c.readbackText ? (
                  <blockquote className="mx-readback">
                    <p>{c.readbackText}</p>
                  </blockquote>
                ) : (
                  <p className="muted">The readback was not found.</p>
                )}
              </div>

              <div className="mx-block">
                <h4 id={`${h}-found`} className="mx-h4">
                  What the check found
                </h4>
                {c.verdict ? (
                  <>
                    <p className="mx-verdict" data-kind={c.verdict.kind}>
                      <StatusChip s={c.verdict.word} />
                    </p>
                    {c.verdict.reasons.length > 0 && (
                      <table className="verdict-table mx-reasons">
                        <caption className="sr-only">
                          Each check, its result, what it found and how sure it is
                        </caption>
                        <thead>
                          <tr>
                            <th scope="col">Check</th>
                            <th scope="col">Result</th>
                            <th scope="col">What it found</th>
                            <th scope="col">How sure</th>
                          </tr>
                        </thead>
                        <tbody>
                          {c.verdict.reasons.map((r, i) => (
                            <tr key={`${r.module}-${i}`} data-finding={r.finding}>
                              <th scope="row">{r.label}</th>
                              <td>
                                <span className="mx-finding">
                                  <span className="verdict-mark" data-finding={r.finding} aria-hidden="true">
                                    {r.result.glyph}
                                  </span>
                                  {r.result.word}
                                </span>
                              </td>
                              <td>{r.text}</td>
                              <td>{r.confidence}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </>
                ) : (
                  <p>{c.buyer} has not checked the parcel with the camera.</p>
                )}
                {c.shippingRecord && (
                  <p className="mx-records">Demo Store&rsquo;s shipping record: {c.shippingRecord}</p>
                )}
                {c.evidencePackId && (
                  <p>
                    <Link href={`/evidence/${c.evidencePackId}`} className="mx-evidence-link">
                      Open the signed evidence pack<span className="sr-only"> for case {c.ref}</span>
                    </Link>
                  </p>
                )}
              </div>

              {c.dispute && (
                <div className="mx-block mx-dispute">
                  <h4 id={`${h}-pp`} className="mx-h4">
                    PayPal dispute <span className="mono">{c.dispute.id}</span>
                  </h4>
                  {c.dispute.error ? (
                    <p>{c.dispute.error}</p>
                  ) : (
                    <dl className="mx-facts">
                      <div>
                        <dt>State</dt>
                        <dd>
                          {(c.dispute.state ?? c.dispute.status ?? 'Unknown')
                            .replace(/_/g, ' ')
                            .toLowerCase()}
                        </dd>
                      </div>
                      <div>
                        <dt>Offers PayPal allows</dt>
                        <dd>
                          {c.dispute.makeOffer.length
                            ? c.dispute.makeOffer.map((t) => OFFER_WORDS[t] ?? t).join(', ')
                            : 'None right now'}
                        </dd>
                      </div>
                      <div>
                        <dt>Accepting the claim</dt>
                        <dd>
                          {c.dispute.acceptClaim.length
                            ? c.dispute.acceptClaim.map((t) => OFFER_WORDS[t] ?? t).join(', ')
                            : c.dispute.actions.some((a) => /accept/i.test(a))
                              ? 'Allowed'
                              : 'Not allowed right now'}
                        </dd>
                      </div>
                    </dl>
                  )}
                </div>
              )}

              {(c.offers.length > 0 || c.outcome) && (
                <div className="mx-block">
                  <h4 id={`${h}-hist`} className="mx-h4">
                    What Demo Store has done
                  </h4>
                  <ul className="mx-history">
                    {c.offers.map((o) => (
                      <li key={o.id}>
                        <span className="mono">
                          {new Date(o.at).toLocaleString('en-US', {
                            dateStyle: 'medium',
                            timeStyle: 'short',
                          })}
                        </span>{' '}
                        · {OFFER_WORDS[o.type] ?? o.type} offered
                        {o.via === 'paypal' ? ' through PayPal' : ''}. {o.note}
                      </li>
                    ))}
                    {c.outcome && <li>{c.outcome}</li>}
                  </ul>
                </div>
              )}
            </div>

            <div className="mx-case-act">
              {c.open && (
                <div className="mx-suggest">
                  <p className="mx-suggest-tag">Suggestion · never sent automatically</p>
                  <h4 id={`${h}-sg`} className="mx-suggest-h">
                    {c.suggestion.title}
                  </h4>
                  <p>{c.suggestion.why}</p>
                </div>
              )}

              {c.open && (
                <div className="mx-reply" role="group" aria-labelledby={`${h}-reply`}>
                  <h4 id={`${h}-reply`} className="mx-h4">
                    Your reply
                  </h4>
                  <div className="mx-reply-actions">
                    {ACTIONS.map((a) => {
                      const blocked = a.action === 'refund' && refundBlocked;
                      const unavailable = anyBusy || blocked;
                      return (
                        <Fragment key={a.action}>
                          <button
                            ref={(el) => {
                              triggerRefs.current[a.action] = el;
                            }}
                            type="button"
                            className={
                              a.action === 'refund' && !blocked ? 'btn btn-primary mx-btn' : 'btn mx-btn'
                            }
                            aria-describedby={blocked ? `${h}-norefund` : `${h}-tab`}
                            aria-expanded={pending === a.action}
                            aria-disabled={unavailable || undefined}
                            onClick={() => {
                              if (!unavailable) setPending(a.action);
                            }}
                          >
                            {a.label}
                            {suggested === a.action && (
                              <span className="mx-suggested-tag">
                                <span className="sr-only">, </span>Suggested
                              </span>
                            )}
                          </button>
                          {blocked && (
                            <p id={`${h}-norefund`} className="mx-demo-note">
                              This order has no PayPal payment to refund.
                            </p>
                          )}
                        </Fragment>
                      );
                    })}
                  </div>

                  {confirm && pending && (
                    <div className="mx-confirm" role="group" aria-labelledby={`${h}-confirm`}>
                      <h5 id={`${h}-confirm`} ref={confirmRef} tabIndex={-1} className="mx-confirm-h">
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
                            await onRespond(pending);
                            setPending(null);
                          }}
                        >
                          {busy ? 'Sending…' : confirm.yes}
                        </button>
                        <button
                          type="button"
                          className="btn mx-btn"
                          aria-disabled={busy || undefined}
                          onClick={() => {
                            if (!busy) cancel();
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {result && (
                <p ref={resultRef} tabIndex={-1} className="mx-result" data-ok={String(result.ok)}>
                  <span className="mx-glyph" aria-hidden="true">
                    {result.ok ? '✓' : '✕'}
                  </span>
                  <span>{result.message}</span>
                </p>
              )}
            </div>
          </div>
        </div>
      </article>
    </li>
  );
}
