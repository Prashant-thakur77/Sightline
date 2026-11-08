'use client';

import { useState } from 'react';
import { useAnnouncer } from '@/components/a11y/announcer';

/** Starts a demo session as Maya with the Speech Viewer switched on. */
export function JudgeStart() {
  const { announce } = useAnnouncer();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      localStorage.setItem('sl-speech-viewer', '1');
    } catch {
      /* ignore */
    }
    try {
      const res = await fetch('/api/demo/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ persona: 'maya' }) });
      if (!res.ok) throw new Error();
      window.location.href = '/app';
    } catch {
      setBusy(false);
      const msg = 'The demo could not start. Nothing changed. Try again.';
      setError(msg);
      announce(msg, { politeness: 'assertive', source: 'judge' });
    }
  };
  return (
    <>
      <button type="button" className="btn btn-primary btn-xl" onClick={go} aria-disabled={busy || undefined}>
        {busy ? 'Starting…' : 'Shop as Maya, Speech Viewer on'}
      </button>
      {error && <p className="card-refusal">{error}</p>}
    </>
  );
}
