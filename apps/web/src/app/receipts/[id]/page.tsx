import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Wordmark } from '@/components/shell/mark';
import { loadReceipt } from '@/server/receipts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Receipt check' };

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

export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await loadReceipt(id);
  if (!data) notFound();
  const { receipt, check } = data;
  const body = receipt.body as {
    allowed?: boolean;
    decidedAt?: string;
    requestId?: string;
    firstFailure?: string | null;
    input?: { amount?: { cents: number; currency: string }; payee?: string; intent?: string; confirmation?: { utterance: string; phraseMatched: boolean; classifierAgreed: boolean } | null };
    results?: { guard: string; ok: boolean; code: string; message: string }[];
  };
  const allOk = check.hashMatches && check.hmacValid && check.ed25519Valid !== false;
  const amount = body.input?.amount ? new Intl.NumberFormat('en-US', { style: 'currency', currency: body.input.amount.currency }).format(body.input.amount.cents / 100) : null;

  return (
    <main id="main" tabIndex={-1} className="w-full max-w-[920px] mx-auto px-[clamp(1rem,3vw,2.5rem)] py-[var(--space-7)] grid gap-8">
      <Link href="/" className="no-underline">
        <Wordmark size={24} />
      </Link>
      <header className="grid gap-3">
        <p className="eyebrow">Receipt {receipt.id}</p>
        <h1 className="text-[length:var(--step-4)] max-w-[20ch]">
          {receipt.kind === 'gate'
            ? body.allowed
              ? `Payment check passed${amount ? ` for ${amount}` : ''}`
              : `Payment refused${amount ? ` for ${amount}` : ''}`
            : 'Receipt'}
        </h1>
        <p className="text-[length:var(--step-1)]">
          {allOk
            ? 'Checked again just now: this receipt has not been changed since it was written.'
            : 'Checked again just now: something does not match. Do not trust this receipt.'}
        </p>
      </header>

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

      {body.input?.confirmation && (
        <section aria-labelledby="conf-h" className="grid gap-2">
          <h2 id="conf-h" className="text-[length:var(--step-2)]">
            The confirmation
          </h2>
          <p>
            Heard: “{body.input.confirmation.utterance}”. Phrase check {body.input.confirmation.phraseMatched ? 'passed' : 'did not pass'}. Second check{' '}
            {body.input.confirmation.classifierAgreed ? 'agreed' : 'did not agree'}.
          </p>
        </section>
      )}

      <section aria-labelledby="verify-h" className="grid gap-3">
        <h2 id="verify-h" className="text-[length:var(--step-2)]">
          Check it yourself
        </h2>
        <p>
          Download the receipt and the public key, then run the verifier from the repository. It needs no access to our server.
        </p>
        <pre className="code">{`node scripts/verify-receipt.mjs receipt-${receipt.id}.json ${check.publicKey.slice(0, 16)}…`}</pre>
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
  );
}
