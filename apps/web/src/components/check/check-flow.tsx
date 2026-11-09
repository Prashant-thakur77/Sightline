'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
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
  helperAnswer = null,
  caseStage = null,
}: {
  orderId: string;
  itemName: string;
  ordered: { title: string; imageUrl?: string; colour?: string; size?: string };
  demoShots?: { kind: ShotKind; url: string }[];
  initial?: { verdict: Verdict; itemPhoto?: string; itemPhotoSource?: PhotoSource } | null;
  /** The buyer's trusted helper, if they have one; the "ask" action is shown only then. */
  helperName?: string | null;
  /** What the helper said about the check already on the page, as a sentence. */
  helperAnswer?: string | null;
  /** The money-back case's stage once it was sent, so it is pointed to instead of started again. */
  caseStage?: string | null;
}) {
  const { announce } = useAnnouncer();
  const router = useRouter();
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
      // Focus moves to the headline, which the screen reader reads; the live region adds only what
      // the headline doesn't say, after it. The app's own voice, if on, says all of it.
      const said = data.next?.say ?? data.verdict.headline;
      const rest = said.startsWith(data.verdict.headline) ? said.slice(data.verdict.headline.length).trim() : said;
      announce(said, { source: 'check', live: false });
      if (rest) announce(rest, { source: 'check', speak: false });
      // The page around the verdict (where the order stands) catches up; this verdict stays.
      router.refresh();
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
    const helper = result.next?.helperName ?? helperName;
    // The helper's answer is about the check that was on the page, not a new one.
    const answered = result.fresh ? null : helperAnswer;
    // A closed case: nothing left to do here but read how it ended.
    const closed = caseStage === 'resolved';
    const caseLink = caseStage ? (
      <Link className="btn btn-primary btn-xl" href={`/app/orders/${orderId}#money-back`}>
        {caseStage === 'resolved' ? 'See how your case ended' : 'See your money-back case'}
      </Link>
    ) : null;
    return (
      <VerdictView
        focusOnMount={Boolean(result.fresh)}
        verdict={v}
        ordered={ordered}
        arrivedPhotoUrl={result.itemPhoto}
        arrivedPhotoSource={result.itemPhotoSource}
        helperName={helper ?? null}
        settled={Boolean(answered || caseStage)}
        closed={closed}
        note={answered ? <p className="mb-result">{answered}</p> : null}
        actions={
          closed ? (
            caseLink
          ) : v.kind === 'mismatch' ? (
            <>
              {caseLink ?? (
                <Link className="btn btn-primary btn-xl" href={`/app/orders/${orderId}#money-back`}>
                  Get my money back
                </Link>
              )}
              <button type="button" className="btn btn-xl" onClick={again}>
                Check again
              </button>
            </>
          ) : v.kind === 'unsure' ? (
            <>
              {caseLink}
              {helper && !answered && !caseLink && (
                <Link className="btn btn-primary btn-xl" href={`/app/orders/${orderId}#checked`}>
                  Ask {helper} to look
                </Link>
              )}
              {!caseLink && (
                <Link className={helper && !answered ? 'btn btn-xl' : 'btn btn-primary btn-xl'} href={`/app/orders/${orderId}#money-back`}>
                  Get my money back
                </Link>
              )}
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
      <CameraCheck itemName={itemName} onSubmit={submit} demoShots={demoShots} busy={busy} focusOnMount={cameBack} onRetake={() => setError(null)} />
    </div>
  );
}
