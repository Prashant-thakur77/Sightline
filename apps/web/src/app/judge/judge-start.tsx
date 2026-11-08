'use client';

import { useState } from 'react';

/** Starts a demo session as Maya with the Speech Viewer switched on. */
export function JudgeStart() {
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      localStorage.setItem('sl-speech-viewer', '1');
    } catch {
      /* ignore */
    }
    const res = await fetch('/api/demo/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ persona: 'maya' }) });
    if (res.ok) window.location.href = '/app';
    else setBusy(false);
  };
  return (
    <button type="button" className="btn btn-primary btn-xl" onClick={go} disabled={busy}>
      {busy ? 'Starting…' : 'Shop as Maya, Speech Viewer on'}
    </button>
  );
}
