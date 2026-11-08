'use client';

import { useMemo } from 'react';
import { claudeHarness } from './claude-harness';
import { StudioFrame } from './studio-frame';
import type { StudioAgentStatus, VerifiedDeliveryData } from './types';
import { VERIFIED_DELIVERY_TITLE, verifiedDeliveryReport, verifiedDeliverySources } from './verified-delivery-report';

const STARTERS = [
  { label: 'Money on hold', prompt: 'How much money is on hold right now, and for which orders?' },
  { label: 'Returns for colour', prompt: 'Which items get returned for colour?' },
  { label: 'Cases avoided', prompt: 'How many disputes did pay after check avoid, and how much money did that keep off the card?' },
  { label: 'Add a chart', prompt: 'Add a chart of checks by buyer, split by verdict.' },
];

export function VerifiedDeliveryStudio({
  data,
  licenseKey,
  agent,
}: {
  data: VerifiedDeliveryData;
  licenseKey?: string;
  agent: StudioAgentStatus;
}) {
  const sources = useMemo(() => verifiedDeliverySources(data), [data]);
  const harness = useMemo(
    () =>
      agent.enabled
        ? claudeHarness({
            dashboard: 'verified-delivery',
            focus:
              "Demo Store's verified-delivery analytics: orders, camera checks of delivered parcels, money held, captured, voided and refunded, and the cases buyers opened.",
            promptStarters: STARTERS,
          })
        : undefined,
    [agent.enabled],
  );
  return (
    <StudioFrame
      id="vd"
      title={VERIFIED_DELIVERY_TITLE}
      data={sources}
      report={verifiedDeliveryReport}
      licenseKey={licenseKey}
      agent={agent}
      harness={harness}
    />
  );
}
