'use client';

import { useEffect, useRef, useState } from 'react';
import { useAnnouncer } from '@/components/a11y/announcer';

const OFFLINE = 'Could not reach the server. Nothing changed. Try again.';

/** The phone's share sheet when there is one; otherwise the link is copied. */
function canShare(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function';
}

export function AskHelper({ orderId, helperName }: { orderId: string; helperName: string }) {
  const { announce } = useAnnouncer();
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [share, setShare] = useState(false);
  /** What happened to the link last, shown under the button. */
  const [status, setStatus] = useState<string | null>(null);
  const askRef = useRef<HTMLButtonElement>(null);
  const sendRef = useRef<HTMLButtonElement>(null);
  const sending = useRef(false);
  // The control that had focus is replaced when the link appears or goes: focus its replacement.
  const moveFocus = useRef(false);

  useEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    (link ? sendRef.current : askRef.current)?.focus();
  }, [link]);

  const fail = (msg: string) => {
    setError(msg);
    announce(msg, { politeness: 'assertive', source: 'helper' });
  };

  const ask = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/orders/${orderId}/helper`, { method: 'POST' });
      const data = (await res.json().catch(() => ({}))) as { link?: string; error?: string };
      if (!res.ok || !data.link) {
        fail(data.error ?? 'Something went wrong. No link was made. Try again.');
        return;
      }
      moveFocus.current = true;
      setShare(canShare());
      setStatus(null);
      setLink(data.link);
      announce(`I made a private link for ${helperName}. It shows only the photos and the listing, and lasts 48 hours.`, { source: 'helper' });
    } catch {
      fail(OFFLINE);
    } finally {
      setBusy(false);
    }
  };

  const done = (msg: string) => {
    setStatus(msg);
    announce(msg, { source: 'helper' });
  };

  const copy = async (url: string) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('no clipboard');
      await navigator.clipboard.writeText(url);
      done(`Link copied. Paste it into a message to ${helperName}.`);
    } catch {
      fail(`I couldn’t copy the link. Go to the field named Link for ${helperName}, select the link and copy it from there.`);
    }
  };

  const send = async () => {
    if (!link || sending.current) return;
    sending.current = true;
    setError(null);
    setStatus(null);
    try {
      if (share) {
        try {
          await navigator.share({
            title: 'Parcel photos',
            text: `Can you look at my parcel photos and tell me if they match what I ordered? This private link works for 48 hours.`,
            url: link,
          });
          done(`Link shared. When ${helperName} answers, you’ll see it on this order.`);
        } catch (e) {
          if ((e as { name?: string } | null)?.name === 'AbortError') {
            done(`Not shared. The link still works. You can share it again, or copy it from the field named Link for ${helperName}.`);
          } else {
            // The share sheet can't be used here: copy instead.
            await copy(link);
          }
        }
      } else {
        await copy(link);
      }
    } finally {
      sending.current = false;
      // A share sheet can take focus away; bring it back to the button.
      sendRef.current?.focus();
    }
  };

  const cancel = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/orders/${orderId}/helper/revoke`, { method: 'POST' });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        fail(data.error ?? `The link for ${helperName} still works. Try again.`);
        return;
      }
      moveFocus.current = true;
      setStatus(null);
      setLink(null);
      announce(`The link for ${helperName} is cancelled. It no longer opens.`, { source: 'helper' });
    } catch {
      fail(OFFLINE);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div id="helper" className="grid gap-3">
      {error && <p className="card-refusal">{error}</p>}
      {!link ? (
        <button ref={askRef} type="button" className="btn btn-xl" onClick={ask} aria-disabled={busy || undefined} data-focus-target="">
          {busy ? 'Making a link…' : `Ask ${helperName} to look`}
        </button>
      ) : (
        <div className="grid gap-2">
          <p>
            Send this private link to {helperName}. It shows only the photos and the listing, never payment details, and expires in 48 hours.
          </p>
          <button ref={sendRef} type="button" className="btn btn-primary btn-xl" onClick={send}>
            {share ? 'Share the link' : 'Copy the link'}
          </button>
          {status && <p className="helper-status">{status}</p>}
          <label htmlFor="helper-link" className="font-bold">
            Link for {helperName}
          </label>
          <input id="helper-link" type="text" readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
          <button type="button" className="btn" onClick={cancel} aria-disabled={busy || undefined}>
            {busy ? 'Cancelling…' : 'Cancel this link'}
          </button>
        </div>
      )}
    </div>
  );
}
