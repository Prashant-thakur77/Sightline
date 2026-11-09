import Link from 'next/link';
import { describePolicy } from '@sightline/agent';
import { currentUser } from '@/server/session';
import { loadStorePolicy } from '@/server/store-policy';
import { INTEGRATIONS } from '@/server/runtime';
import { PolicyForm } from './policy-form';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Store agent' };

export default async function StoreAgentPage() {
  const user = await currentUser();
  const policy = await loadStorePolicy(user?.id ?? '__none__');
  return (
    <div className="mx-page">
      <header className="mx-page-head">
        <p className="eyebrow">Demo Store · Store agent</p>
        <h1 className="mx-h1">Store agent</h1>
        <p className="mx-lede">
          When a buyer’s money-back case reaches Demo Store, the store agent reads the signed evidence, the order and this policy, and proposes a
          reply: a replacement, the money back, part of the price back, or the item back first. Inside the policy it sends the reply at once;
          otherwise the reply waits on the <Link href="/merchant/disputes">cases desk</Link> for you to send, change or dismiss.
        </p>
        <p className="mx-hint">Now: {describePolicy(policy)}</p>
      </header>

      {!INTEGRATIONS.anthropic && (
        <div className="mx-notice">
          <p className="mx-notice-h">
            <span className="mx-glyph" aria-hidden="true">
              !
            </span>
            Claude is not connected on this server
          </p>
          <p>The store agent still works: your store rules pick the reply, and each proposal says so.</p>
        </div>
      )}

      <section aria-labelledby="never-h" className="mx-block">
        <h2 id="never-h" className="mx-h2">
          What the store agent can never do
        </h2>
        <ul className="mx-history">
          <li>Choose an amount. Code works out every amount from the order, to the cent, and checks it again when the reply is sent.</li>
          <li>Send a reply this policy does not allow, or give back more than the buyer paid.</li>
          <li>Say something the evidence does not. Each reason must cite the case’s facts, and code drops any reason with an amount, size, colour or date the facts don’t hold.</li>
          <li>Accept for the buyer. The buyer hears every offer with its reasons, and accepting takes two presses.</li>
          <li>Keep going forever. After one revised offer, the case comes to you.</li>
        </ul>
      </section>

      <PolicyForm
        initial={{
          agentOn: policy.agentOn,
          autoSend: policy.autoSend,
          autoReplaceMax: policy.autoReplaceMaxCents / 100,
          askStaffAbove: policy.askStaffAboveCents / 100,
          partialRefunds: policy.partialRefunds,
        }}
      />
    </div>
  );
}
