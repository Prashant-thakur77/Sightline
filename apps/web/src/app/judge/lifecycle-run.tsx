'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import { useAnnouncer } from '@/components/a11y/announcer';

interface StepEvent {
  step: number;
  title: string;
  status: 'running' | 'done' | 'failed' | 'skipped';
  spoken?: string;
  detail?: string;
  link?: string;
}

const MARK: Record<StepEvent['status'], string> = { running: '…', done: '✓', failed: '✕', skipped: '–' };
const WORD: Record<StepEvent['status'], string> = { running: 'In progress', done: 'Done', failed: 'Stopped', skipped: 'Skipped' };

/** Runs the whole lifecycle against the sandbox and shows each step with what was spoken. */
export function LifecycleRun({ ready, missing }: { ready: boolean; missing: string[] }) {
  const { announce } = useAnnouncer();
  const [steps, setSteps] = useState<StepEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLOListElement>(null);

  const fail = (msg: string) => {
    setError(msg);
    announce(msg, { politeness: 'assertive', source: 'judge run' });
  };

  const run = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setSteps([]);
    announce('Running the whole lifecycle against the PayPal sandbox. Each step will be read out.', { source: 'judge run' });
    let res: Response;
    try {
      res = await fetch('/api/judge/run', { method: 'POST' });
    } catch {
      fail('The server could not be reached. Nothing ran.');
      setBusy(false);
      return;
    }
    if (!res.ok || !res.body) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      fail(j.error ?? 'The run could not start.');
      setBusy(false);
      return;
    }
    try {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop() ?? '';
      for (const p of parts) {
        const json = p.replace(/^data: /, '');
        const ev = JSON.parse(json) as StepEvent & { end?: boolean };
        if (ev.end) continue;
        setSteps((prev) => {
          const others = prev.filter((s) => s.step !== ev.step);
          return [...others, ev].sort((a, b) => a.step - b.step);
        });
        if (ev.status !== 'running' || ev.spoken) announce(`${ev.title}. ${WORD[ev.status]}. ${ev.spoken ?? ev.detail ?? ''}`, { source: 'judge run' });
      }
    }
    } catch {
      fail('The connection dropped during the run. The steps listed so far show how far it got.');
    }
    setBusy(false);
  };

  return (
    <div className="grid gap-4">
      {ready ? (
        <button type="button" className="btn btn-primary btn-xl" onClick={run} aria-disabled={busy || undefined}>
          {busy ? 'Running…' : 'Run the whole lifecycle (about 90 seconds)'}
        </button>
      ) : (
        <p className="card-refusal">This server is missing {missing.join(' and ')}, so the run is switched off rather than faked.</p>
      )}
      {error && <p className="card-refusal">{error}</p>}
      {steps.length > 0 && (
        <ol ref={listRef} className="run-steps" aria-label="Lifecycle run steps">
          {steps.map((s) => (
            <li key={s.step} data-status={s.status}>
              <span className="run-mark" aria-hidden="true">
                {MARK[s.status]}
              </span>
              <div>
                <p className="run-title">
                  {s.title} <span className="sr-only">: {WORD[s.status]}</span>
                </p>
                {s.spoken && <p className="run-spoken">“{s.spoken}”</p>}
                {s.detail && <p className="muted">{s.detail}</p>}
                {s.link && <Link href={s.link}>Open the proof</Link>}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
