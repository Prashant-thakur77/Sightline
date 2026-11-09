'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { Verdict } from '@sightline/core';
import { useAnnouncer } from '@/components/a11y/announcer';
import { cue } from '@/lib/feedback';
import { CameraCheck, type CapturedShot, type ShotKind } from './camera-check';
import { VerdictView, type PhotoSource } from './verdict-view';

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
  helperName,
}: {
  orderId: string;
  itemName: string;
  ordered: { title: string; imageUrl?: string; colour?: string; size?: string };
  demoShots?: { kind: ShotKind; url: string }[];
  initial?: { verdict: Verdict; itemPhoto?: string; itemPhotoSource?: PhotoSource } | null;
  /** The buyer's trusted helper, if they have one; the "ask" action is shown only then. */
  helperName?: string | null;
}) {
  const { announce } = useAnnouncer();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ verdict: Verdict; next?: Next; itemPhoto?: string; itemPhotoSource?: PhotoSource; fresh?: boolean } | null>(
    initial ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  // Set when the person leaves a verdict to check again, so the camera step takes focus.
  const [cameBack, setCameBack] = useState(false);
  const again = () => {
    setCameBack(true);
    setResult(null);
  };

  const submit = async (shots: CapturedShot[]) => {
    setBusy(true);
    setError(null);
    announce('Checking. This takes a few seconds.', { source: 'check' });
    cue('thinking');
    const form = new FormData();
    for (const s of shots) {
      form.append(s.kind, s.blob, `${s.kind}.jpg`);
      // Recorded with the photo, so demo photos are never shown as the buyer's own.
      form.append(`${s.kind}-source`, s.source);
    }
    try {
      const res = await fetch(`/api/orders/${orderId}/check`, { method: 'POST', body: form });
      const data = (await res.json().catch(() => ({}))) as { verdict?: Verdict; next?: Next; itemPhoto?: string; error?: string };
      if (!res.ok || !data.verdict) throw new Error(data.error ?? 'Something went wrong on my side. Your photos are still here. Try again.');
      const sent = shots.find((s) => s.kind === 'item') ?? shots[0];
      setResult({ verdict: data.verdict, next: data.next, itemPhoto: data.itemPhoto, itemPhotoSource: sent?.source, fresh: true });
      cue(data.verdict.kind === 'match' ? 'done' : 'attention');
      announce(data.next?.say ?? data.verdict.headline, { politeness: 'assertive', source: 'check' });
    } catch (e) {
      // A network failure has no words of its own; a server refusal does.
      const msg = e instanceof TypeError ? 'Could not reach the server. Your photos are still here. Try again.' : (e as Error).message;
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
        focusOnMount={Boolean(result.fresh)}
        verdict={v}
        ordered={ordered}
        arrivedPhotoUrl={result.itemPhoto}
        arrivedPhotoSource={result.itemPhotoSource}
        actions={
          v.kind === 'mismatch' ? (
            <>
              <Link className="btn btn-primary btn-xl" href={`/app/orders/${orderId}#money-back`}>
                Get my money back
              </Link>
              <button type="button" className="btn btn-xl" onClick={again}>
                Check again
              </button>
            </>
          ) : v.kind === 'unsure' ? (
            <>
              {(result.next?.helperName ?? helperName) && (
                <Link className="btn btn-primary btn-xl" href={`/app/orders/${orderId}#checked`}>
                  Ask {result.next?.helperName ?? helperName} to look
                </Link>
              )}
              <Link className={(result.next?.helperName ?? helperName) ? 'btn btn-xl' : 'btn btn-primary btn-xl'} href={`/app/orders/${orderId}#money-back`}>
                Get my money back
              </Link>
              <button type="button" className="btn btn-xl" onClick={again}>
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
        <p className="card-refusal">
          {error}
        </p>
      )}
      <CameraCheck itemName={itemName} onSubmit={submit} demoShots={demoShots} busy={busy} focusOnMount={cameBack} />
    </div>
  );
}
