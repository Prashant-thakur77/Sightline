import { orderTimeline, type TimelineStep } from '@/server/timeline';
import { AgentTimelineList } from './agent-timeline-list';

/**
 * "What your agent did": every step of one order, from the shopping conversation to PayPal's last
 * word, with who did it, the tool used and who decided. Self-contained: give it the order and its
 * owner and it reads the audit log itself.
 */
export async function AgentTimeline({ orderId, userId }: { orderId: string; userId: string }) {
  const steps = await orderTimeline(orderId, userId);
  return <AgentTimelineView steps={steps} headingId="agent-timeline-h" heading="What your agent did" />;
}

/** The same timeline from steps already read, for pages that pick the order themselves. */
export function AgentTimelineView({
  steps,
  heading,
  headingId,
  headingClassName = 'text-[length:var(--step-2)]',
  intro,
}: {
  steps: TimelineStep[];
  heading: string;
  headingId: string;
  headingClassName?: string;
  intro?: React.ReactNode;
}) {
  return (
    <section aria-labelledby={headingId} className="agent-timeline-section grid gap-3">
      <h2 id={headingId} className={headingClassName}>
        {heading}
      </h2>
      {intro}
      {steps.length ? (
        <AgentTimelineList steps={steps} labelledBy={headingId} />
      ) : (
        <p>Nothing recorded for this order yet.</p>
      )}
      <p className="muted">
        Every step comes from the order’s audit log, where each line is chained to the one before it with a hash. PayPal ids and statuses are
        PayPal’s own, as PayPal answered or as a verified PayPal webhook said.
      </p>
    </section>
  );
}
