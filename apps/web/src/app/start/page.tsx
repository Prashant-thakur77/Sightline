import { PRODUCT_NAME } from '@sightline/core';
import { Wordmark } from '@/components/shell/mark';
import { PERSONAS } from '@/server/personas';
import { startAs } from './actions';
import { MayaArt, RajArt } from '@/components/art/illustrations';

export const metadata = { title: 'Try it' };

export default function Start() {
  return (
    <main id="main" tabIndex={-1} className="min-h-dvh w-full max-w-[980px] mx-auto px-[clamp(1rem,3vw,2.5rem)] py-[var(--space-7)] grid gap-8 content-start">
      <Wordmark size={30} />
      <div className="grid gap-3">
        <h1 className="text-[length:var(--step-4)]">Try {PRODUCT_NAME}</h1>
        <p className="max-w-[var(--measure)] text-[length:var(--step-1)]">
          No sign-up. Pick a demo shopper. Every payment goes to a PayPal sandbox test store, so no real money moves.
        </p>
      </div>
      <ul className="grid gap-5 sm:grid-cols-2 list-none p-0">
        {(['maya', 'raj'] as const).map((key) => {
          const p = PERSONAS[key];
          return (
            <li key={key} className="persona-card">
              <div className="persona-art">{key === 'maya' ? <MayaArt /> : <RajArt />}</div>
              <h2 className="text-[length:var(--step-2)]">{p.displayName}</h2>
              <p>{p.summary}</p>
              <form action={startAs}>
                <input type="hidden" name="persona" value={key} />
                <button type="submit" className="btn btn-primary btn-xl w-full">
                  Shop as {p.displayName}
                </button>
              </form>
            </li>
          );
        })}
      </ul>
    </main>
  );
}
