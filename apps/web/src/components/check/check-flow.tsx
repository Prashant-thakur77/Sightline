'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { Verdict } from '@sightline/core';
import { useAnnouncer } from '@/components/a11y/announcer';
import { cue } from '@/lib/feedback';
import { CameraCheck, type CapturedShot, type ShotKind } from './camera-check';
import { VerdictView } from './verdict-view';

interface Next {
  kind: 'captured' | 'match' | 'money-back' | 'unsure' | 'capture-failed';
  say: string;
  payAfterCheck?: boolean;
  helperName?: string;
}

export function CheckFlow({
  orderId,
  itemName,
  ordered,
  demoShots,
  initial,
}: {
  orderId: string;
  itemName: string;
  ordered: { title: string; imageUrl?: string; colour?: string; size?: string };
  demoShots?: { kind: ShotKind; url: string }[];
  initial?: { verdict: Verdict; itemPhoto?: string } | null;
}) {
  const { announce } = useAnnouncer();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ verdict: Verdict; next?: Next; itemPhoto?: string } | null>(initial ?? null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (shots: CapturedShot[]) => {
    setBusy(true);
    setError(null);
    announce('Checking. This takes a few seconds.', { source: 'check' });
    cue('thinking');
    const form = new FormData();
    for (const s of shots) form.append(s.kind, s.blob, `${s.kind}.jpg`);
    try {
      const res = await fetch(`/api/orders/${orderId}/check`, { method: 'POST', body: form });
      const data = (await res.json()) as { verdict?: Verdict; next?: Next; itemPhoto?: string; error?: string };
      if (!res.ok || !data.verdict) throw new Error(data.error ?? 'The check did not finish.');
      setResult({ verdict: data.verdict, next: data.next, itemPhoto: data.itemPhoto });
      cue(data.verdict.kind === 'match' ? 'done' : 'attention');
      announce(data.next?.say ?? data.verdict.headline, { politeness: 'assertive', source: 'check' });
    } catch (e) {
      const msg = (e as Error).message;
      setError(msg);
      cue('error');
      announce(msg, { politeness: 'assertive', source: 'check' });
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    const v = result.verdict;
    return (
      <VerdictView
        verdict={v}
        ordered={ordered}
        arrivedPhotoUrl={result.itemPhoto}
        actions={
          v.kind === 'mismatch' ? (
            <>
              <Link className="btn btn-primary btn-xl" href={`/app/orders/${orderId}#money-back`}>
                Get my money back
              </Link>
              <button type="button" className="btn btn-xl" onClick={() => setResult(null)}>
                Check again
              </button>
            </>
          ) : v.kind === 'unsure' ? (
            <>
              <Link className="btn btn-primary btn-xl" href={`/app/orders/${orderId}#helper`}>
                {result.next?.helperName ? `Ask ${result.next.helperName} to look` : 'Ask someone I trust'}
              </Link>
              <button type="button" className="btn btn-xl" onClick={() => setResult(null)}>
                Try again in better light
              </button>
            </>
          ) : (
            <Link className="btn btn-primary btn-xl" href={`/app/orders/${orderId}`}>
              See the order
            </Link>
          )
        }
      />
    );
  }

  return (
    <div className="grid gap-6">
      {error && (
        <p className="card-refusal" role="alert">
          {error}
        </p>
      )}
      <CameraCheck itemName={itemName} onSubmit={submit} demoShots={demoShots} busy={busy} />
    </div>
  );
}
