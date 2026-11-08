'use client';

import { useMemo } from 'react';
import { BARRIER_TITLE, barrierReport, barrierSources } from './barrier-report';
import { claudeHarness } from './claude-harness';
import { StudioFrame } from './studio-frame';
import type { BarrierData, StudioAgentStatus } from './types';

const STARTERS = [
  { label: 'Worst rule', prompt: 'Which accessibility rule fails on the most stores, and what does it mean for a screen reader user?' },
  { label: 'Keyboard reach', prompt: 'On how many stores could a keyboard reach add to cart, and what stopped the others?' },
  { label: 'By platform', prompt: 'Which platform has the most failures per product page?' },
  { label: 'Add a chart', prompt: 'Add a chart of serious or critical failures per store.' },
];

export function BarrierStudio({ data, licenseKey, agent }: { data: BarrierData; licenseKey?: string; agent: StudioAgentStatus }) {
  const sources = useMemo(() => barrierSources(data), [data]);
  const harness = useMemo(
    () =>
      agent.enabled
        ? claudeHarness({
            dashboard: 'barrier-index',
            focus:
              'the Checkout Barrier Index: automated accessibility failures and keyboard reach on real online stores, by platform. Stores are hashes and are never named.',
            promptStarters: STARTERS,
          })
        : undefined,
    [agent.enabled],
  );
  return (
    <StudioFrame
      id="bi"
      title={BARRIER_TITLE}
      data={sources}
      report={barrierReport}
      licenseKey={licenseKey}
      agent={agent}
      harness={harness}
    />
  );
}
