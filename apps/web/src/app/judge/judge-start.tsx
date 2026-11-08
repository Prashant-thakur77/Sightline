'use client';

import { useState } from 'react';

/** Starts a demo session as Maya with the Speech Viewer switched on. */
export function JudgeStart() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
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
      setError('The demo could not start. Please try again.');
    }
  };
  return (
    <>
      <button type="button" className="btn btn-primary btn-xl" onClick={go} disabled={busy}>
        {busy ? 'Starting…' : 'Shop as Maya, Speech Viewer on'}
      </button>
      {error && (
        <p role="alert" className="card-refusal">
          {error}
        </p>
      )}
    </>
  );
}
