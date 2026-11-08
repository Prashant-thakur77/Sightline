'use client';

import { useState } from 'react';
import { useAnnouncer } from '@/components/a11y/announcer';

export function AskHelper({ orderId, helperName }: { orderId: string; helperName: string }) {
  const { announce } = useAnnouncer();
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ask = async () => {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/orders/${orderId}/helper`, { method: 'POST' });
    const data = (await res.json()) as { link?: string; error?: string };
    setBusy(false);
    if (!res.ok || !data.link) {
      setError(data.error ?? 'Something went wrong.');
      return;
    }
    setLink(data.link);
    announce(`I made a private link for ${helperName}. It shows only the photos and the listing, and lasts 48 hours.`, { source: 'helper' });
  };
  return (
    <div id="helper" className="grid gap-3">
      {error && (
        <p role="alert" className="card-refusal">
          {error}
        </p>
      )}
      {!link ? (
        <button type="button" className="btn btn-xl" onClick={ask} disabled={busy}>
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
          <input id="helper-link" type="text" readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
        </div>
      )}
    </div>
  );
}
