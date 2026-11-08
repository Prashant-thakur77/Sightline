import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { SiteFooter, SiteHeader } from '@/components/shell/site-chrome';
import { utcWhen } from '@/lib/when';
import { loadReceipt, receiptContext, type ConfirmationKey, type ReceiptOrder } from '@/server/receipts';
import { demoSeller, INTEGRATIONS } from '@/server/runtime';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  // A missing receipt gets the not-found page, so it must not keep this page's title.
  return { title: (await loadReceipt(id)) ? 'Receipt check' : 'Receipt not found' };
}

const GUARD_LABEL: Record<string, string> = {
  EnvGuard: 'Sandbox only',
  ReadbackBindingGuard: 'You heard and confirmed this exact cart',
  CatalogPriceGuard: 'Price matches the listing',
  PayeeGuard: 'Money goes to the right store',
  BudgetGuard: 'Within your spending limits',
  DuplicateGuard: 'Not a repeat of a recent order',
  RateLimitGuard: 'Not too many orders this hour',
  FreshnessGuard: 'Listing checked recently',
};

interface GateBody {
  allowed?: boolean;
  decidedAt?: string;
  requestId?: string;
  firstFailure?: string | null;
  input?: {
    readbackId?: string | null;
    amount?: { cents: number; currency: string };
    payee?: string;
    intent?: string;
    confirmation?: { utterance: string; phraseMatched: boolean; classifierAgreed: boolean } | null;
  };
  results?: { guard: string; ok: boolean; code: string; message: string }[];
}

function Check({ ok, label, detail }: { ok: boolean | null; label: string; detail: string }) {
  const word = ok === null ? 'Not available' : ok ? 'Verified' : 'Failed';
  return (
    <li className="rcheck" data-ok={ok === null ? 'na' : String(ok)}>
      <span className="rcheck-mark" aria-hidden="true">
        {ok === null ? '–' : ok ? '✓' : '✕'}
      </span>
      <span>
        <strong>
          {label}: {word}.
        </strong>{' '}
        {detail}
      </span>
    </li>
  );
}

const seconds = (ms: number) => {
  const s = Math.max(0, ms) / 1000;
  return s < 10 ? `${s.toFixed(1)} seconds` : `${Math.round(s)} seconds`;
};

/** What the buyer did to confirm, told from the two keys the readback record stores. */
function confirmationSentence(keys: ConfirmationKey[], utterance: string): string | null {
  const [k1, k2] = keys;
  if (!k1 || !k2) return null;
  if (k1.source === 'button' && k2.source === 'second_press')
    return `You pressed Confirm twice, ${seconds(k2.at - k1.at)} apart. A button press has no spoken words for the model check to read, so the second press is the second key.`;
  if (k1.source === 'phrase' && k2.source === 'classifier')
    return `You said “${utterance}”. It matched an allowed confirmation phrase, and the model check also read it as a yes.`;
  if (k1.source === 'button' && k2.source === 'classifier')
    return `You pressed Confirm while saying “${utterance}”, and the model check read it as a yes.`;
  return null;
}

/** Whether PayPal was called and where the money is, said plainly. */
function moneyFacts(allowed: boolean, order: ReceiptOrder | null): { paypal: string; money: string; next: string | null } {
  if (!allowed)
    return {
      paypal: 'Not called. The payment gate refused before any request to PayPal.',
      money: 'Nothing was charged.',
      next: 'This confirmation cannot be used again. To buy the item, confirm a fresh readback of the order. Nothing is paid until you do.',
    };
  if (!order)
    return {
      paypal: `Not called. No order was placed after this check${INTEGRATIONS.paypal ? '' : ', because PayPal is not connected on this server'}.`,
      money: 'Nothing was charged.',
      next: null,
    };
  if (!order.paypalOrder)
    return {
      paypal: order.status === 'confirmed' ? 'Called. PayPal has not answered yet.' : 'Called, but PayPal did not create an order.',
      money: `${order.payment.word}. ${order.payment.detail ?? ''}`.trim(),
      next: null,
    };
  return { paypal: 'Called. PayPal created the order.', money: `${order.payment.word}. ${order.payment.detail ?? ''}`.trim(), next: null };
}

export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await loadReceipt(id);
  if (!data) notFound();
  const { receipt, check } = data;
  const body = receipt.body as GateBody;
  const gate = receipt.kind === 'gate';
  const { keys, order } = gate ? await receiptContext(body) : { keys: [], order: null };
  const allOk = check.hashMatches && check.hmacValid && check.ed25519Valid !== false;
  const amount = body.input?.amount ? new Intl.NumberFormat('en-US', { style: 'currency', currency: body.input.amount.currency }).format(body.input.amount.cents / 100) : null;
  const seller = demoSeller();
  const payee = body.input?.payee;
  const facts = gate ? moneyFacts(body.allowed === true, order) : null;
  const conf = body.input?.confirmation;
  const confSentence = conf ? confirmationSentence(keys, conf.utterance) : null;
  const pressedTwice = keys[0]?.source === 'button' && keys[1]?.source === 'second_press';

  return (
    <>
      <SiteHeader />
      <main id="main" tabIndex={-1} className="w-full max-w-[920px] mx-auto px-[clamp(1rem,3vw,2.5rem)] py-[var(--space-7)] grid gap-8">
        <header className="grid gap-3">
          <p className="eyebrow">Receipt {receipt.id}</p>
          <h1 className="text-[length:var(--step-4)] max-w-[20ch]">
            {gate ? (body.allowed ? `Payment check passed${amount ? ` for ${amount}` : ''}` : `Payment refused${amount ? ` for ${amount}` : ''}`) : 'Receipt'}
          </h1>
          <p className="text-[length:var(--step-1)]">
            {allOk
              ? 'Checked again just now: this receipt has not been changed since it was written.'
              : 'Checked again just now: something does not match. Do not trust this receipt.'}
          </p>
        </header>

        {facts && (
          <section aria-labelledby="what-h" className="grid gap-3">
            <h2 id="what-h" className="text-[length:var(--step-2)]">
              What happened
            </h2>
            <dl className="grid gap-3">
              <div>
                <dt className="font-bold">Decided</dt>
                <dd className="m-0">{utcWhen(body.decidedAt)}</dd>
              </div>
              {amount && (
                <div>
                  <dt className="font-bold">Amount</dt>
                  <dd className="m-0">{amount}</dd>
                </div>
              )}
              {payee && (
                <div>
                  <dt className="font-bold">Payee</dt>
                  <dd className="m-0">
                    {payee === seller.merchantId ? (
                      payee === 'DEMO-STORE-UNCONFIGURED' ? (
                        `${seller.name}. No PayPal merchant ID is set on this server.`
                      ) : (
                        <>
                          {seller.name}, PayPal sandbox merchant ID <span className="mono">{payee}</span>
                        </>
                      )
                    ) : (
                      <>
                        PayPal merchant ID <span className="mono">{payee}</span>
                      </>
                    )}
                  </dd>
                </div>
              )}
              <div>
                <dt className="font-bold">PayPal</dt>
                <dd className="m-0">{facts.paypal}</dd>
              </div>
              <div>
                <dt className="font-bold">Money</dt>
                <dd className="m-0">{facts.money}</dd>
              </div>
              {facts.next && (
                <div>
                  <dt className="font-bold">What happens next</dt>
                  <dd className="m-0">{facts.next}</dd>
                </div>
              )}
            </dl>
          </section>
        )}

        <section aria-labelledby="checks-h" className="grid gap-3">
          <h2 id="checks-h" className="text-[length:var(--step-2)]">
            Checks run on this page load
          </h2>
          <ul className="rchecks">
            <Check ok={check.hashMatches} label="Fingerprint" detail="The SHA-256 hash recomputed from the contents matches the stored hash." />
            <Check ok={check.hmacValid} label="Server seal" detail="The server's secret-key seal over the hash is valid." />
            <Check
              ok={check.ed25519Valid}
              label="Public signature"
              detail={`The Ed25519 signature checks out against the public key with fingerprint ${check.fingerprint}. Anyone can check this offline.`}
            />
          </ul>
        </section>

        {body.results && (
          <section aria-labelledby="guards-h" className="grid gap-3">
            <h2 id="guards-h" className="text-[length:var(--step-2)]">
              What the payment gate checked
            </h2>
            <table className="verdict-table">
              <caption className="sr-only">Each payment rule and its result</caption>
              <thead>
                <tr>
                  <th scope="col">Rule</th>
                  <th scope="col">Result</th>
                  <th scope="col">Why</th>
                </tr>
              </thead>
              <tbody>
                {body.results.map((r, i) => (
                  <tr key={`${r.guard}-${i}`}>
                    <th scope="row">{GUARD_LABEL[r.guard] ?? r.guard}</th>
                    <td>
                      <span className="verdict-mark" data-finding={r.ok ? 'agree' : 'disagree'}>
                        <span aria-hidden="true">{r.ok ? '✓' : '✕'}</span>
                        <span className="sr-only">{r.ok ? 'Passed' : 'Failed'}</span>
                      </span>
                    </td>
                    <td>{r.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {conf && (
          <section aria-labelledby="conf-h" className="grid gap-2">
            <h2 id="conf-h" className="text-[length:var(--step-2)]">
              The confirmation
            </h2>
            {confSentence ? (
              <p>{confSentence}</p>
            ) : (
              <p>
                Recorded words: “{conf.utterance}”. First key {conf.phraseMatched ? 'passed' : 'did not pass'}. Second key{' '}
                {conf.classifierAgreed ? 'passed' : 'did not pass'}.
              </p>
            )}
            {pressedTwice && (
              <p className="muted">
                In the signed receipt this shows as <span className="mono">phraseMatched</span> and <span className="mono">classifierAgreed</span>, both
                true: those fields stand for the first key and the second key.
              </p>
            )}
          </section>
        )}

        <section aria-labelledby="verify-h" className="grid gap-3">
          <h2 id="verify-h" className="text-[length:var(--step-2)]">
            Check it yourself
          </h2>
          <p>
            Download the receipt, save it in the repository&apos;s top folder, and run this command there. It needs no access to our server. The
            last part is this server&apos;s public key, so a receipt signed with any other key fails.
          </p>
          <pre className="code">{`node scripts/verify-receipt.mjs receipt-${receipt.id}.json ${check.publicKey}`}</pre>
          <div className="flex flex-wrap gap-3">
            <a className="btn" href={`/api/receipts/${receipt.id}`} download>
              Download receipt
            </a>
            <a className="btn" href="/.well-known/sightline-keys.json">
              Public key
            </a>
          </div>
          <details>
            <summary className="btn btn-quiet">Show the hash and signatures</summary>
            <dl className="hashes">
              <dt>Hash</dt>
              <dd className="mono">{receipt.hash}</dd>
              <dt>Ed25519 signature</dt>
              <dd className="mono">{receipt.ed25519 ?? 'none'}</dd>
              <dt>Public key</dt>
              <dd className="mono">{check.publicKey}</dd>
              {body.requestId && (
                <>
                  <dt>PayPal-Request-Id</dt>
                  <dd className="mono">{body.requestId}</dd>
                </>
              )}
            </dl>
          </details>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
