'use client';

import { useEffect, useRef, useState } from 'react';
import { useAnnouncer } from '@/components/a11y/announcer';

const OFFLINE = 'Could not reach the server. Nothing changed. Try again.';

export function AskHelper({ orderId, helperName }: { orderId: string; helperName: string }) {
  const { announce } = useAnnouncer();
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const askRef = useRef<HTMLButtonElement>(null);
  const linkRef = useRef<HTMLInputElement>(null);
  // The control that had focus is replaced when the link appears or goes: focus its replacement.
  const moveFocus = useRef(false);

  useEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    (link ? linkRef.current : askRef.current)?.focus();
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
      setLink(data.link);
      announce(`I made a private link for ${helperName}. It shows only the photos and the listing, and lasts 48 hours.`, { source: 'helper' });
    } catch {
      fail(OFFLINE);
    } finally {
      setBusy(false);
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
          <label htmlFor="helper-link" className="font-bold">
            Link for {helperName}
          </label>
          <input ref={linkRef} id="helper-link" type="text" readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
          <button type="button" className="btn" onClick={cancel} aria-disabled={busy || undefined}>
            {busy ? 'Cancelling…' : 'Cancel this link'}
          </button>
        </div>
      )}
    </div>
  );
}
